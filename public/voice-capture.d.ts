export function encodeMonoWav(samples: Float32Array, sampleRate: number): ArrayBuffer;
export function resampleMono(samples: Float32Array, inputRate: number, outputRate?: number): Float32Array;
export function createVoiceCapture(options?: {
  maxSeconds?: number;
  onLimit?: () => void;
  mediaDevices?: { getUserMedia(constraints: unknown): Promise<any> };
  AudioContext?: new (...args: any[]) => any;
  AudioWorkletNode?: new (...args: any[]) => any;
}): {
  start(): Promise<{ sampleRate: number; maxSeconds: number }>;
  stop(): Promise<Blob>;
  cancel(): Promise<void>;
  readonly active: boolean;
};
