import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';
import type WebSocket from 'ws';
import { DoubaoSpeechProvider, asrFrame, asrResponse } from '../src/voice-provider.ts';
import { readSpeechWav, wavFromPCM } from '../vendor/app-speech/audio.ts';

function response(text: string, last: boolean) {
  const payload = gzipSync(JSON.stringify({ result: { text } })); const b = Buffer.alloc(12 + payload.length);
  b.set([0x11, last ? 0x93 : 0x91, 0x11, 0]); b.writeInt32BE(last ? -2 : 1, 4); b.writeUInt32BE(payload.length, 8); payload.copy(b, 12); return b;
}

test('reused ASR wire framing and bounded response parser preserve exact sequence and Unicode text', () => {
  const frame = asrFrame(Buffer.from('synthetic-pcm'), 2, true, true);
  assert.equal(frame[1], 0x23); assert.equal(frame.readInt32BE(4), -2); assert.equal(gunzipSync(frame.subarray(12)).toString(), 'synthetic-pcm');
  assert.deepEqual(asrResponse(response('合成测试', true)), { text: '合成测试', last: true });
  assert.throws(() => asrResponse(response('text', true).subarray(0, 10)));
  assert.throws(() => asrResponse(response('x'.repeat(30001), true)));
});

test('ASR uses only fixed Doubao Agent Plan headers with injected socket and no URL credential', async () => {
  const sent: Buffer[] = []; let connects = 0; let captured: any;
  class Socket extends EventEmitter {
    send(data: Buffer) { sent.push(data); queueMicrotask(() => this.emit('message', response(data[1] >> 4 === 1 ? '' : '识别文字', data[1] >> 4 === 2))); }
    terminate() { this.emit('close'); }
  }
  const provider = new DoubaoSpeechProvider('synthetic-test-key', async () => { throw Error('ASR must not call fetch'); }, (url, options) => {
    connects++; captured = { url, options }; const socket = new Socket(); queueMicrotask(() => socket.emit('open')); return socket as unknown as WebSocket;
  });
  const result = await provider.transcribe('principal-1', wavFromPCM(new Uint8Array(3200)), new AbortController().signal);
  assert.equal(result, '识别文字'); assert.equal(connects, 1); assert.equal(captured.url, 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async');
  assert.equal(captured.options.headers['X-Api-Key'], 'synthetic-test-key'); assert.equal(captured.options.followRedirects, false); assert.equal(sent.length, 2);
  const init = JSON.parse(gunzipSync(sent[0].subarray(12)).toString()); assert.equal(init.audio.format, 'wav'); assert.equal(init.audio.rate, 16000); assert.notEqual(init.user.uid, 'principal-1');
  assert.deepEqual(gunzipSync(sent[1].subarray(12)), Buffer.from(wavFromPCM(new Uint8Array(3200))));
});

test('TTS parser accepts fragmented provider JSON, bounds output, and never retries error responses', async () => {
  let calls = 0;
  const provider = new DoubaoSpeechProvider('synthetic-test-key', (async (url, init) => {
    calls++; assert.equal(url, 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional'); assert.equal(new Headers(init?.headers).get('X-Api-Key'), 'synthetic-test-key'); assert.equal(init?.redirect, 'error');
    const request = JSON.parse(String(init?.body)); assert.equal(request.req_params.text, '朗读测试'); assert.equal(request.req_params.audio_params.sample_rate, 16000);
    const content = JSON.stringify({ code: 0, data: Buffer.alloc(3200).toString('base64'), ignored: '{quoted}' }) + '\n{"code":20000000,"data":null}\n';
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(content.slice(0, 16))); controller.enqueue(Buffer.from(content.slice(16))); controller.close(); } }));
  }) as typeof fetch);
  assert.equal(readSpeechWav(await provider.synthesize('principal', '朗读测试', new AbortController().signal)).length, 3200); assert.equal(calls, 1);
  const denied = new DoubaoSpeechProvider('synthetic-test-key', async () => { calls++; return new Response('synthetic-test-key',{status:401}); });
  await assert.rejects(denied.synthesize('principal', 'text', new AbortController().signal), (e: any) => !e.message.includes('synthetic-test-key')); assert.equal(calls, 2);
  const unfinished = new DoubaoSpeechProvider('synthetic-test-key', async () => new Response(JSON.stringify({ code: 0, data: Buffer.alloc(2).toString('base64') })));
  await assert.rejects(unfinished.synthesize('principal', 'text', new AbortController().signal), /响应中断/);
});

test('provider serialization and abort fence prevent concurrent or cancelled transmissions', async () => {
  let resolve!: (value: Response) => void; let calls = 0;
  const provider = new DoubaoSpeechProvider('synthetic-test-key', async () => { calls++; return new Promise<Response>(r => { resolve = r; }); });
  const first = provider.synthesize('principal', 'first', new AbortController().signal);
  await assert.rejects(provider.synthesize('principal', 'second', new AbortController().signal), /已有语音请求/);
  resolve(new Response('{"code":20000000,"data":"AAA="}')); await first; assert.equal(calls, 1);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(provider.synthesize('principal', 'cancelled', aborted.signal)); assert.equal(calls, 1);
});
