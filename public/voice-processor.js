/** AudioWorklet local PCM collector; no network or storage. */
class OpendotsPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (channels?.length && channels[0]?.length) {
      const mono = new Float32Array(channels[0].length);
      for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += (channel[i] || 0) / channels.length;
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('opendots-pcm-capture', OpendotsPcmCapture);
