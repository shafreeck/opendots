import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import {
  DoubaoSpeechProvider, SpeechProviderError, asrFrame, asrResponse,
  type SpeechDuplex, type SpeechProvider,
} from '../vendor/app-speech/speech.ts';
import { wavFromPCM } from '../vendor/app-speech/audio.ts';

// This transport never opens a network connection. All wire events and clocks
// are controlled by the test, including a distinct termination acknowledgment.
class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: Buffer[] = [];
  callbacks: Array<(error?: Error) => void> = [];
  terminations = 0;
  autoClose = true;
  throwSend = false;
  throwTerminate = false;
  sendHook?: (frame: Buffer) => void;
  open() { this.readyState = WebSocket.OPEN; this.emit('open'); }
  send(frame: Buffer, callback?: (error?: Error) => void) {
    if (this.throwSend) throw Error('synthetic-private-key');
    this.sent.push(Buffer.from(frame));
    if (callback) this.callbacks.push(callback);
    this.sendHook?.(frame);
  }
  terminate() {
    this.terminations++;
    if (this.throwTerminate) throw Error('synthetic-private-key');
    this.readyState = WebSocket.CLOSING;
    if (this.autoClose) this.acknowledgeClose();
  }
  acknowledgeClose() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
}

function wireResponse(value: unknown, last = false) {
  const payload = gzipSync(JSON.stringify(value));
  const frame = Buffer.alloc(12 + payload.length);
  frame.set([0x11, last ? 0x93 : 0x91, 0x11, 0]);
  frame.writeInt32BE(last ? -2 : 1, 4);
  frame.writeUInt32BE(payload.length, 8);
  payload.copy(frame, 12);
  return frame;
}
function transcript(text: string, last = false) { return wireResponse({ result: { text } }, last); }
function unpack(frame: Buffer) { return gunzipSync(frame.subarray(12)); }
function fixture() {
  const sockets: Socket[] = [];
  const connections: Array<{ url: string; options: WebSocket.ClientOptions }> = [];
  const results: Array<{ text: string; final: boolean }> = [];
  const errors: string[] = [];
  let fetches = 0;
  const provider = new DoubaoSpeechProvider('synthetic-private-key', async () => {
    fetches++;
    return new Response('{"code":20000000,"data":"AAA="}');
  }, (url, options) => {
    const socket = new Socket();
    sockets.push(socket);
    connections.push({ url, options });
    return socket as unknown as WebSocket;
  });
  const open = (principal = 'principal') => provider.openStream(principal,
    (text, final) => results.push({ text, final }), message => errors.push(message));
  return { provider, sockets, connections, results, errors, open, fetches: () => fetches };
}
const safeError = (error: unknown) => error instanceof SpeechProviderError
  && !error.message.includes('synthetic-private-key');

