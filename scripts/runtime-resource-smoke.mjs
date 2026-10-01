/** Actual Runtime immutable-resource test. The controlled PNG is staged through
 * the official API, then committed as INPUT and OUTPUT-copy resources. A raw write-tool file
 * is not a deliverable, and this test does not claim an application upload UI.
 * Isolated configuration and loopback deterministic provider; zero paid calls.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/server.ts';
const binary = process.env.OPENDOTS_RUNTIME_BINARY;
if (!binary || !existsSync(binary)) throw Error('Set OPENDOTS_RUNTIME_BINARY to a verified pinned Morphz binary.');
const root = mkdtempSync(join(tmpdir(), 'opendots-real-resource-'));
const token = randomBytes(32).toString('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT3sAAAAASUVORK5CYII=', 'base64');
const checksum = createHash('sha256').update(png).digest('hex');
let runtime; let app; let appOrigin; let providerCalls = 0; let boundSession; let outputDelivered = false;
const provider = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString()); providerCalls++;
  let tool;
  if (!outputDelivered) {
    const page = await api(`/api/sessions/${boundSession}/io/events`);
    const original = page.events.flatMap(event => event.binding?.resources ?? event.resources ?? [])[0];
    assert.ok(original?.resource_id, 'The output tool must reuse a real registered resource');
    tool = { id: 'fixture-deliver-resource', type: 'function', function: { name: 'deliver_message', arguments: JSON.stringify({ delivery_id: 'fixture-registered-output', message: { format: { id: 'morphz.chat', version: '1' }, content: { encoding: 'json', value: { text: 'Registered output copy of the controlled PNG.', attachments: [{ resource_id: original.resource_id }] } } } }) } };
    outputDelivered = true;
  }
  const message = tool ? { role: 'assistant', content: '', tool_calls: [tool] } : { role: 'assistant', content: 'REGISTERED_RESOURCE_RECEIVED' };
  const finish = tool ? 'tool_calls' : 'stop';
  if (input.stream) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [{ ...tool, index: 0 }] } : message, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`); }
  else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: randomUUID(), choices: [{ index: 0, message, finish_reason: finish }] })); }
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await listen(provider); const providerPort = provider.address().port;
const probe = createServer(); await listen(probe); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`; const config = join(root, 'runtime.toml');
writeFileSync(config, `[llm]\nmodel="fixture"\n[accounts.fixture]\nauth_adapter="none"\nprovider="fixture"\n[services.fixture]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["fixture"]\n[[models.fixture.targets]]\nservice="fixture"\naccount="fixture"\nphysical_model="fixture"\ncapabilities=["tools","image"]\n[permissions]\nmode="request_approval"\nworkspace_root=${JSON.stringify(root)}\nnetwork=false\nread_only_outside_workspace=false\n[background_task]\nartifact_dir=${JSON.stringify(join(root, 'artifacts'))}\n`, { mode: 0o600 });
async function api(path, body, method = body ? 'POST' : 'GET', binary = false) {
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': binary ? 'application/octet-stream' : 'application/json', ...(binary ? { 'x-morphz-upload-offset': '0' } : {}) }, body: body ? binary ? body : JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  const result = await response.json(); if (!response.ok) throw Error(`Runtime HTTP ${response.status} on ${path}: ${JSON.stringify(result)}`); return result;
}
async function wait(check, label) { const end = Date.now() + 20_000; while (Date.now() < end) { if (runtime.exitCode !== null) throw Error('Runtime exited before ' + label); if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('Timed out waiting for ' + label); }
async function launchApp() { app = createApplication({ dbPath: join(root, 'product.db'), baseUrl: origin, operatorToken: token, pollIntervalMs: 150 }); await listen(app.server); appOrigin = `http://127.0.0.1:${app.server.address().port}`; await wait(() => app.runtime.status.status === 'ready', 'product bootstrap'); }
try {
  runtime = spawn(resolve(binary), ['serve', '--bind', `127.0.0.1:${port}`, '--cwd', root, '--config-file', config, '--log-level', 'warn'], { cwd: root, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, MORPHZ_HOME: join(root, 'home'), MORPHZ_DASHBOARD_TOKEN: token, MORPHZ_STORAGE_SQLITE_PATH: join(root, 'runtime.db'), LANG: 'C.UTF-8' }, stdio: ['ignore', 'ignore', 'ignore'] });
  await wait(async () => { try { return (await api('/api/session-io/capabilities')).enabled; } catch { return false; } }, 'Runtime readiness');
  await launchApp(); await app.runtime.bindProvider({ accountId: 'fixture' });
  const session = app.runtime.snapshot().sessionId; boundSession = session;
  const product = async (path, body, binary = false, offset = 0) => {
    const state = await (await fetch(appOrigin + '/api/state')).json();
    const response = await fetch(appOrigin + path, { method: 'POST', headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json', 'x-opendots-csrf': state.csrfToken, ...(binary ? { 'x-opendots-upload-offset': String(offset) } : {}) }, body: binary ? body : JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw Error(`Product HTTP ${response.status}: ${JSON.stringify(result)}`); return result;
  };
  const declaration = { draftKey: 'resource-draft-fixture', uploadKey: 'resource-upload-fixture', name: 'proof.png', mediaType: 'image/png', sizeBytes: png.byteLength, sha256: checksum };
  const upload = await product('/api/uploads', declaration);
  assert.equal((await product('/api/uploads', declaration)).id, upload.id, 'Same declaration retry retains native stage');
  await assert.rejects(() => product(`/api/uploads/${upload.id}/content`, Buffer.alloc(256 * 1024 + 1), true), /Product HTTP 413/, 'Product bounds chunks before native dispatch');
  const firstChunk = png.subarray(0, 24);
  const partial = await product(`/api/uploads/${upload.id}/content`, firstChunk, true);
  assert.equal(partial.offset, 24);
  await app.close(); app = undefined; await launchApp();
  const reconciled = await product(`/api/uploads/${upload.id}/reconcile`, {});
  assert.equal(reconciled.offset, 24, 'Host restart recovers actual native partial offset');
  const uploaded = await product(`/api/uploads/${upload.id}/content`, png.subarray(24), true, 24);
  assert.equal(uploaded.status, 'ready');
  const message = { text: 'Acknowledge the controlled registered PNG.', idempotencyKey: 'resource-message-fixture', draftKey: declaration.draftKey, uploadIds: [upload.id] };
  const admitted = await product('/api/chat', message);
  assert.equal(admitted.status, 'accepted');
  assert.equal((await product('/api/chat', message)).id, admitted.id, 'Retry preserves exact command');
  await assert.rejects(() => product('/api/chat', { ...message, idempotencyKey: 'resource-other-command' }), /Product HTTP 409/, 'A sealed draft cannot create another message command');
  await assert.rejects(() => product('/api/chat', { ...message, text: 'Changed text' }), /Product HTTP 409/, 'A message retry cannot change content');
  await assert.rejects(() => product(`/api/uploads/${upload.id}/cancel`, {}), /Product HTTP 409/, 'A sealed attachment cannot be cancelled through draft controls');
  let listing;
  await wait(async () => { listing = await (await fetch(appOrigin + '/api/artifacts')).json(); return listing.artifacts?.some(artifact => artifact.origin === 'input'); }, 'typed IO resource projection');
  const artifact = listing.artifacts.find(artifact => artifact.origin === 'input'); assert.equal(artifact.origin, 'input'); assert.equal(artifact.name, 'proof.png'); assert.equal(artifact.sha256, checksum); assert.equal(artifact.sourceEventId, admitted.receipt.event_id);
  assert.ok(!JSON.stringify(listing).includes(root), 'Storage paths must not enter the public catalog');
  const download = await fetch(appOrigin + artifact.downloadPath); assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'application/octet-stream'); assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.equal(download.headers.get('cache-control'), 'no-store'); assert.equal(download.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  assert.equal((await fetch(appOrigin + '/api/artifacts/' + '0'.repeat(64) + '/content')).status, 404);
  await wait(async () => { listing = await (await fetch(appOrigin + '/api/artifacts')).json(); return listing.artifacts?.some(value => value.origin === 'output'); }, 'actual deliver_message registered output');
  const delivered = listing.artifacts.find(value => value.origin === 'output');
  assert.notEqual(delivered.id, artifact.id); assert.notEqual(delivered.sourceEventId, artifact.sourceEventId); assert.equal(delivered.sha256, checksum);
  assert.deepEqual(Buffer.from(await (await fetch(appOrigin + delivered.downloadPath)).arrayBuffer()), png);

  const documentInput = {title:'Native resource lineage proof',artifactId:artifact.id,note:'Original uploaded PNG',idempotencyKey:'fixture-document-create'};
  const firstVersion = await product('/api/artifact-documents',documentInput);
  const versionInput = {artifactId:delivered.id,note:'Registered output copy; identical bytes, distinct native provenance',expectedRevision:1,parentVersionId:firstVersion.version.id,idempotencyKey:'fixture-document-append'};
  const secondVersion = await product(`/api/artifact-documents/${firstVersion.documentAtAdmission.id}/versions`,versionInput);
  assert.equal(secondVersion.version.parentVersionId,firstVersion.version.id);assert.equal(secondVersion.version.revision,2);
  assert.notEqual(secondVersion.version.artifact.sourceEventId,firstVersion.version.artifact.sourceEventId);
  assert.deepEqual(Buffer.from(await(await fetch(appOrigin+secondVersion.version.downloadPath)).arrayBuffer()),png);
  await app.close(); app = undefined; await launchApp();
  assert.deepEqual(await product('/api/artifact-documents',documentInput),firstVersion,'Original version admission receipt survives newer head and host restart');
  const versionHistory=await(await fetch(appOrigin+`/api/artifact-documents/${firstVersion.documentAtAdmission.id}`)).json();
  assert.deepEqual(versionHistory.versions.map(value=>value.id),[firstVersion.version.id,secondVersion.version.id]);
  assert.equal(versionHistory.document.revision,2);
  assert.equal((await product('/api/chat', message)).id, admitted.id, 'Consumed-stage message retry survives restart');
  const restored = await (await fetch(appOrigin + '/api/artifacts')).json(); assert.ok(restored.artifacts.some(value => value.id === artifact.id)); assert.ok(restored.artifacts.some(value => value.id === delivered.id)); assert.deepEqual(Buffer.from(await (await fetch(appOrigin + artifact.downloadPath)).arrayBuffer()), png);
  console.log(JSON.stringify({ level: 'L2', result: 'passed', resourceKind: 'registered_input_and_output_copy', verified: ['product upload declaration retry', 'partial upload survives host restart with native offset', 'native staged bytes with expected SHA-256', 'atomic attachment command and exact retry', 'typed IO event resource provenance', 'opaque product resource ID', 'actual deliver_message registers immutable output copy', 'authorized inert attachment response', 'exact downloaded bytes and hash', 'unknown resource denied', 'host restart preserves identity and bytes', 'owner document versions preserve exact native provenance and parent lineage', 'original version admission receipt survives newer head and restart'], paidCalls: 0, providerCalls }, null, 2));
} catch (error) { console.error('Runtime resource smoke failed:', error.message); process.exitCode = 1; }
finally { if (app) await app.close(); if (runtime && runtime.exitCode === null) { runtime.kill('SIGTERM'); await new Promise(resolve => runtime.once('exit', resolve)); } await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true }); }
