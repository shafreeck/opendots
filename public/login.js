'use strict';
const form = document.getElementById('login-form');
const credential = document.getElementById('credential');
const deviceLabel = document.getElementById('device-label');
const submit = document.getElementById('login-submit');
const error = document.getElementById('login-error');
const status = document.getElementById('login-status');
let ready = false;
const busy = value => { credential.disabled = value; deviceLabel.disabled = value; submit.disabled = value; };
const fail = text => { error.textContent = text; error.hidden = false; };
async function initialize() {
  try {
    const response = await fetch('/api/auth', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error();
    const state = await response.json();
    if (!state.enabled || state.authenticated) { location.replace('/'); return; }
    const password = state.credentialKind === 'password';
    document.getElementById('credential-label').textContent = password ? '个人密码' : '个人连接凭据';
    credential.autocomplete = password ? 'current-password' : 'off';
    ready = true; busy(false); status.textContent = '凭据仅提交给当前本地服务，不会进入聊天记录'; credential.focus();
  } catch { status.textContent = '本地服务暂不可用，请确认服务配置后刷新页面'; }
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (!ready || submit.disabled) return;
  error.hidden = true; busy(true);
  let value = credential.value; credential.value = '';
  try {
    const request = fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: value, deviceLabel: deviceLabel.value.trim() }) });
    value = '';
    const response = await request;
    if (response.ok) { location.replace('/'); return; }
    const result = await response.json().catch(() => ({}));
    fail(result.code === 'authentication_try_later' ? '尝试过于频繁，请稍后重试' : result.code === 'authentication_device_limit' ? '设备数量已达上限，请从已登录设备撤销旧会话，或联系本地配置维护者' : '无法登录，请检查凭据或本地服务配置');
  } catch { fail('无法确认登录结果。请刷新页面检查，不会自动重试'); }
  finally { value = ''; credential.value = ''; busy(false); credential.focus(); }
});
window.addEventListener('pagehide', () => { credential.value = ''; });
void initialize();