test('streaming retains the pinned fixed endpoint, header scope and full PCM protocol', async () => {
  const f = fixture();
  const provider: SpeechProvider = f.provider;
  const stream: SpeechDuplex = provider.openStream!('principal',
    (text, final) => f.results.push({ text, final }), message => f.errors.push(message));
  assert.equal(f.connections.length, 1);
  const { url, options } = f.connections[0];
  assert.equal(url, 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async');
  assert.equal(options.followRedirects, false);
  assert.equal(options.handshakeTimeout, 10000);
  assert.equal(options.maxPayload, 1000000);
  const headers = options.headers!;
  assert.deepEqual(Object.keys(headers).sort(), [
    'X-Api-Connect-Id', 'X-Api-Key', 'X-Api-Request-Id', 'X-Api-Resource-Id', 'X-Api-Sequence',
  ]);
  assert.equal(headers['X-Api-Key'], 'synthetic-private-key');
  assert.equal(headers['X-Api-Resource-Id'], 'volc.seedasr.sauc.duration');
  assert.equal(headers['X-Api-Sequence'], '-1');
  assert.notEqual(headers['X-Api-Connect-Id'], headers['X-Api-Request-Id']);
  const socket = f.sockets[0];
  socket.open();
  await stream.ready; // No server ACK has been emitted.
  socket.emit('open');
  assert.equal(socket.sent.length, 1);
  const init = JSON.parse(unpack(socket.sent[0]).toString());
  assert.notEqual(init.user.uid, 'principal');
  assert.deepEqual(init.audio, { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 });
  assert.deepEqual(init.request, {
    model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: true,
    show_utterances: true, enable_nonstream: false, result_type: 'full',
  });
  assert.equal(socket.sent[0].readInt32BE(4), 1);
  const pcm = new Uint8Array(6400).fill(17);
  stream.write(pcm);
  assert.equal(socket.sent[1][1], 0x21);
  assert.equal(socket.sent[1].readInt32BE(4), 2);
  assert.deepEqual(unpack(socket.sent[1]), Buffer.from(pcm));
  socket.emit('message', transcript('正在'));
  socket.emit('message', transcript('正在听写'));
  stream.finish();
  stream.finish();
  assert.equal(socket.sent.length, 3);
  assert.equal(socket.sent[2][1], 0x23);
  assert.equal(socket.sent[2].readInt32BE(4), -3);
  assert.equal(unpack(socket.sent[2]).length, 0);
  assert.throws(() => stream.write(pcm), /连接已停止/);
  socket.emit('message', transcript('', true));
  await stream.closed;
  assert.deepEqual(f.results, [
    { text: '正在', final: false }, { text: '正在听写', final: false }, { text: '正在听写', final: true },
  ]);
  assert.equal(socket.terminations, 1);
  assert.deepEqual(f.errors, []);
  assert.equal(f.fetches(), 0);
});

test('stream frames require actual even PCM bytes of 1 through 6400 bytes and an open socket', async () => {
  const f = fixture(), stream = f.open(), socket = f.sockets[0];
  assert.throws(() => stream.write(new Uint8Array(2)), /连接已停止/);
  assert.throws(() => stream.finish(), /尚未就绪/);
  assert.equal(socket.sent.length, 0);
  socket.open(); await stream.ready;
  for (const invalid of [new Uint8Array(), new Uint8Array(1), new Uint8Array(6402),
    null, { byteLength: 2 }, [0, 0], new Uint16Array(2), new ArrayBuffer(2)]) {
    assert.throws(() => stream.write(invalid as Uint8Array), /帧格式无效/);
  }
  assert.equal(socket.sent.length, 1);
  stream.write(new Uint8Array(2));
  stream.write(new Uint8Array(6400));
  stream.close(); await stream.closed;
});

test('backpressure includes the next encoded frame within the 160000 byte cap', async () => {
  const f = fixture(), stream = f.open(), socket = f.sockets[0];
  socket.open(); await stream.ready;
  const pcm = new Uint8Array(6400);
  const frameBytes = asrFrame(pcm, 2, true).byteLength;
  socket.bufferedAmount = 160000 - frameBytes;
  stream.write(pcm);
  socket.bufferedAmount++;
  assert.throws(() => stream.write(pcm), safeError);
  await stream.closed;
  assert.equal(socket.sent.length, 2);
  assert.match(f.errors[0], /网络传输跟不上/);
  assert.equal(f.errors.length, 1);
});

test('cancelling the opening handshake is idempotent and fences late socket events', async () => {
  const f = fixture(), stream = f.open(), socket = f.sockets[0];
  socket.autoClose = false;
  let closed = false;
  void stream.closed.then(() => { closed = true; });
  stream.close(); stream.close(); stream.finish();
  await assert.rejects(stream.ready, /连接已关闭/);
  await Promise.resolve();
  assert.equal(closed, false);
  socket.open();
  socket.emit('message', transcript('不得交付', true));
  socket.emit('error', Error('synthetic-private-key'));
  assert.equal(socket.sent.length, 0);
  assert.deepEqual(f.results, []);
  assert.deepEqual(f.errors, []);
  assert.equal(socket.terminations, 1);
  assert.throws(() => f.open(), /已有语音请求/);
  socket.acknowledgeClose(); await stream.closed;
  const next = f.open(); next.close(); await next.closed;
});

test('handshake and finish timeouts are deterministic, bounded, and retain partial text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), opening = f.open();
  t.mock.timers.tick(9999);
  assert.deepEqual(f.errors, []);
  t.mock.timers.tick(1);
  await assert.rejects(opening.ready, safeError);
  await opening.closed;
  assert.match(f.errors[0], /连接超时/);
  const stream = f.open(), socket = f.sockets[1];
  socket.open(); await stream.ready;
  socket.emit('message', transcript('保留这句话'));
  stream.finish();
  t.mock.timers.tick(11999);
  assert.equal(f.errors.length, 1);
  t.mock.timers.tick(1);
  await stream.closed;
  assert.equal(f.errors.length, 2);
  assert.match(f.errors[1], /收尾超时/);
  assert.deepEqual(f.results, [{ text: '保留这句话', final: false }]);
  socket.emit('message', transcript('迟到的结果', true));
  assert.equal(f.results.length, 1);
});

