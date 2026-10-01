/** Product-only, opt-in microphone capture. Importing this module performs no IO. */
export function encodeMonoWav(samples, sampleRate) {
  if (!(samples instanceof Float32Array) || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Unsupported PCM format');
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const sample = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0)); view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true); }
  return bytes;
}

export function resampleMono(samples, inputRate, outputRate = 16000) {
  if (inputRate === outputRate) return samples.slice();
  const count = Math.floor(samples.length * outputRate / inputRate);
  const output = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const start = i * inputRate / outputRate, end = (i + 1) * inputRate / outputRate;
    let sum = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) sum += (samples[j] || 0) * Math.max(0, Math.min(end, j + 1) - Math.max(start, j));
    output[i] = sum / (end - start);
  }
  return output;
}

export function createVoiceCapture(options = {}) {
  let generation = 0, stream = null, context = null, processor = null, source = null, gain = null;
  let chunks = [], length = 0, rate = 0, active = false, timer = null;
  const maxSeconds = Math.min(30, Math.max(1, options.maxSeconds || 10));
  const stopTracks = value => { for (const track of value?.getTracks?.() || []) track.stop(); };
  async function release() {
    clearTimeout(timer); timer = null; active = false;
    stopTracks(stream); stream = null;
    if (processor) { processor.port.onmessage = null; processor.disconnect(); processor.port.close?.(); processor = null; }
    source?.disconnect(); source = null; gain?.disconnect(); gain = null;
    const oldContext = context; context = null;
    if (oldContext && oldContext.state !== 'closed') await oldContext.close().catch(() => {});
  }
  async function cancel() { generation++; chunks = []; length = 0; await release(); }
  async function start() {
    await cancel(); const ownGeneration = ++generation;
    const mediaDevices = options.mediaDevices || globalThis.navigator?.mediaDevices;
    const Context = options.AudioContext || globalThis.AudioContext;
    const Worklet = options.AudioWorkletNode || globalThis.AudioWorkletNode;
    if (!mediaDevices?.getUserMedia || !Context || !Worklet) throw new Error('This browser does not support secure microphone capture with AudioWorklet');
    try {
      const acquired = await mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
      if (ownGeneration !== generation) { stopTracks(acquired); throw new Error('Recording cancelled'); }
      stream = acquired; context = new Context(); rate = context.sampleRate;
      await context.audioWorklet.addModule('/voice-processor.js');
      if (ownGeneration !== generation) throw new Error('Recording cancelled');
      source = context.createMediaStreamSource(stream);
      processor = new Worklet(context, 'opendots-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      gain = context.createGain(); gain.gain.value = 0; source.connect(processor); processor.connect(gain); gain.connect(context.destination);
      active = true;
      processor.port.onmessage = event => {
        if (!active || ownGeneration !== generation || !(event.data instanceof Float32Array)) return;
        const remaining = Math.max(0, Math.floor(rate * maxSeconds) - length);
        if (remaining) { const part = event.data.slice(0, remaining); chunks.push(part); length += part.length; }
        if (length >= rate * maxSeconds) { active = false; void release(); options.onLimit?.(); }
      };
      await context.resume();
      if (ownGeneration !== generation) throw new Error('Recording cancelled');
      timer = setTimeout(() => { if (active) { active = false; void release(); options.onLimit?.(); } }, maxSeconds * 1000);
      return { sampleRate: rate, maxSeconds };
    } catch (error) { if (ownGeneration === generation) await cancel(); throw error; }
  }
  async function stop() {
    generation++; const samples = new Float32Array(length); let offset = 0;
    for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
    chunks = []; length = 0; const sampleRate = rate; await release();
    if (!samples.length || !sampleRate) throw new Error('No audio was captured');
    const mono16k = resampleMono(samples, sampleRate, 16000); const wav = encodeMonoWav(mono16k, 16000); samples.fill(0); mono16k.fill(0);
    return new Blob([wav], { type: 'audio/wav' });
  }
  return { start, stop, cancel, get active() { return active; } };
}
