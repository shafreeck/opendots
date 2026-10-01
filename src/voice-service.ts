import type { IoEvent } from './morphz-adapter.ts';
import type { SpeechProvider } from './voice-provider.ts';
import { maxSpeechSegmentBytes, maxSpeechSegmentSeconds, maxTtsSegmentCharacters, readSpeechWav, speechCaptureSegmentSeconds, speechSampleRate, wavFromPCM } from '../vendor/app-speech/audio.ts';

export class VoiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface VoiceContext { sessionId: string; principalId: string; events: IoEvent[] }
export interface VoiceServiceOptions {
  enabled: boolean;
  provider?: SpeechProvider;
  /** Must reauthorize the server's fixed binding. Never populated from HTTP identity fields. */
  context: () => Promise<VoiceContext>;
}
export const maximumVoicePlaybackBytes = 8 * 1024 * 1024;

/** Explicit one-shot speech. Recognized text is an unsent draft; neither method
 * submits chat, creates Sessions, stores audio, or starts background capture.
 */
export class VoiceService {
  private options: VoiceServiceOptions;
  private lifecycle = new AbortController();
  constructor(options: VoiceServiceOptions) { this.options = options; }
  capabilities() {
    const { enabled, provider } = this.options;
    const configured = provider?.configured() === true;
    const available = enabled && configured;
    return {
      enabled, configured, available,
      status: !enabled ? 'disabled' : !configured ? 'configuration_required' : 'available',
      provider: { id: 'doubao', label: '豆包', destination: 'openspeech.bytedance.com' },
      operations: { transcribe: available, readAloud: available, duplex: false },
      capture: { mimeType: 'audio/wav', sampleRate: speechSampleRate, channels: 1, bitsPerSample: 16, maximumBytes: maxSpeechSegmentBytes, maximumSeconds: maxSpeechSegmentSeconds, recommendedSeconds: speechCaptureSegmentSeconds },
      readAloud: { maximumCharacters: maxTtsSegmentCharacters, maximumBytes: maximumVoicePlaybackBytes, source: 'committed_assistant_message' },
      privacy: { audioStored: false, retentionScope: 'opendots_local_only', providerRetention: 'provider_policy', automaticSend: false, automaticRetry: false, providerFallback: false },
      verification: 'configuration_only',
      message: !enabled ? '语音默认关闭。需要先由服务端显式开启并配置语音提供商。' : !configured ? '尚未配置服务端语音密钥。语音服务与对话模型分别配置。' : '仅在你点击后向豆包发送录音或朗读文字，可能产生费用。权限、额度和服务可用性尚未探测。',
    };
  }
  private provider(consent: boolean, signal: AbortSignal): SpeechProvider {
    if (consent !== true) throw new VoiceError(400, '需要明确同意本次语音传输。');
    if (!this.capabilities().available || !this.options.provider) throw new VoiceError(503, '语音服务尚未启用或配置。');
    if (signal.aborted) throw new VoiceError(499, '语音操作已取消。');
    return this.options.provider;
  }
  private async context(signal: AbortSignal): Promise<VoiceContext> {
    let context: VoiceContext;
    try { context = await this.options.context(); } catch { throw new VoiceError(503, '无法确认当前会话身份，未向语音提供商发送内容。'); }
    if (signal.aborted) throw new VoiceError(499, '语音操作已取消。');
    if (!context.sessionId || !context.principalId || !Array.isArray(context.events)) throw new VoiceError(503, '当前会话身份不可用。');
    return context;
  }
  async transcribe(wav: Uint8Array, consent: boolean, signal: AbortSignal) {
    signal = AbortSignal.any([signal, this.lifecycle.signal]);
    const provider = this.provider(consent, signal);
    try { readSpeechWav(wav); } catch { throw new VoiceError(400, '录音必须为 30 秒以内、单声道 16kHz、16 位 PCM WAV。'); }
    const context = await this.context(signal);
    let text: string;
    try { text = await provider.transcribe(context.principalId, wav, signal); }
    catch { throw new VoiceError(signal.aborted ? 499 : 502, signal.aborted ? '语音操作已取消。' : '语音识别未确认，未自动重试。请检查服务配置、权限与额度。'); }
    if (signal.aborted) throw new VoiceError(499, '语音操作已取消。');
    if (typeof text !== 'string' || !text.trim() || text.length > 30000) throw new VoiceError(502, '语音服务未返回有效文字。');
    return { text, reviewRequired: true, sentToChat: false };
  }
  async readAloud(input: { messageId: string; consent: boolean }, signal: AbortSignal) {
    signal = AbortSignal.any([signal, this.lifecycle.signal]);
    if (!input || Object.keys(input).some(key => !['messageId', 'consent'].includes(key)) || typeof input.messageId !== 'string' || !input.messageId || input.messageId.length > 2048) throw new VoiceError(400, '朗读只能引用当前会话中已提交的助手回复。');
    const provider = this.provider(input.consent, signal);
    const context = await this.context(signal);
    const event = context.events.find(value => value.event_id === input.messageId);
    if (!event || event.type !== 'output.committed' || (event.session_id !== undefined && event.session_id !== context.sessionId)) throw new VoiceError(404, '未找到当前会话中可朗读的助手回复。');
    const content = event.message?.content;
    const value = content?.value as { text?: unknown } | undefined;
    const text = content?.encoding === 'json' ? value?.text : content?.encoding === 'utf8' ? content.text : undefined;
    if (event.message?.format.id !== 'morphz.chat' || event.message.format.version !== '1' || typeof text !== 'string' || !text.trim()) throw new VoiceError(400, '这条回复没有可朗读的文字。');
    if (text.trim().length > maxTtsSegmentCharacters) throw new VoiceError(413, '这条回复超过当前 2000 字符朗读上限，未发送给语音提供商。');
    let wav: Buffer;
    try { wav = await provider.synthesize(context.principalId, text, signal); }
    catch { throw new VoiceError(signal.aborted ? 499 : 502, signal.aborted ? '语音操作已取消。' : '朗读音频未确认，未自动重试。请检查服务配置、权限与额度。'); }
    if (signal.aborted) throw new VoiceError(499, '语音操作已取消。');
    // TTS can exceed the capture duration but is still a bounded canonical WAV.
    // Reconstruct and compare to reject arbitrary formats from an injected adapter.
    if (!(wav instanceof Uint8Array) || wav.byteLength < 46 || wav.byteLength > maximumVoicePlaybackBytes || wav.byteLength % 2 || !Buffer.from(wavFromPCM(wav.subarray(44))).equals(wav)) throw new VoiceError(502, '语音服务未返回有效的有界 WAV 音频。');
    return wav;
  }
  close() { this.lifecycle.abort(); }
}