test('closed rejects after two seconds without an acknowledgment and keeps the principal reserved', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), stream = f.open(), socket = f.sockets[0];
  socket.autoClose = false; socket.open(); await stream.ready;
  let settled = false;
  void stream.closed.then(() => { settled = true; }, () => { settled = true; });
  stream.close();
  t.mock.timers.tick(1999); await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(stream.closed, /关闭未确认/);
  assert.throws(() => f.open(), /已有语音请求/);
  await assert.rejects(f.provider.synthesize('principal', '文字', new AbortController().signal), /已有语音请求/);
  assert.equal(f.fetches(), 0);
  socket.acknowledgeClose();
  const next = f.open();
  socket.emit('close'); // A stale close cannot unlock the next reservation.
  assert.throws(() => f.open(), /已有语音请求/);
  next.close(); await next.closed;
});

test('stream final results can precede close but exclude concurrent one-shot and stream work until close', async () => {
  const f = fixture(), stream = f.open(), socket = f.sockets[0];
  socket.autoClose = false; socket.open(); await stream.ready;
  socket.emit('message', transcript('完整结果', true));
  assert.deepEqual(f.results, [{ text: '完整结果', final: true }]);
  const signal = new AbortController().signal;
  await assert.rejects(f.provider.transcribe('principal', wavFromPCM(new Uint8Array(2)), signal), /已有语音请求/);
  await assert.rejects(f.provider.synthesize('principal', '文字', signal), /已有语音请求/);
  assert.throws(() => f.open(), /已有语音请求/);
  const other = f.open('other'); other.close(); await other.closed;
  socket.acknowledgeClose(); await stream.closed;
  await f.provider.synthesize('principal', '文字', signal);
  assert.equal(f.fetches(), 1);
});

test('one-shot ASR still settles at the result and shares its transport lifetime reservation with streams', async () => {
  const f = fixture(), signal = new AbortController().signal;
  const oneShot = f.provider.transcribe('principal', wavFromPCM(new Uint8Array(2)), signal);
  const socket = f.sockets[0]; socket.autoClose = false;
  assert.throws(() => f.open(), /已有语音请求/);
  socket.open();
  socket.emit('message', transcript('一次识别', true));
  assert.equal(await oneShot, '一次识别');
  assert.throws(() => f.open(), /已有语音请求/);
  socket.acknowledgeClose();
  const next = f.open(); next.close(); await next.closed;
});

test('a pending one-shot synthesis excludes streams and releases normally after its response', async () => {
  let respond!: (response: Response) => void;
  const socket = new Socket();
  const provider = new DoubaoSpeechProvider('synthetic-private-key', async () =>
    new Promise<Response>(resolve => { respond = resolve; }), () => socket as unknown as WebSocket);
  const first = provider.synthesize('principal', '文字', new AbortController().signal);
  assert.throws(() => provider.openStream('principal', () => {}, () => {}), /已有语音请求/);
  respond(new Response('{"code":20000000,"data":"AAA="}')); await first;
  const stream = provider.openStream('principal', () => {}, () => {});
  stream.close(); await stream.closed;
});

for (const phase of ['open', 'write', 'finish'] as const) {
  test(`synchronous ${phase} send failures are redacted and close exactly once`, async () => {
    const f = fixture(), stream = f.open(), socket = f.sockets[0];
    if (phase === 'open') {
      socket.throwSend = true;
      assert.doesNotThrow(() => socket.open());
      await assert.rejects(stream.ready, safeError);
    } else {
      socket.open(); await stream.ready; socket.throwSend = true;
      assert.throws(() => phase === 'write' ? stream.write(new Uint8Array(2)) : stream.finish(), safeError);
    }
    await stream.closed;
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].includes('synthetic-private-key'), false);
    socket.emit('error', Error('synthetic-private-key'));
    socket.emit('message', transcript('late', true));
    stream.close();
    assert.equal(socket.terminations, 1);
    assert.equal(f.errors.length, 1);
    assert.deepEqual(f.results, []);
  });
}

