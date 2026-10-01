/** Opt-in, bounded PCM capture. Importing/constructing this helper performs no IO.
 * The caller obtains streaming/provider consent and owns transport and its costs.
 * onFrame borrows each frame until its promise settles; the bytes are then wiped.
 */
const OUTPUT_RATE = 16000;
const FRAME_SAMPLES = 3200;
const MAX_QUEUED_FRAMES = 3;

function captureError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function cancelledError() {
  const error = captureError('voice_stream_cancelled');
  error.name = 'AbortError';
  return error;
}

function safely(callback) { try { callback?.(); } catch { /* Observer/cleanup errors cannot retain a microphone. */ } }

// Integer time units avoid fractional boundary drift at rates such as 44.1 kHz.
// Each input sample spans OUTPUT_RATE units; each output sample spans inputRate.
function resampler(inputRate, emit) {
  let remaining = inputRate, weighted = 0;
  return {
    push(samples, count) {
      for (let i = 0; i < count; i++) {
        const sample = Number.isFinite(samples[i]) ? samples[i] : 0;
        let width = OUTPUT_RATE;
        while (width > 0) {
          const take = Math.min(width, remaining);
          weighted += sample * take; remaining -= take; width -= take;
          if (remaining === 0) {
            const value = Math.fround(weighted / inputRate);
            weighted = 0; remaining = inputRate;
            if (!emit(value)) return;
          }
        }
      }
    },
    reset() { remaining = inputRate; weighted = 0; },
  };
}

