import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { createCapabilities, artifactURL, suggestedName, saveExclusive, MAX_ARTIFACT_BYTES } = require('../apps/desktop/capabilities.cjs');
const origin = 'http://127.0.0.1:3210', artifact = origin + '/api/artifacts/' + 'a'.repeat(64) + '/content';
const device = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function fixture(options: { platform?: string; origin?: string } = {}) {
  const origin = options.origin ?? 'http://127.0.0.1:3210', artifact = origin + '/api/artifacts/' + 'a'.repeat(64) + '/content';
  const state = { visible: true, focused: true, minimized: false, destroyed: false, url: origin + '/', authId: device, auth: true, consent: 1, saves: [] as { path: string; bytes: Buffer }[], prompts: [] as any[], calls: [] as any[], asks: [] as string[] };
  const contents: any = new EventEmitter(); contents.mainFrame = {}; contents.getURL = () => state.url; contents.isDestroyed = () => state.destroyed;
  const window: any = new EventEmitter(); window.webContents = contents; window.isVisible = () => state.visible; window.isFocused = () => state.focused; window.isMinimized = () => state.minimized; window.isDestroyed = () => state.destroyed;
  window.destroy = () => { if (!state.destroyed) { state.destroyed = true; contents.emit('destroyed'); window.emit('closed'); } };
  contents.close = window.destroy;
  const timers = new Set<any>(); const setTimer = (fn: any, ms: number) => { const value = { fn, ms }; timers.add(value); return value; }; const clearTimer = (v: any) => timers.delete(v);
  const session: any = { cookies: new EventEmitter(), fetch: async (url: string, init: any) => {
    state.calls.push({ url, init });
    if (url === origin + '/api/auth') return new Response(JSON.stringify({ enabled: true, authenticated: state.auth, session: state.auth ? { id: state.authId } : null }), { headers: { 'content-type': 'application/json' } });
    return new Response('registered bytes', { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="x"', 'content-length': '16', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
  } };
  const dialog: any = { showMessageBox: async (_w: any, opts: any) => { state.prompts.push(opts); return { response: state.consent }; }, showSaveDialog: async (_w: any, opts: any) => { state.prompts.push(opts); return { canceled: false, filePath: '/user/selected/output.txt' }; } };
  const systemPreferences: any = { getMediaAccessStatus: () => 'granted', askForMediaAccess: async (type: string) => { state.asks.push(type); return true; } };
  const controller = createCapabilities({ window, session, dialog, systemPreferences, origin, platform: options.platform || 'linux', save: (path: string, bytes: Buffer) => state.saves.push({ path, bytes: Buffer.from(bytes) }), setTimer, clearTimer });
  const request = (details: any = {}, permission = 'media', wc = contents) => { const answers: boolean[] = []; controller.permissionRequest(wc, permission, (v: boolean) => answers.push(v), { isMainFrame: true, requestingUrl: state.url, securityOrigin: origin, mediaTypes: ['audio'], ...details }); return answers; };
  const item = (override: any = {}) => ({ hasUserGesture: () => true, getInitiatorOrigin: () => origin, getURL: () => artifact, getURLChain: () => [artifact], getMimeType: () => 'application/octet-stream', getContentDisposition: () => 'attachment; filename="result.txt"', getTotalBytes: () => 16, getFilename: () => 'result.txt', ...override });
  let cancelled = 0; const download = (value = item(), wc = contents, frame = contents.mainFrame) => controller.willDownload({ preventDefault() { cancelled++; } }, value, wc, frame);
  return { state, contents, window, session, dialog, controller, systemPreferences, request, download, item, timers, cancelled: () => cancelled };
}
test('HTTPS native capabilities require an authenticated owner and use the selected origin', async () => {
  const remote = 'https://dots.example';
  const good = fixture({ origin: remote });
  const allowed = good.request(); assert.deepEqual(allowed, []); await tick(); assert.deepEqual(allowed, [true]);
  assert.ok(good.state.calls.every(call => call.url.startsWith(remote + '/')));
  good.controller.close();
  for (const action of ['microphone', 'download']) {
    const f = fixture({ origin: remote });
    f.session.fetch = async () => new Response(JSON.stringify({ enabled: false, authenticated: false, session: null }), { headers: { 'content-type': 'application/json' } });
    const answers = action === 'microphone' ? f.request() : (f.download(), []);
    await tick();
    if (action === 'microphone') assert.deepEqual(answers, [false]);
    assert.equal(f.state.prompts.filter(prompt => prompt.type === 'question' || prompt.buttonLabel).length, 0);
    assert.equal(f.state.saves.length, 0); f.controller.close();
  }
});
test('desktop capability URLs are exact and suggested names never supply a directory', () => {
  assert.equal(artifactURL(artifact, origin), true);
  const version = origin + '/api/artifact-documents/doc-12345678-1234-1234-1234-123456789abc/versions/ver-abcdef12-abcd-abcd-abcd-abcdef123456/content';
  assert.equal(artifactURL(version, origin), true);
  for (const value of [version + '?token=x', version + '#fragment', version.replace('/versions/', '/versions/../'), version.replace('doc-', 'other-'), version.replace('127.0.0.1', 'localhost')]) assert.equal(artifactURL(value, origin), false);
  for (const url of [artifact + '?x=1', artifact + '#x', artifact.replace('/api/', '/api/../api/'), artifact.replace('127.0.0.1', 'localhost'), origin + '/api/artifacts/x/content', origin + '/api/uploads/x', 'blob:' + artifact, 'file:///tmp/x']) assert.equal(artifactURL(url, origin), false);
  for (const name of ['../../result.txt', '..\\..\\result.txt']) assert.equal(suggestedName(name), 'result.txt');
  assert.equal(suggestedName('.bashrc'), 'bashrc'); assert.equal(suggestedName('CON.txt'), 'artifact.download'); assert.equal(suggestedName('\0'), '_');
});
test('microphone refuses camera, mixed/unknown media, subframes, wrong origins, background and foreign contents without prompting', async () => {
  const f = fixture();
  for (const details of [{ mediaTypes: ['video'] }, { mediaTypes: ['audio', 'video'] }, { mediaTypes: [] }, { mediaTypes: undefined }, { isMainFrame: false }, { securityOrigin: 'http://localhost:3210/' }, { requestingUrl: origin + '/login' }]) assert.deepEqual(f.request(details), [false]);
  assert.deepEqual(f.request({}, 'notifications'), [false]); assert.deepEqual(f.request({}, 'media', {}), [false]);
  f.state.focused = false; assert.deepEqual(f.request(), [false]); f.state.focused = true; f.state.visible = false; assert.deepEqual(f.request(), [false]); f.state.visible = true; f.state.url = origin + '/login'; assert.deepEqual(f.request(), [false]);
  await tick(); assert.equal(f.state.prompts.length, 0); assert.equal(f.state.calls.length, 0); f.controller.close();
});
test('microphone consent is explicit, default-deny, per-request and authenticated in the same session', async () => {
  const f = fixture(); const answer = f.request(); await tick(); assert.deepEqual(answer, [true]);
  const prompt = f.state.prompts[0]; assert.equal(prompt.defaultId, 0); assert.equal(prompt.cancelId, 0); assert.equal(prompt.buttons[1], '允许本次请求'); assert.equal(prompt.signal instanceof AbortSignal, true);
  assert.equal(f.state.calls.length, 2); for (const call of f.state.calls) { assert.equal(call.init.credentials, 'include'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.headers, undefined); }
  f.state.consent = 0; const denied = f.request(); await tick(); assert.deepEqual(denied, [false]); assert.equal(f.state.prompts.length, 2);
  f.controller.revokeMicrophone(); assert.equal(f.state.destroyed, true); assert.equal(f.session.cookies.listenerCount('changed'), 0);
});
test('pending native consent cannot grant after navigation, hide, close, session change or timeout', async () => {
  for (const change of ['navigate', 'hide', 'close', 'cookie', 'timeout']) {
    const f = fixture(); const dialog = deferred<any>(); f.dialog.showMessageBox = () => dialog.promise;
    const answer = f.request(); await tick(); const second = f.request(); assert.deepEqual(second, [false]);
    if (change === 'navigate') f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    if (change === 'hide') { f.state.visible = false; f.window.emit('hide'); }
    if (change === 'close') f.window.destroy();
    if (change === 'cookie') f.session.cookies.emit('changed', {}, { name: 'opendots_owner_abcd' });
    if (change === 'timeout') [...f.timers].find(t => t.ms === 60_000).fn();
    dialog.resolve({ response: 1 }); await tick(); assert.deepEqual(answer, [false], change); f.controller.close();
  }
});
test('OS microphone permission is asked only after native allow and late approval remains fenced', async () => {
  const f = fixture({ platform: 'darwin' }); let granted = false; const os = deferred<boolean>();
  f.systemPreferences.getMediaAccessStatus = () => granted ? 'granted' : 'not-determined'; f.systemPreferences.askForMediaAccess = (type: string) => { f.state.asks.push(type); return os.promise; };
  f.state.consent = 0; const no = f.request(); await tick(); assert.deepEqual(no, [false]); assert.deepEqual(f.state.asks, []);
  f.state.consent = 1; const answer = f.request(); await tick(); assert.deepEqual(f.state.asks, ['microphone']); f.controller.revokeMicrophone(); granted = true; os.resolve(true); await tick(); assert.deepEqual(answer, [false]); f.controller.close();
  const windows = fixture({ platform: 'win32' }); windows.systemPreferences.getMediaAccessStatus = () => 'denied'; const winAnswer = windows.request(); await tick(); assert.deepEqual(winAnswer, [false]); assert.deepEqual(windows.state.asks, []); windows.controller.close();
});
test('grant rechecks focused current frame and exact authenticated device after dialog', async () => {
  for (const change of ['focus', 'frame', 'device', 'logout']) {
    const f = fixture(); const dialog = deferred<any>(); f.dialog.showMessageBox = () => dialog.promise; const answer = f.request(); await tick();
    if (change === 'focus') f.state.focused = false; if (change === 'frame') f.contents.mainFrame = {}; if (change === 'device') f.state.authId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'; if (change === 'logout') f.state.auth = false;
    dialog.resolve({ response: 1 }); await tick(); assert.deepEqual(answer, [false], change); f.controller.close();
  }
});
test('active microphone is destroyed on native revoke, hide, auth rejection, cookie change and background device revocation', async () => {
  for (const change of ['revoke', 'hide', '401', 'cookie', 'remote']) {
    const f = fixture(); const answer = f.request(); await tick(); assert.deepEqual(answer, [true]);
    if (change === 'revoke') f.controller.revokeMicrophone(); if (change === 'hide') f.window.emit('hide'); if (change === '401') f.controller.observeResponse({ url: origin + '/api/state', statusCode: 401 }); if (change === 'cookie') f.session.cookies.emit('changed', {}, { name: 'opendots_owner_abcd' });
    if (change === 'remote') { f.state.auth = false; await [...f.timers].find(t => t.ms === 1000).fn(); }
    assert.equal(f.state.destroyed, true, change); f.controller.close();
  }
});
test('artifact download cancels default saving and explicitly saves only a verified bounded route', async () => {
  const f = fixture(); f.download(); await tick(); assert.equal(f.cancelled(), 1); assert.equal(f.state.saves.length, 1); assert.equal(f.state.saves[0].bytes.toString(), 'registered bytes'); assert.equal(f.state.saves[0].path, '/user/selected/output.txt');
  const prompt = f.state.prompts[0]; assert.equal(prompt.defaultPath, 'result.txt'); assert.equal(prompt.securityScopedBookmarks, false);
  const downloadCall = f.state.calls.find(c => c.url === artifact); assert.equal(downloadCall.init.credentials, 'include'); assert.equal(downloadCall.init.redirect, 'error'); assert.equal(downloadCall.init.headers, undefined); assert.equal(f.state.calls.filter(c => c.url.endsWith('/api/auth')).length, 3); f.controller.close();
});
test('artifact download refuses foreign initiators, frames, no gesture, redirects and unbounded or non-artifact payloads', async () => {
  const f = fixture();
  for (const override of [{ hasUserGesture: () => false }, { getInitiatorOrigin: () => '' }, { getURL: () => origin + '/api/voice' }, { getURLChain: () => [origin + '/redirect', artifact] }, { getMimeType: () => 'text/html' }, { getTotalBytes: () => MAX_ARTIFACT_BYTES + 1 }, { getContentDisposition: () => 'inline' }]) f.download(f.item(override));
  f.download(f.item(), {}, f.contents.mainFrame); f.download(f.item(), f.contents, {}); await tick(); assert.equal(f.state.prompts.length, 0); assert.equal(f.state.calls.length, 0); assert.equal(f.state.saves.length, 0); f.controller.close();
});
test('save dialog cancellation and navigation/logout/close/timeout races never write or fetch artifact bytes', async () => {
  for (const change of ['cancel', 'navigate', 'logout', 'close', 'timeout']) {
    const f = fixture(); const dialog = deferred<any>(); f.dialog.showSaveDialog = () => dialog.promise; f.download(); await tick();
    if (change === 'navigate') f.contents.emit('did-start-navigation', { isMainFrame: true }); if (change === 'logout') f.controller.observeRequest({ url: origin + '/api/auth/logout', method: 'POST' }); if (change === 'close') f.window.destroy(); if (change === 'timeout') [...f.timers].find(t => t.ms === 120_000).fn();
    dialog.resolve({ canceled: change === 'cancel', filePath: '/selected/never.txt' }); await tick(); assert.equal(f.state.saves.length, 0, change); assert.equal(f.state.calls.some(c => c.url === artifact), false); f.controller.close();
  }
});
test('artifact byte delivery and final auth check remain fenced during native cancellation', async () => {
  for (const change of ['cancel', 'device', 'logout']) {
    const f = fixture(); const response = deferred<Response>(); const fetch = f.session.fetch;
    f.session.fetch = (url: string, init: any) => url === artifact ? response.promise : fetch(url, init);
    f.download(); await tick(); if (change === 'cancel') f.controller.cancelDownload(); if (change === 'device') f.state.authId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'; if (change === 'logout') f.state.auth = false;
    response.resolve(new Response('registered bytes', { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment', 'content-length': '16', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } })); await tick(); assert.equal(f.state.saves.length, 0, change); f.controller.close();
  }
});
test('download response header, declared size and actual size limits fail closed with generic error', async () => {
  for (const override of [{ 'content-type': 'text/html' }, { 'content-length': String(MAX_ARTIFACT_BYTES + 1) }, { 'content-length': '2' }, { 'cache-control': 'public' }, { 'x-content-type-options': '' }, { 'content-disposition': 'inline' }]) {
    const f = fixture(); const fetch = f.session.fetch; f.session.fetch = (url: string, init: any) => url === artifact ? Promise.resolve(new Response('registered bytes', { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment', 'content-length': '16', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...override } })) : fetch(url, init);
    f.download(); await tick(); assert.equal(f.state.saves.length, 0); assert.equal(f.state.prompts.at(-1)?.title, '未保存成果'); f.controller.close();
  }
});
test('exclusive destination writer never overwrites existing or linked files and uses private new files', () => {
  const root = mkdtempSync(join(tmpdir(), 'opendots-save-fixture-')); try {
    const file = join(root, 'result.bin'); saveExclusive(file, Buffer.from('synthetic artifact')); assert.equal(readFileSync(file, 'utf8'), 'synthetic artifact'); if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.throws(() => saveExclusive(file, Buffer.from('replacement'))); assert.equal(readFileSync(file, 'utf8'), 'synthetic artifact');
    const linked = join(root, 'link'); symlinkSync(file, linked); assert.throws(() => saveExclusive(linked, Buffer.from('replacement'))); assert.throws(() => saveExclusive('../relative', Buffer.from('x')));
    writeFileSync(join(root, 'taken'), 'private'); assert.throws(() => saveExclusive(join(root, 'taken', 'path'), Buffer.from('x')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Electron 44 media GURL origin spelling and optional securityOrigin are supported', async () => {
  for (const securityOrigin of [origin + '/', undefined]) { const f = fixture(); const answer = f.request({ securityOrigin }); await tick(); assert.deepEqual(answer, [true]); f.controller.close(); }
});

test('logout mutation can reach the server before capture renderer is destroyed on confirmed response', async () => {
  const f = fixture(); const answer = f.request(); await tick(); assert.deepEqual(answer, [true]);
  const request = { url: origin + '/api/auth/logout', method: 'POST' }; f.controller.observeRequest(request); assert.equal(f.state.destroyed, false);
  f.controller.observeResponse({ ...request, statusCode: 200 }); assert.equal(f.state.destroyed, true); f.controller.close();
});

test('version-specific native save retains exact version route and owner checks', async () => {
  const f = fixture();
  const url = origin + '/api/artifact-documents/doc-12345678-1234-1234-1234-123456789abc/versions/ver-abcdef12-abcd-abcd-abcd-abcdef123456/content';
  f.download(f.item({getURL:()=>url,getURLChain:()=>[url]}));
  await tick();
  assert.equal(f.cancelled(),1);
  assert.equal(f.state.saves.length,1);
  assert.equal(f.state.calls.filter(call=>call.url===url).length,1);
  assert.equal(f.state.calls.filter(call=>call.url.endsWith('/api/auth')).length,3);
  f.controller.close();
});