test('asynchronous send callback errors stop streaming and late callbacks remain inert', async () => {
  const f = fixture(), stream = f.open(), socket = f.sockets[0];
  socket.open(); await stream.ready;
  stream.write(new Uint8Array(2));
  socket.callbacks[1](Error('synthetic-private-key'));
  await stream.closed;
  socket.callbacks[0](Error('synthetic-private-key'));
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].includes('synthetic-private-key'), false);
  assert.throws(() => stream.write(new Uint8Array(2)), /连接已停止/);
});

test('socket constructor failures do not leak their cause or leave the principal reserved', () => {
  let calls = 0;
  const provider = new DoubaoSpeechProvider('synthetic-private-key', fetch, () => {
    calls++; throw Error('synthetic-private-key');
  });
  for (let i = 0; i < 2; i++)
    assert.throws(() => provider.openStream('principal', () => {}, () => {}), safeError);
  assert.equal(calls, 2);
  const unconfigured = new DoubaoSpeechProvider(' ', fetch, () => { throw Error('must not connect'); });
  assert.throws(() => unconfigured.openStream('principal', () => {}, () => {}), /尚未配置/);
});

test('terminate exceptions reject closed safely without falsely releasing the principal', async () => {
  const f = fixture(), stream = f.open(), socket = f.sockets[0];
  socket.throwTerminate = true;
  assert.doesNotThrow(() => stream.close());
  await assert.rejects(stream.ready, safeError);
  await assert.rejects(stream.closed, safeError);
  assert.throws(() => f.open(), /已有语音请求/);
  socket.acknowledgeClose();
  const next = f.open(); next.close(); await next.closed;
});

test('unexpected upgrade status and resume failures are redacted; premature close fails once', async () => {
  const f = fixture(), stream = f.open(), socket = f.sockets[0];
  assert.doesNotThrow(() => socket.emit('unexpected-response', {}, {
    statusCode: 'synthetic-private-key', resume() { throw Error('synthetic-private-key'); },
  }));
  await assert.rejects(stream.ready, safeError); await stream.closed;
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].includes('synthetic-private-key'), false);
  const next = f.open(), nextSocket = f.sockets[1];
  nextSocket.open(); await next.ready;
  nextSocket.acknowledgeClose(); await next.closed;
  assert.match(f.errors[1], /连接提前关闭/);
  assert.equal(nextSocket.terminations, 0);
});

test('ASR shape validation matches the pinned optional text schema and bounds full results', async () => {
  for (const value of [null, [], { result: null }, { result: [] }, { result: { text: 4 } },
    { result: { text: null } }, { result: { text: 'x'.repeat(30001) } }]) {
    assert.throws(() => asrResponse(wireResponse(value)), /格式无效/);
  }
  assert.deepEqual(asrResponse(wireResponse({ metadata: 1 })), { last: false, text: '' });
  assert.deepEqual(asrResponse(wireResponse({ result: { unused: true } })), { last: false, text: '' });
  assert.equal(asrResponse(transcript('x'.repeat(30000))).text.length, 30000);
  const f = fixture(), stream = f.open(), socket = f.sockets[0];
  socket.open(); await stream.ready;
  socket.emit('message', Buffer.from('synthetic-private-key'));
  await stream.closed;
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].includes('synthetic-private-key'), false);
});

test('consumer callback exceptions cannot escape transport dispatch and synchronous final responses do not look like send failures', async () => {
  const f = fixture();
  const stream = f.provider.openStream('principal', () => { throw Error('synthetic-private-key'); },
    () => { throw Error('synthetic-private-key'); });
  const socket = f.sockets[0]; socket.open(); await stream.ready;
  assert.doesNotThrow(() => socket.emit('message', transcript('partial')));
  await stream.closed;
  const next = f.open(), nextSocket = f.sockets[1];
  nextSocket.open(); await next.ready;
  nextSocket.sendHook = frame => {
    if (frame[1] === 0x23) nextSocket.emit('message', transcript('final', true));
  };
  assert.doesNotThrow(() => next.finish());
  await next.closed;
  assert.deepEqual(f.results, [{ text: 'final', final: true }]);
  assert.deepEqual(f.errors, []);
});
