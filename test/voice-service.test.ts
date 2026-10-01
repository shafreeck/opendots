import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceService, VoiceError } from '../src/voice-service.ts';
import { configuredVoiceProvider, type SpeechProvider } from '../src/voice-provider.ts';
import { wavFromPCM, readSpeechWav } from '../vendor/app-speech/audio.ts';
import type { IoEvent } from '../src/morphz-adapter.ts';

const wav = Buffer.from(wavFromPCM(new Uint8Array(3200)));
const message = (extra: Partial<IoEvent> = {}): IoEvent => ({ io_version: '1', type: 'output.committed', event_id: 'committed-1', sequence: 1, session_id: 'session-1', message: { format: { id: 'morphz.chat', version: '1' }, content: { encoding: 'json', value: { text: '已保存的回复' } } }, ...extra });
function fixture(events = [message()]) {
  const calls: unknown[] = [];
  const provider: SpeechProvider = { provider: { id: 'doubao', label: '豆包' }, configured: () => true, transcribe: async (...args) => { calls.push(['transcribe', ...args]); return '识别出来的草稿'; }, synthesize: async (...args) => { calls.push(['synthesize', ...args]); return wav; } };
  const context = async () => ({ sessionId: 'session-1', principalId: 'verified-principal', events });
  return { provider, calls, context, service: new VoiceService({ enabled: true, provider, context }) };
}
const signal = () => new AbortController().signal;

test('voice defaults disabled, configuration and capability reads make no provider calls', async () => {
  const f = fixture();
  const disabled = new VoiceService({ enabled: false, provider: f.provider, context: f.context });
  assert.equal(disabled.capabilities().available, false); assert.equal(disabled.capabilities().operations.duplex, false);
  await assert.rejects(disabled.transcribe(wav, true, signal()), (e: any) => e.status === 503);
  const missing = new VoiceService({ enabled: true, context: f.context }); assert.equal(missing.capabilities().status, 'configuration_required');
  assert.equal(configuredVoiceProvider({ DOUBAO_API_KEY: 'synthetic-test-only' }).enabled, false);
  assert.equal(configuredVoiceProvider({ OPENDOTS_VOICE_ENABLED: '1' }).provider?.configured(), false);
  assert.equal(f.calls.length, 0);
});

test('speech config reuses allowlisted explicit application environment without mutating host environment or exposing keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-voice-env-'));
  try {
    const file = join(dir, 'speech.env'); writeFileSync(file, 'DOUBAO_API_KEY=synthetic-config-key\nPATH=/untrusted\nOTHER_SECRET=do-not-read\n');
    const env = { OPENDOTS_VOICE_ENABLED: '1', MORPHZ_APP_ENV_FILE: file };
    const configured = configuredVoiceProvider(env); assert.equal(configured.provider?.configured(), true);
    assert.equal(configuredVoiceProvider({OPENDOTS_VOICE_ENABLED:'1',OPENDOTS_VOICE_ENV_FILE:file,MORPHZ_APP_ENV_FILE:'/nonexistent/upstream-app.env',MORPHZWORK_ENV_FILE:'/nonexistent/work.env'}).provider?.configured(),true);
    assert.equal(configuredVoiceProvider({OPENDOTS_VOICE_ENABLED:'1',OPENDOTS_VOICE_ENV_FILE:'',MORPHZ_APP_ENV_FILE:'/nonexistent/upstream-app.env'}).provider?.configured(),false);
    assert.equal(configuredVoiceProvider({OPENDOTS_VOICE_ENABLED:'1',MORPHZWORK_ENV_FILE:'/nonexistent/work.env'}).provider?.configured(),false); assert.equal(Object.hasOwn(env, 'DOUBAO_API_KEY'), false);
    const capabilities = new VoiceService({ ...configured, context: fixture().context }).capabilities();
    assert.ok(!JSON.stringify(capabilities).includes('synthetic-config-key')); assert.equal(capabilities.provider.destination, 'openspeech.bytedance.com');
    assert.equal(capabilities.verification, 'configuration_only');
    assert.equal(configuredVoiceProvider({ ...env, DOUBAO_API_KEY: '' }).provider?.configured(), false);
    assert.throws(() => configuredVoiceProvider({ OPENDOTS_VOICE_ENABLED: '1', MORPHZ_APP_ENV_FILE: 'relative.env' }), /绝对路径/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canonical 30-second capture limit and explicit consent fail before transmission', async () => {
  const f = fixture();
  await assert.rejects(f.service.transcribe(wav, false, signal()), (e: any) => e.status === 400);
  for (const invalid of [new Uint8Array(10), wavFromPCM(new Uint8Array(960002)), Buffer.from(wav).fill(0, 20, 22)]) await assert.rejects(f.service.transcribe(invalid, true, signal()), VoiceError);
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(f.service.transcribe(wav, true, aborted.signal), (e: any) => e.status === 499);
  assert.equal(f.calls.length, 0); assert.equal(readSpeechWav(wav).length, 3200);
  const result = await f.service.transcribe(wav, true, signal());
  assert.deepEqual(result, { text: '识别出来的草稿', reviewRequired: true, sentToChat: false });
  assert.equal((f.calls[0] as any[])[1], 'verified-principal');
});

