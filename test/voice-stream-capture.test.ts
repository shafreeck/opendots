import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createVoiceStreamCapture } from '../public/voice-stream-capture.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

function fixture(overrides: Record<string, any> = {}) {
  let milliseconds = 0, nextTimer = 0, micCalls = 0, closed = 0, stops = 0, portCloses = 0, disconnects = 0;
  let worklet: any, context: any, constraints: any;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const frames: Uint8Array[] = [], signals: AbortSignal[] = [], errors: Error[] = [], states: string[] = [];
  const tracks = Array.from({ length: 2 }, () => new class extends EventTarget {
    readyState = 'live';
    stop() { stops++; this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
    end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  }());
  const stream = { getTracks: () => tracks };
  const node = () => ({ connect() {}, disconnect() { disconnects++; } });
  class Context extends EventTarget {
    sampleRate = overrides.rate ?? 48000;
    state = 'suspended'; destination = {};
    audioWorklet = { addModule: async (path: string) => { assert.equal(path, '/voice-processor.js'); await overrides.module?.(); } };
    constructor() { super(); context = this; }
    createMediaStreamSource(value: any) { assert.equal(value, stream); return node(); }
    createGain() { return { ...node(), gain: { value: 1 } }; }
    async resume() { await overrides.resume?.(); if (!overrides.suspended) this.state = 'running'; }
    async close() { closed++; this.state = 'closed'; this.dispatchEvent(new Event('statechange')); }
    interrupt(state = 'suspended') { this.state = state; this.dispatchEvent(new Event('statechange')); }
  }
  class Worklet {
    port: any = { onmessage: null, close() { portCloses++; } };
    constructor(_context: any, name: string, config: any) {
      assert.equal(name, 'opendots-pcm-capture'); assert.deepEqual(config.outputChannelCount, [1]); worklet = this;
    }
    connect() {} disconnect() { disconnects++; }
  }
  const options = {
    ...overrides,
    onFrame: async (bytes: Uint8Array, signal: AbortSignal) => {
      frames.push(bytes.slice()); signals.push(signal); await overrides.onFrame?.(bytes, signal);
    },
    onError: (error: Error) => { errors.push(error); overrides.onError?.(error); },
    onStateChange: (state: string) => { states.push(state); overrides.onStateChange?.(state); },
    mediaDevices: { getUserMedia: async (value: unknown) => { constraints = value; micCalls++; await overrides.permission?.(); return stream; } },
    AudioContext: Context, AudioWorkletNode: Worklet,
    clock: {
      now: () => milliseconds,
      setTimeout(callback: () => void, ms: number) { const timer = ++nextTimer; timers.set(timer, { at: milliseconds + ms, callback }); return timer; },
      clearTimeout(timer: number) { timers.delete(timer); },
    },
  };
  const capture = createVoiceStreamCapture(options);
  return {
    capture, frames, errors, states, signals, tracks,
    get context() { return context; }, get worklet() { return worklet; },
    get counts() { return { micCalls, closed, stops, portCloses, disconnects, timers: timers.size }; },
    get constraints() { return constraints; },
    emit(samples: Float32Array) { worklet.port.onmessage?.({ data: samples.slice() }); },
    advance(ms: number, fire = true) {
      milliseconds += ms;
      if (fire) for (const [id, timer] of timers) if (timer.at <= milliseconds) { timers.delete(id); timer.callback(); }
    },
  };
}

function reference(samples: Float32Array, rate: number) {
  const output = new Uint8Array(Math.floor(samples.length * 16000 / rate) * 2), view = new DataView(output.buffer);
  for (let index = 0; index < output.length / 2; index++) {
    const begin = index * rate / 16000, end = (index + 1) * rate / 16000;
    let weighted = 0;
    for (let input = Math.floor(begin); input < Math.ceil(end); input++) weighted += (Number.isFinite(samples[input]) ? samples[input] : 0) * Math.max(0, Math.min(end, input + 1) - Math.max(begin, input));
    const value = Math.max(-1, Math.min(1, Math.fround(weighted / (end - begin))));
    view.setInt16(index * 2, value < 0 ? value * 32768 : value * 32767, true);
  }
  return output;
}
const joined = (frames: Uint8Array[]) => new Uint8Array(Buffer.concat(frames));

test('import and construction access no microphone, context, network, or storage', () => {
  const url = new URL('../public/voice-stream-capture.js', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    for (const name of ['navigator','AudioContext','AudioWorkletNode','fetch','WebSocket','localStorage','indexedDB'])
      Object.defineProperty(globalThis,name,{configurable:true,get(){throw new Error('implicit '+name)}});
    const {createVoiceStreamCapture}=await import(${JSON.stringify(url)});
    const value=createVoiceStreamCapture({onFrame:async()=>{throw new Error('implicit send')}});
    if(value.active||value.state!=='idle')throw new Error('implicit start');
  `]);
  assert.throws(() => createVoiceStreamCapture({} as any), /sender_required/);
  assert.throws(() => createVoiceStreamCapture({ onFrame: async () => {}, maxSeconds: NaN }), /invalid_limit/);
});

for (const rate of [48000, 44100]) test(`${rate} Hz weighted resampling matches contiguous reference across arbitrary block boundaries`, async () => {
  const samples = Float32Array.from({ length: Math.floor(rate * 0.53) }, (_, i) => Math.sin(i * .071) * .8 + Math.cos(i * .017) * .03);
  const expected = reference(samples, rate);
  const one = fixture({ rate }); await one.capture.start(); one.emit(samples); await one.capture.stop();
  const chunks = fixture({ rate }); await chunks.capture.start();
  const sizes = [1, 7, 128, 441, 2, 163, 2047];
  for (let at = 0, i = 0; at < samples.length; i++) {
    const count = sizes[i % sizes.length]; chunks.emit(samples.slice(at, at + count)); at += count; await turn();
  }
  await chunks.capture.stop();
  assert.deepEqual(joined(one.frames), expected); assert.deepEqual(joined(chunks.frames), expected);
  for (const frame of [...one.frames, ...chunks.frames]) { assert.ok(frame.length > 0 && frame.length <= 6400); assert.equal(frame.length % 2, 0); }
});

test('PCM is signed little endian with clipping/non-finite silence, no WAV header, and borrowed frames are wiped', async () => {
  let borrowed: Uint8Array | undefined;
  const f = fixture({ rate: 16000, onFrame: async (bytes: Uint8Array) => { borrowed = bytes; } });
  const info = await f.capture.start(); assert.deepEqual(info, { sampleRate: 16000, frameSamples: 3200, maxSeconds: 60 });
  assert.deepEqual(f.constraints, { audio: { channelCount: 1, echoCancellation: true }, video: false });
  f.emit(new Float32Array([-2, -.5, 0, .5, 2, NaN, Infinity]));
  await f.capture.stop();
  assert.deepEqual([...f.frames[0]], [0,128,0,192,0,0,255,63,255,127,0,0,0,0]);
  assert.ok(borrowed!.every(value => value === 0));
  assert.deepEqual(f.counts, { micCalls: 1, closed: 1, stops: 2, portCloses: 1, disconnects: 3, timers: 0 });
  assert.equal(f.errors.length, 0); assert.equal(f.capture.state, 'stopped');
});

test('frames are serialized and ordered; stop releases mic synchronously then drains the final partial frame', async () => {
  const gates = [deferred(), deferred(), deferred()]; let calls = 0, active = 0, peak = 0;
  const f = fixture({ rate: 16000, onFrame: async () => { const own = calls++; peak = Math.max(peak, ++active); await gates[own].promise; active--; } });
  await f.capture.start();
  f.emit(new Float32Array(3200).fill(.25)); f.emit(new Float32Array(3200).fill(.5)); f.emit(new Float32Array(37).fill(-.5));
  await turn(); assert.equal(calls, 1);
  const stopped = f.capture.stop(); assert.equal(f.counts.stops, 2); assert.equal(f.capture.active, false);
  assert.equal(f.capture.stop(), stopped);
  let drained = false; void stopped.then(() => { drained = true; });
  gates[0].resolve(); await turn(); assert.equal(calls, 2); assert.equal(drained, false);
  gates[1].resolve(); await turn(); assert.equal(calls, 3); assert.equal(drained, false);
  gates[2].resolve(); await stopped;
  assert.equal(peak, 1); assert.deepEqual(f.frames.map(frame => frame.length), [6400,6400,74]);
  assert.deepEqual(f.frames.map(frame => new DataView(frame.buffer).getInt16(0, true)), [8191,16383,-16384]);
});

test('a slow sender fills only three pending frames, then errors and stops instead of retaining more audio', async () => {
  const gate = deferred(); const f = fixture({ rate: 16000, onFrame: () => gate.promise });
  await f.capture.start();
  for (let i = 0; i < 4; i++) f.emit(new Float32Array(3200).fill(.3));
  await turn(); assert.equal(f.frames.length, 1); assert.equal(f.capture.active, true);
  f.emit(new Float32Array(3200).fill(.9));
  assert.equal(f.capture.state, 'error'); assert.equal(f.counts.stops, 2); assert.equal(f.signals[0].aborted, true);
  await assert.rejects(f.capture.stop(), /backpressure/); assert.equal(f.errors.length, 1);
  await assert.rejects(f.capture.start(), /busy/);
  gate.resolve(); await turn(); assert.equal(f.frames.length, 1);
});

test('cancel aborts the in-flight signal, discards queued/final audio, and does not wait for an uncooperative sender', async () => {
  const gate = deferred(); const f = fixture({ rate: 16000, onFrame: () => gate.promise });
  await f.capture.start(); f.emit(new Float32Array(6401).fill(.4)); await turn();
  const saved = f.worklet.port.onmessage;
  await f.capture.cancel();
  assert.equal(f.signals[0].aborted, true); assert.equal(f.capture.state, 'cancelled'); assert.equal(f.counts.stops, 2);
  saved({ data: new Float32Array(3200) }); assert.equal(f.frames.length, 1);
  await assert.rejects(f.capture.start(), /busy/);
  gate.resolve(); await turn(); await assert.rejects(f.capture.stop(), { name: 'AbortError' }); assert.equal(f.frames.length, 1);
  await f.capture.cancel(); assert.equal(f.counts.stops, 2); assert.equal(f.errors.length, 0);
});

test('late permission after cancellation stops every track and creates no AudioContext or worklet', async () => {
  const gate = deferred(), f = fixture({ permission: () => gate.promise });
  const started = f.capture.start(); await turn();
  assert.equal(f.capture.state, 'starting'); await f.capture.cancel(); gate.resolve();
  await assert.rejects(started, { name: 'AbortError' });
  assert.equal(f.counts.stops, 2); assert.equal(f.context, undefined); assert.equal(f.frames.length, 0);
});

test('stop during worklet setup releases immediately and fences its late completion', async () => {
  const gate = deferred(), f = fixture({ module: () => gate.promise });
  const started = f.capture.start(); await turn();
  const stopped = f.capture.stop(); assert.equal(f.counts.stops, 2); await stopped;
  gate.resolve(); await assert.rejects(started, { name: 'AbortError' });
  assert.equal(f.worklet, undefined); assert.equal(f.counts.closed, 1); assert.equal(f.errors.length, 0);
});

test('cancel during AudioContext resume closes the port and fences late callbacks', async () => {
  const gate = deferred(), f = fixture({ resume: () => gate.promise });
  const started = f.capture.start(); await turn(); const stale = f.worklet.port.onmessage;
  await f.capture.cancel(); gate.resolve(); await assert.rejects(started, { name: 'AbortError' });
  stale({ data: new Float32Array(9600) }); await turn();
  assert.equal(f.frames.length, 0); assert.equal(f.counts.portCloses, 1); assert.equal(f.counts.stops, 2);
});

test('a new epoch cannot be stopped by an old worklet callback', async () => {
  const f = fixture({ rate: 16000 }); await f.capture.start(); const stale = f.worklet.port.onmessage;
  await f.capture.cancel(); for (const track of f.tracks) track.readyState = 'live';
  await f.capture.start(); stale({ data: new Float32Array(2000000) });
  assert.equal(f.capture.active, true); f.emit(new Float32Array(3).fill(.1)); await f.capture.stop();
  assert.equal(joined(f.frames).length, 6); assert.equal(f.errors.length, 0);
});

test('an older permission completion cannot release a newer epoch microphone', async () => {
  const gate = deferred(); let acquisitions = 0, oldStops = 0, newStops = 0;
  class Context {
    state = 'running'; sampleRate = 16000; destination = {};
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async resume() {} async close() { this.state = 'closed'; }
  }
  class Worklet { port = { onmessage: null, close() {} }; connect() {} disconnect() {} }
  const capture = createVoiceStreamCapture({
    onFrame: async () => {}, AudioContext: Context, AudioWorkletNode: Worklet,
    mediaDevices: { async getUserMedia() {
      if (++acquisitions === 1) { await gate.promise; return { getTracks: () => [{ stop() { oldStops++; } }] }; }
      return { getTracks: () => [{ stop() { newStops++; } }] };
    } },
  });
  const oldStart = capture.start(); await capture.cancel(); await capture.start();
  gate.resolve(); await assert.rejects(oldStart, { name: 'AbortError' });
  assert.equal(capture.active, true); assert.equal(oldStops, 1); assert.equal(newStops, 0);
  await capture.cancel(); assert.equal(newStops, 1);
});

test('cancel wins a draining stop race without a successful finish or a second sender', async () => {
  const gate = deferred(), f = fixture({ rate: 16000, onFrame: () => gate.promise });
  await f.capture.start(); f.emit(new Float32Array(3210)); await turn();
  const stopping = f.capture.stop(); await f.capture.cancel();
  await assert.rejects(stopping, { name: 'AbortError' }); assert.equal(f.signals[0].aborted, true);
  gate.resolve(); await turn(); assert.equal(f.frames.length, 1); assert.equal(f.errors.length, 0);
});

test('sample budget trims overshoot exactly, stops before limit callback, and supports idempotent stop there', async () => {
  let limits = 0, limitStopped: Promise<void> | undefined;
  const f = fixture({ maxSeconds: 1, onLimit: () => { limits++; assert.equal(f.counts.stops, 2); limitStopped = f.capture.stop(); } });
  await f.capture.start();
  for (let i = 0; i < 39; i++) { f.emit(new Float32Array(1200).fill(.25)); await turn(); }
  f.emit(new Float32Array(5000).fill(.25)); await limitStopped;
  assert.equal(joined(f.frames).length, 32000); assert.equal(limits, 1); assert.equal(f.capture.state, 'stopped');
  f.advance(2000); assert.equal(limits, 1);
});

test('wall limit releases even with no samples; delayed timer cannot allow a late frame', async () => {
  let limits = 0; const f = fixture({ maxSeconds: 999, onLimit: () => { limits++; } });
  assert.equal((await f.capture.start()).maxSeconds, 120); f.advance(120000); await f.capture.stop();
  assert.equal(f.counts.stops, 2); assert.equal(limits, 1); assert.equal(f.frames.length, 0);
  const delayed = fixture({ maxSeconds: 1 }); await delayed.capture.start(); delayed.advance(1000, false);
  delayed.emit(new Float32Array(9600)); await delayed.capture.stop(); assert.equal(delayed.frames.length, 0);
});

test('wall limit also cleans a microphone while worklet setup is still pending', async () => {
  const gate = deferred(), f = fixture({ maxSeconds: 1, module: () => gate.promise });
  const started = f.capture.start(); await turn(); f.advance(1000); await f.capture.stop();
  assert.equal(f.counts.stops, 2); assert.equal(f.counts.closed, 1);
  gate.resolve(); await assert.rejects(started, { name: 'AbortError' });
});

test('track loss and suspended/closed context terminate once; normal stop does not report those cleanup events', async () => {
  for (const event of ['track', 'suspended', 'closed']) {
    const f = fixture(); await f.capture.start();
    if (event === 'track') f.tracks[0].end(); else f.context.interrupt(event);
    assert.equal(f.capture.state, 'error'); assert.equal(f.counts.stops, 2); assert.equal(f.errors.length, 1);
    await assert.rejects(f.capture.stop(), /track_ended|context_interrupted/);
  }
  const f = fixture(); await f.capture.start(); await f.capture.stop(); assert.equal(f.errors.length, 0);
});

test('setup, resume and sender failures release resources without unhandled autonomous rejections', async () => {
  for (const override of [{ module: async () => { throw new Error('module failed'); } }, { suspended: true }, { rate: 123.5 }]) {
    const f = fixture(override); await assert.rejects(f.capture.start());
    assert.equal(f.counts.stops, 2); assert.equal(f.counts.closed, 1); assert.equal(f.errors.length, 1);
  }
  const f = fixture({ rate: 16000, onFrame: async () => { throw new Error('transport failed'); } });
  await f.capture.start(); f.emit(new Float32Array(3200)); await turn();
  await assert.rejects(f.capture.stop(), /send_failed/); assert.equal(f.errors.length, 1); assert.equal(f.counts.stops, 2);
});
