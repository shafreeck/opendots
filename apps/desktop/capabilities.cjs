'use strict';
// Main-process only. No preload, IPC endpoint, renderer-supplied path or cookie extraction.
const fs = require('node:fs');
const path = require('node:path');
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const CONSENT_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const AUTH_TIMEOUT_MS = 5_000;
function productPage(value, origin) {
  try { const u = new URL(value); return u.origin === origin && !u.username && !u.password && !u.search && ['/', '/index.html'].includes(u.pathname); } catch { return false; }
}
function artifactURL(value, origin) {
  return typeof value === 'string' && new RegExp('^' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/api/(?:artifacts/[a-f0-9]{64}/content|artifact-documents/doc-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/versions/ver-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/content|authored-documents/pdoc-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/versions/pver-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/content)$').test(value);
}
function suggestedName(value) {
  // Untrusted Content-Disposition may suggest a name, never a directory or hidden file.
  const leaf = String(value || '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 100);
  return !leaf || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(leaf) ? 'artifact.download' : leaf;
}
function saveExclusive(destination, bytes) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) throw new Error('save_failed');
  // One synchronous, bounded commit after the last lifetime/auth check. Existing files,
  // symlinks and devices are refused. No overwrite, chmod, directory creation or auto-open.
  const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { if (!fs.fstatSync(fd).isFile()) throw new Error('save_failed'); fs.writeFileSync(fd, bytes); }
  finally { fs.closeSync(fd); }
}
async function boundedBytes(response, limit, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) { void response.body?.cancel().catch(() => {}); throw new Error('response_rejected'); }
  const chunks = []; let size = 0; const reader = response.body?.getReader();
  if (!reader) { if (declared === '0') return Buffer.alloc(0); throw new Error('response_rejected'); }
  try {
    while (true) {
      if (signal.aborted) throw new Error('cancelled');
      const part = await reader.read();
      if (signal.aborted) throw new Error('cancelled');
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error('response_rejected');
      chunks.push(Buffer.from(part.value));
    }
    if (declared !== null && size !== Number(declared)) throw new Error('response_rejected');
    return Buffer.concat(chunks, size);
  } finally {
    // Release any partially buffered sensitive bytes as well as the stream on every exit.
    for (const chunk of chunks) chunk.fill(0);
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
function createCapabilities({ window, session, dialog, systemPreferences, origin, platform = process.platform,
  save = saveExclusive, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const contents = window.webContents;
  let closed = false, disposed = false, generation = 0, pending = null, microphone = null, download = null, authTimer = null;
  const later = (fn, ms) => { const timer = setTimer(fn, ms); timer?.unref?.(); return timer; };
  const live = (snapshot, focus = true) => {
    try { return !closed && !window.isDestroyed() && !contents.isDestroyed() && window.isVisible() && !window.isMinimized() && (!focus || window.isFocused()) && snapshot.generation === generation && snapshot.frame === contents.mainFrame && snapshot.url === contents.getURL() && productPage(snapshot.url, origin); } catch { return false; }
  };
  const snapshot = () => { try { return { generation, frame: contents.mainFrame, url: contents.getURL() }; } catch { return null; } };
  function finishPending(allowed) { const value = pending; if (!value) return; pending = null; clearTimer(value.timer); value.abort.abort(); try { value.callback(allowed); } catch {} }
  function cancelDownload() { if (download) download.abort.abort(); }
  function invalidate() {
    generation++; finishPending(false); cancelDownload();
    if (microphone) {
      microphone.abort.abort(); microphone = null; clearTimer(authTimer); authTimer = null;
      // Denying future checks does not stop an existing MediaStream. Destroy its owner.
      closed = true;
      try { window.destroy(); } catch { try { contents.close({ waitForBeforeUnload: false }); } catch {} }
    }
  }
  async function authIdentity(signal) {
    const timeout = new AbortController(); const timer = later(() => timeout.abort(), AUTH_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout.signal]);
    let bytes;
    try {
      const response = await session.fetch(origin + '/api/auth', { method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store', signal: combined });
      if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new Error('auth_rejected');
      bytes = await boundedBytes(response, 16384, combined);
      const value = JSON.parse(bytes.toString('utf8'));
      if (origin.startsWith('http://127.0.0.1:') && value.enabled === false && value.authenticated === false && value.session === null) return 'local-auth-disabled';
      if (value.enabled === true && value.authenticated === true && typeof value.session?.id === 'string' && /^[a-f0-9-]{36}$/.test(value.session.id)) return value.session.id;
      throw new Error('auth_rejected');
    } finally { clearTimer(timer); bytes?.fill(0); }
  }
  function watchMicrophone(lease) {
    authTimer = later(async () => {
      if (microphone !== lease) return;
      try {
        if (!live(lease.snapshot, false) || await authIdentity(lease.abort.signal) !== lease.identity || !live(lease.snapshot, false)) throw new Error('expired');
        if (microphone === lease) watchMicrophone(lease);
      } catch { if (microphone === lease) invalidate(); }
    }, 1000);
  }
  function permissionRequest(wc, permission, callback, details) {
    const snap = snapshot();
    if (permission !== 'media' || wc !== contents || !live(snap) || details?.isMainFrame !== true || details.requestingUrl !== snap.url || (details.securityOrigin !== undefined && details.securityOrigin !== origin && details.securityOrigin !== origin + '/') || !Array.isArray(details.mediaTypes) || details.mediaTypes.length !== 1 || details.mediaTypes[0] !== 'audio' || pending || download) { callback(false); return; }
    const abort = new AbortController(); const operation = { callback, abort, timer: null };
    pending = operation; operation.timer = later(() => finishPending(false), CONSENT_TIMEOUT_MS);
    void (async () => {
      try {
        const identity = await authIdentity(abort.signal);
        if (pending !== operation || !live(snap)) return;
        const result = await dialog.showMessageBox(window, { type: 'question', title: '允许本次麦克风录音？', message: '允许 opendots 在此窗口使用麦克风？', detail: '仅允许声音，不允许摄像头。录音和发送仍由页面中的按钮控制。隐藏窗口、退出登录或撤销权限会关闭此窗口以停止麦克风；未发送内容可能丢失。', buttons: ['不允许', '允许本次请求'], defaultId: 0, cancelId: 0, noLink: true, signal: abort.signal });
        if (result.response !== 1 || pending !== operation || !live(snap)) return;
        if (platform === 'darwin' || platform === 'win32') {
          let status = systemPreferences.getMediaAccessStatus('microphone');
          if (platform === 'darwin' && status === 'not-determined') {
            if (!await systemPreferences.askForMediaAccess('microphone')) return;
            status = systemPreferences.getMediaAccessStatus('microphone');
          }
          if (status !== 'granted') return;
        }
        if (pending !== operation || !live(snap) || await authIdentity(abort.signal) !== identity || pending !== operation || !live(snap)) return;
        if (microphone) { microphone.abort.abort(); clearTimer(authTimer); }
        const lease = { snapshot: snap, identity, abort: new AbortController() };
        microphone = lease; watchMicrophone(lease); finishPending(true);
      } catch {} finally { if (pending === operation) finishPending(false); }
    })();
  }
  function willDownload(event, item, wc, frame) {
    // Cancel default Electron saving synchronously. The DownloadItem is invalid next tick.
    event.preventDefault();
    const snap = snapshot(); let url, name;
    try {
      if (wc !== contents || frame !== contents.mainFrame || !live(snap) || pending || download || item.hasUserGesture() !== true || item.getInitiatorOrigin() !== origin) return;
      url = item.getURL(); const chain = item.getURLChain();
      if (!artifactURL(url, origin) || !Array.isArray(chain) || chain.length !== 1 || chain[0] !== url || item.getMimeType() !== 'application/octet-stream' || !/^attachment(?:;|$)/i.test(item.getContentDisposition()) || !Number.isSafeInteger(item.getTotalBytes()) || item.getTotalBytes() < 0 || item.getTotalBytes() > MAX_ARTIFACT_BYTES) return;
      name = suggestedName(item.getFilename());
    } catch { return; }
    const abort = new AbortController(); const operation = { abort, snapshot: snap }; download = operation;
    const timer = later(() => abort.abort(), DOWNLOAD_TIMEOUT_MS);
    void (async () => {
      let bytes;
      const assertCurrent = () => { if (abort.signal.aborted || download !== operation || !live(snap)) throw new Error('cancelled'); };
      try {
        const identity = await authIdentity(abort.signal); assertCurrent();
        const choice = await dialog.showSaveDialog(window, { title: '保存 opendots 成果（仅新文件）', buttonLabel: '保存新文件', defaultPath: name, properties: ['showOverwriteConfirmation', 'dontAddToRecent'], securityScopedBookmarks: false });
        if (choice.canceled || !choice.filePath) return;
        assertCurrent();
        if (await authIdentity(abort.signal) !== identity) throw new Error('auth_changed'); assertCurrent();
        const response = await session.fetch(url, { method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store', signal: abort.signal });
        assertCurrent();
        // net.fetch's Response.url is documented as unreliable: redirect:error is the fence.
        if (response.status !== 200 || response.headers.get('content-type') !== 'application/octet-stream' || !/^attachment(?:;|$)/i.test(response.headers.get('content-disposition') || '') || response.headers.get('x-content-type-options') !== 'nosniff' || response.headers.get('cache-control') !== 'no-store' || response.headers.get('content-length') === null) { void response.body?.cancel().catch(() => {}); throw new Error('response_rejected'); }
        bytes = await boundedBytes(response, MAX_ARTIFACT_BYTES, abort.signal); assertCurrent();
        if (await authIdentity(abort.signal) !== identity) throw new Error('auth_changed'); assertCurrent();
        save(choice.filePath, bytes); // No await between the final gate and exclusive commit.
      } catch {
        if (!abort.signal.aborted && live(snap, false)) {
          // Never expose raw filesystem/network errors, download URLs, cookies or paths.
          void dialog.showMessageBox(window, { type: 'error', title: '未保存成果', message: '无法完成保存。请确认仍已登录、文件不超过 32 MiB，并选择尚不存在的新文件名。若磁盘写入中断，请自行检查所选位置是否有不完整文件。', buttons: ['好'], noLink: true }).catch(() => {});
        }
      } finally { clearTimer(timer); abort.abort(); bytes?.fill(0); if (download === operation) download = null; }
    })();
  }
  // Do not destroy the renderer before its logout POST reaches the server. Cancel
  // pending capability work at admission, and tear down granted capture on the reply.
  function observeRequest(details) {
    try { const u = new URL(details.url); if (u.origin === origin && details.method === 'POST' && u.pathname.startsWith('/api/auth/')) { finishPending(false); cancelDownload(); } } catch {}
  }
  function observeResponse(details) { try { const u = new URL(details.url); if (u.origin === origin && (details.statusCode === 401 || (details.method === 'POST' && u.pathname.startsWith('/api/auth/') && details.statusCode >= 200 && details.statusCode < 300))) invalidate(); } catch {} }
  const navigation = event => { if (event.isMainFrame) invalidate(); };
  const close = () => { if (disposed) return; disposed = true; invalidate(); closed = true; clearTimer(authTimer); session.cookies?.off('changed', cookieChanged); };
  const cookieChanged = (_event, cookie) => { if (/^(?:__Host-)?opendots_owner_/.test(cookie?.name || '')) invalidate(); };
  contents.on('did-start-navigation', navigation);
  contents.on('render-process-gone', close); contents.on('destroyed', close);
  window.on('hide', invalidate); window.on('minimize', invalidate); window.on('close', close); window.on('closed', close);
  session.cookies?.on('changed', cookieChanged);
  return Object.freeze({ permissionRequest, willDownload, observeRequest, observeResponse, cancelDownload, revokeMicrophone: invalidate, close });
}
module.exports = { createCapabilities, productPage, artifactURL, suggestedName, saveExclusive, MAX_ARTIFACT_BYTES };