test('fixed identity must be reauthorized before any provider request and cancellation discards the result', async () => {
  const f = fixture(); const denied = new VoiceService({ enabled: true, provider: f.provider, context: async () => { throw Error('synthetic-private-upstream-token'); } });
  await assert.rejects(denied.transcribe(wav, true, signal()), (e: any) => e.status === 503 && !e.message.includes('token')); assert.equal(f.calls.length, 0);
  const control = new AbortController(); f.provider.transcribe = async () => { control.abort(); return 'late result'; };
  await assert.rejects(f.service.transcribe(wav, true, control.signal), (e: any) => e.status === 499);
});

test('read-aloud resolves only committed assistant text in the bound Session and forbids browser-selected text', async () => {
  const f = fixture(); assert.deepEqual(await f.service.readAloud({ messageId: 'committed-1', consent: true }, signal()), wav);
  assert.deepEqual((f.calls[0] as any[]).slice(0, 3), ['synthesize', 'verified-principal', '已保存的回复']);
  for (const input of [{ messageId: 'committed-1', consent: false }, { messageId: 'unknown', consent: true }, { messageId: 'committed-1', consent: true, text: 'arbitrary text' }]) await assert.rejects(f.service.readAloud(input, signal()), VoiceError);
  for (const event of [message({ session_id: 'foreign-session' }), message({ type: 'input.accepted' }), message({ type: 'output.text.delta' })]) {
    const bad = fixture([event]); await assert.rejects(bad.service.readAloud({ messageId: 'committed-1', consent: true }, signal()), (e: any) => e.status === 404); assert.equal(bad.calls.length, 0);
  }
  const long = fixture([message({ message: { format: { id: 'morphz.chat', version: '1' }, content: { encoding: 'json', value: { text: 'x'.repeat(2001) } } } })]);
  await assert.rejects(long.service.readAloud({ messageId: 'committed-1', consent: true }, signal()), (e: any) => e.status === 413); assert.equal(long.calls.length, 0);
});

test('voice errors redact upstream text, never retry, and malformed playback is not delivered', async () => {
  const f = fixture(); let calls = 0;
  f.provider.transcribe = async () => { calls++; throw Error('SYNTHETIC_API_KEY_ECHO'); };
  await assert.rejects(f.service.transcribe(wav, true, signal()), (e: any) => e.status === 502 && !e.message.includes('SYNTHETIC')); assert.equal(calls, 1);
  f.provider.synthesize = async () => Buffer.from('not audio');
  await assert.rejects(f.service.readAloud({ messageId: 'committed-1', consent: true }, signal()), (e: any) => e.status === 502);
});