export function createVoiceStreamCapture(options) {
  if (typeof options?.onFrame !== 'function') throw captureError('voice_stream_sender_required');
  const requestedSeconds = options.maxSeconds ?? 60;
  if (!Number.isFinite(requestedSeconds)) throw captureError('voice_stream_invalid_limit');
  const maxSeconds = Math.min(120, Math.max(1, requestedSeconds));
  const now = options.clock?.now ?? (() => globalThis.performance.now());
  const schedule = options.clock?.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const unschedule = options.clock?.clearTimeout ?? (timer => globalThis.clearTimeout(timer));
  let current = null, epoch = 0, pendingSends = 0;

  const live = run => current === run && run.epoch === epoch;
  const capturing = run => live(run) && run.state === 'recording';
  function state(run, value) {
    run.state = value;
    safely(() => options.onStateChange?.(value));
  }
  function stopTracks(stream) {
    for (const track of stream?.getTracks?.() ?? []) safely(() => track.stop());
  }
  function release(run) {
    if (run.cleanup) return run.cleanup;
    if (run.timer !== null) safely(() => unschedule(run.timer));
    run.timer = null;
    for (const [track, handler] of run.trackListeners) safely(() => track.removeEventListener('ended', handler));
    run.trackListeners = [];
    if (run.context && run.contextListener) safely(() => run.context.removeEventListener('statechange', run.contextListener));
    run.contextListener = null;
    if (run.processor) {
      run.processor.port.onmessage = null;
      safely(() => run.processor.port.close());
      safely(() => run.processor.disconnect());
    }
    safely(() => run.source?.disconnect());
    safely(() => run.gain?.disconnect());
    stopTracks(run.stream); run.stream = null;
    const context = run.context;
    run.context = run.processor = run.source = run.gain = null;
    let closing;
    safely(() => { if (context && context.state !== 'closed') closing = context.close(); });
    run.cleanup = Promise.resolve(closing).catch(() => {});
    return run.cleanup;
  }
  function discard(run) {
    for (const frame of run.queue) frame.fill(0);
    run.queue = [];
    run.frame.fill(0); run.frameLength = 0;
    run.resampler?.reset();
  }
  function fail(run, error) {
    if (!live(run) || ['cancelled', 'stopped', 'error'].includes(run.state)) return;
    run.error = error;
    run.reject(error);
    state(run, 'error');
    run.controller.abort(); discard(run);
    const cleanup = release(run);
    safely(() => options.onError?.(error));
    return cleanup;
  }
  function completeIfDrained(run) {
    if (run.state !== 'stopping' || run.inFlight || run.queue.length || run.completing) return;
    run.completing = true;
    void release(run).then(() => {
      if (run.state !== 'stopping') return;
      state(run, 'stopped'); run.resolve();
    });
  }
  function pump(run) {
    if (!live(run) || !['recording', 'stopping'].includes(run.state) || run.inFlight || !run.queue.length) return;
    const bytes = run.queue.shift();
    run.inFlight = bytes; pendingSends++;
    // A microtask keeps synchronous sender failures within the same terminal path.
    void Promise.resolve().then(() => {
      if (run.controller.signal.aborted) throw cancelledError();
      return options.onFrame(bytes, run.controller.signal);
    }).catch(() => {
      if (!run.controller.signal.aborted) fail(run, captureError('voice_stream_send_failed'));
    }).finally(() => {
      bytes.fill(0); run.inFlight = null; pendingSends--;
      pump(run); completeIfDrained(run);
    });
  }
  function enqueue(run, bytes) {
    if (run.queue.length >= MAX_QUEUED_FRAMES) {
      bytes.fill(0); fail(run, captureError('voice_stream_backpressure')); return false;
    }
    run.queue.push(bytes); pump(run); return true;
  }
  function emit(run, value) {
    if (!capturing(run)) return false;
    const sample = Math.max(-1, Math.min(1, value));
    run.frameView.setInt16(run.frameLength * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    run.frameLength++;
    if (run.frameLength !== FRAME_SAMPLES) return true;
    const bytes = run.frame;
    run.frame = new Uint8Array(FRAME_SAMPLES * 2); run.frameView = new DataView(run.frame.buffer); run.frameLength = 0;
    return enqueue(run, bytes);
  }
  function finish(run, limited = false) {
    if (!live(run) || !['starting', 'recording'].includes(run.state)) return;
    // Set the fence before stopping tracks: a synchronous ended event is harmless.
    state(run, 'stopping'); release(run);
    if (run.state !== 'stopping') return; // An observer may have cancelled.
    run.resampler?.reset(); // Do not pad an incomplete 16 kHz sample.
    if (run.frameLength) {
      const bytes = run.frame.slice(0, run.frameLength * 2);
      run.frame.fill(0); run.frameLength = 0;
      if (!enqueue(run, bytes)) return;
    }
    completeIfDrained(run);
    if (limited) safely(() => options.onLimit?.());
  }
  function assertStarting(run) {
    if (!live(run) || run.state !== 'starting') throw run.error ?? cancelledError();
    if (run.deadline !== null && now() >= run.deadline) {
      finish(run, true); throw cancelledError();
    }
  }
  async function start() {
    if (pendingSends || (current && ['starting', 'recording', 'stopping'].includes(current.state))) throw captureError('voice_stream_busy');
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    void done.catch(() => {}); // Automatic termination is also reported through onError.
    const frame = new Uint8Array(FRAME_SAMPLES * 2);
    const run = {
      epoch: ++epoch, state: 'starting', controller: new AbortController(),
      done, resolve, reject, error: null, queue: [], inFlight: null,
      frame, frameView: new DataView(frame.buffer), frameLength: 0, resampler: null,
      stream: null, context: null, processor: null, source: null, gain: null,
      trackListeners: [], contextListener: null, cleanup: null, completing: false,
      timer: null, deadline: null, inputSamples: 0,
    };
    current = run; state(run, 'starting');
    try {
      assertStarting(run);
      const mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
      const Context = options.AudioContext ?? globalThis.AudioContext;
      const Worklet = options.AudioWorkletNode ?? globalThis.AudioWorkletNode;
      if (!mediaDevices?.getUserMedia || !Context || !Worklet) throw captureError('voice_stream_unsupported');
      const acquired = await mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
      if (!live(run) || run.state !== 'starting') { stopTracks(acquired); throw run.error ?? cancelledError(); }
      run.stream = acquired;
      const tracks = acquired.getTracks();
      if (!tracks.length || tracks.some(track => track.readyState === 'ended')) throw captureError('voice_stream_track_ended');
      for (const track of tracks) {
        const handler = () => { if (live(run) && ['starting', 'recording'].includes(run.state)) fail(run, captureError('voice_stream_track_ended')); };
        track.addEventListener?.('ended', handler); run.trackListeners.push([track, handler]);
      }
      run.deadline = now() + maxSeconds * 1000;
      run.timer = schedule(() => finish(run, true), maxSeconds * 1000);
      run.context = new Context();
      const context = run.context, rate = context.sampleRate;
      if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) throw captureError('voice_stream_sample_rate');
      const sampleBudget = Math.floor(rate * maxSeconds);
      run.resampler = resampler(rate, value => emit(run, value));
      await context.audioWorklet.addModule('/voice-processor.js');
      assertStarting(run);
      run.source = context.createMediaStreamSource(acquired);
      run.processor = new Worklet(context, 'opendots-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      run.gain = context.createGain(); run.gain.gain.value = 0;
      run.source.connect(run.processor); run.processor.connect(run.gain); run.gain.connect(context.destination);
      run.processor.port.onmessage = event => {
        if (!capturing(run) || !(event.data instanceof Float32Array)) return;
        if (now() >= run.deadline) { event.data.fill(0); finish(run, true); return; }
        const count = Math.min(event.data.length, sampleBudget - run.inputSamples);
        run.inputSamples += count;
        run.resampler.push(event.data, count); event.data.fill(0);
        if (capturing(run) && run.inputSamples >= sampleBudget) finish(run, true);
      };
      run.contextListener = () => { if (capturing(run) && context.state !== 'running') fail(run, captureError('voice_stream_context_interrupted')); };
      context.addEventListener?.('statechange', run.contextListener);
      await context.resume();
      assertStarting(run);
      if (context.state !== 'running') throw captureError('voice_stream_context_interrupted');
      state(run, 'recording');
      if (!capturing(run)) throw run.error ?? cancelledError();
      return { sampleRate: OUTPUT_RATE, frameSamples: FRAME_SAMPLES, maxSeconds };
    } catch (error) {
      if (live(run) && ['starting', 'recording'].includes(run.state)) fail(run, error);
      throw error;
    }
  }
  function stop() {
    if (!current) return Promise.resolve();
    finish(current); return current.done;
  }
  function cancel() {
    if (!current) return Promise.resolve();
    const run = current;
    run.reject(cancelledError());
    state(run, 'cancelled'); run.controller.abort(); discard(run);
    const cleanup = release(run);
    return cleanup;
  }
  return { start, stop, cancel, get active() { return current?.state === 'recording'; }, get state() { return current?.state ?? 'idle'; } };
}
