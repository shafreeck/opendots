export type VoiceStreamCaptureState = 'idle' | 'starting' | 'recording' | 'stopping' | 'stopped' | 'cancelled' | 'error';
export interface VoiceStreamCaptureOptions {
  /** Borrowed PCM16LE bytes, wiped after the promise settles. One call at a time. */
  onFrame(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /** Default 60 seconds; clamped to 1–120 seconds. Wall time begins on acquisition. */
  maxSeconds?: number;
  /** Mic is already released; call stop() to await the final send before finishing. */
  onLimit?: () => void;
  onError?: (error: Error) => void;
  onStateChange?: (state: VoiceStreamCaptureState) => void;
  mediaDevices?: { getUserMedia(constraints: unknown): Promise<any> };
  AudioContext?: new (...args: any[]) => any;
  AudioWorkletNode?: new (...args: any[]) => any;
  clock?: {
    now(): number;
    setTimeout(callback: () => void, milliseconds: number): any;
    clearTimeout(timer: any): void;
  };
}
export function createVoiceStreamCapture(options: VoiceStreamCaptureOptions): {
  start(): Promise<{ sampleRate: number; frameSamples: number; maxSeconds: number }>;
  /** Releases mic, flushes a partial frame, awaits sends; rejects AbortError if cancelled. */
  stop(): Promise<void>;
  /** Aborts the sender and releases mic; does not await a sender ignoring abort. */
  cancel(): Promise<void>;
  readonly active: boolean;
  readonly state: VoiceStreamCaptureState;
};
