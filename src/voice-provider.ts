import { DoubaoSpeechProvider, type SpeechProvider } from '../vendor/app-speech/speech.ts';
import { loadServiceEnvironment } from '../vendor/app-speech/environment.ts';
import { isAbsolute } from 'node:path';

/** Reads only operator-selected configuration; never probes the service or
 * persists a second credential store. Tests pass synthetic environment objects.
 */
export function configuredVoiceProvider(environment: NodeJS.ProcessEnv = process.env): { enabled: boolean; provider?: SpeechProvider } {
  const enabled = environment.OPENDOTS_VOICE_ENABLED === '1';
  if (!enabled) return { enabled: false };
  const selected = { ...environment };
  // Reuse the application's allowlisted loader only with an explicit file.
  // Do not silently scan the repository, home directory or Runtime credentials.
  const filename = environment.OPENDOTS_VOICE_ENV_FILE ?? environment.MORPHZ_APP_ENV_FILE;
  if (filename) {
    if (!isAbsolute(filename)) throw new Error('语音环境配置文件必须是绝对路径。');
    // Pin the explicitly selected opendots file inside the copied loader too;
    // inherited upstream aliases cannot redirect this read. No checkout is needed.
    selected.MORPHZ_APP_ENV_FILE = filename;
    loadServiceEnvironment(selected, filename);
  }
  return { enabled: true, provider: new DoubaoSpeechProvider(selected.DOUBAO_API_KEY) };
}
export { DoubaoSpeechProvider, SpeechProviderError, asrFrame, asrResponse } from '../vendor/app-speech/speech.ts';
export type { SpeechProvider } from '../vendor/app-speech/speech.ts';
