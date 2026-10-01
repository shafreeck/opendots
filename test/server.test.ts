import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { createApplication } from '../src/server.ts';

async function fixture(t: test.TestContext, startWorker = true) {
  const directory = mkdtempSync(join(tmpdir(), 'opendots-http-'));
  const app = createApplication({ mode: 'demo', dbPath: join(directory, 'demo.sqlite'), startWorker, simulationMs: 600 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const state = async () => (await fetch(`${origin}/api/state`)).json();
  const initial = await state();
  const post = (path: string, body: object, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-opendots-csrf': initial.csrfToken, ...headers }, body: JSON.stringify(body),
  });
  return { app, origin, state, post };
}
async function eventually(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  assert.fail(`Timed out: ${label}`);
}

test('HTTP demo remains responsive while separate worker completes durable simulated delivery', async t => {
  const { state, post } = await fixture(t);
  await eventually(async () => (await state()).workerStatus === 'ready', 'worker readiness');
  const first = await post('/api/jobs', { prompt: 'Send a simulated update', idempotencyKey: 'http-demo-job', requireApproval: false });
  assert.equal(first.status, 202);
  const job = await first.json();
  const repeated = await post('/api/jobs', { prompt: 'Send a simulated update', idempotencyKey: 'http-demo-job', requireApproval: false });
  assert.equal((await repeated.json()).id, job.id);
  await eventually(async () => (await state()).jobs[0].status === 'running', 'running delivery');
  const chat = await post('/api/chat', { text: 'Can I still chat?', idempotencyKey: 'http-chat-key' });
  assert.equal(chat.status, 200);
  const during = await state();
  assert.equal(during.mode, 'demo');
  assert.equal(during.messages.length, 2);
  assert.equal(during.jobs[0].status, 'running');
  await eventually(async () => (await state()).jobs[0].status === 'completed', 'completed simulation');
  const done = await state();
  assert.equal(done.jobs.length, 1);
  assert.equal(done.messages.length, 3);
  assert.match(done.messages[2].text, /No model or Morphz runtime/);
  assert.ok(done.audit.some((entry: { event: string }) => entry.event === 'delivery.simulated_complete'));
});

test('HTTP approval gate blocks worker until approved and denial cancels', async t => {
  const { state, post } = await fixture(t);
  const response = await post('/api/jobs', { prompt: 'Needs permission', idempotencyKey: 'http-approval', requireApproval: true });
  const job = await response.json();
  await sleep(350);
  assert.equal((await state()).jobs[0].status, 'awaiting_approval');
  assert.equal((await post(`/api/jobs/${job.id}/decision`, { decision: 'approve' })).status, 200);
  await eventually(async () => (await state()).jobs[0].status === 'completed', 'approved simulation');
  const second = await (await post('/api/jobs', { prompt: 'Denied delivery', idempotencyKey: 'http-denied-job', requireApproval: true })).json();
  assert.equal((await post(`/api/jobs/${second.id}/decision`, { decision: 'deny' })).status, 200);
  assert.equal((await post(`/api/jobs/${second.id}/decision`, { decision: 'approve' })).status, 409);
  assert.equal((await state()).jobs.find((value: { id: string }) => value.id === second.id).status, 'cancelled');
});

test('local HTTP enforces host, origin, CSRF, JSON shape, payload limit and safe static paths', async t => {
  const { origin, post, state } = await fixture(t, false);
  const request = { text: 'hello', idempotencyKey: 'http-safe-key' };
  assert.equal((await post('/api/chat', request, { 'x-opendots-csrf': '' })).status, 403);
  assert.equal((await post('/api/chat', request, { origin: 'https://foreign.example' })).status, 403);
  const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(`${origin}/api/state`, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await post('/api/chat', request, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post('/api/chat', request, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/chat', { ...request, text: 'x'.repeat(18000) })).status, 413);
  assert.equal((await post('/api/chat', { text: '', idempotencyKey: 'short' })).status, 400);
  assert.equal((await post('/api/chat', request)).status, 200);
  assert.equal((await post('/api/chat', { ...request, text: 'different' })).status, 409);
  assert.equal((await fetch(`${origin}/src/store.ts`)).status, 404);
  const html = await fetch(origin);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(html.headers.get('access-control-allow-origin'), null);
  assert.match(await html.text(), /opendots/);
  assert.match((await state()).disclaimer, /Simulation only/);
});
