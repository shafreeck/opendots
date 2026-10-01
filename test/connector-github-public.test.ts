import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubPublicConnector } from '../src/connector-github-public.ts';
import { ConnectorError } from '../src/connector-types.ts';

const repository = 'morphz-ai/morphz';
const repo = { private: false, full_name: repository, html_url: `https://github.com/${repository}`, archived: false, description: 'Public repo', default_branch: 'main', open_issues_count: 2, temp_clone_token: 'DO_NOT_EXPOSE', headers: { authorization: 'DO_NOT_EXPOSE' } };
const issue = { number: 3, state: 'open', title: 'Issue', body: 'Public body', html_url: `https://github.com/${repository}/issues/3`, updated_at: '2026-09-30T00:00:00Z', user: { email: 'DO_NOT_EXPOSE' } };
const signal = () => new AbortController().signal;
test('public GitHub catalogue/status is honest and performs no network probe', () => {
  const connector = new GitHubPublicConnector({ repositories: [repository], fetch: async () => { throw Error('no call'); } });
  assert.deepEqual(connector.operations.map(o => o.id), ['get_repo','list_issues','get_issue']);
  assert.equal(connector.status().accountConnected, false); assert.equal(connector.status().lastSuccessfulReadAt, null);
  assert.equal(connector.status().probePerformed, false);
});
test('public GitHub GET uses exact official host/version and no credentials', async () => {
  const calls: string[] = [];
  const connector = new GitHubPublicConnector({ repositories: [repository], now: () => 123, fetch: async (url, init) => {
    calls.push(String(url)); assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.body, undefined);
    const headers = new Headers(init?.headers); assert.equal(headers.get('authorization'), null); assert.equal(headers.get('cookie'), null); assert.equal(headers.get('x-github-api-version'), '2026-03-10');
    return Response.json(repo);
  } });
  const result = await connector.call('get_repo', { repository }, signal());
  assert.deepEqual(calls, ['https://api.github.com/repos/morphz-ai/morphz']);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPOSE')); assert.equal(connector.status().lastSuccessfulReadAt, 123);
});
test('public read accepts only fixed repositories, operations, enums and bounded numbers', async () => {
  let calls = 0; const connector = new GitHubPublicConnector({ repositories: [repository], fetch: async () => { calls++; return Response.json(repo); } });
  for (const parameters of [{ repository: 'other/private' }, { repository, url: 'https://evil.test' }, { repository, headers: {} }, { repository, page: 101 }, { repository, perPage: 21 }, { repository, state: ['open'] }]) await assert.rejects(connector.call('list_issues', parameters, signal()), ConnectorError);
  for (const n of [0,-1,1.1,2_147_483_648]) await assert.rejects(connector.call('get_issue', { repository, number: n }, signal()), ConnectorError);
  await assert.rejects(connector.call('create_issue', { repository }, signal()), ConnectorError);
  assert.equal(calls, 0);
  for (const bad of ['https://github.com/a/b','a/..','a/b?key=secret','a/b/c','../b']) assert.throws(() => new GitHubPublicConnector({ repositories: [bad] }), ConnectorError);
});
test('list pages are bounded and include labelled pull requests without hidden pagination', async () => {
  const calls: string[] = []; const pr = { ...issue, number: 4, pull_request: {}, html_url: `https://github.com/${repository}/pull/4`, body: 'x'.repeat(3_000) };
  const connector = new GitHubPublicConnector({ repositories: [repository], fetch: async url => { calls.push(String(url)); return Response.json(calls.length === 1 ? repo : [issue, pr]); } });
  const result = await connector.call('list_issues', { repository, page: 2, perPage: 2, state: 'all' }, signal()) as any;
  assert.equal(calls.length, 2); assert.equal(calls[1], 'https://api.github.com/repos/morphz-ai/morphz/issues?state=all&page=2&per_page=2&sort=updated&direction=desc');
  assert.equal(result.result.issues[1].kind, 'pull_request'); assert.equal(result.result.issues[1].bodyTruncated, true); assert.equal(result.result.mayHaveMore, true);
  assert.equal(result.contentTrust, 'untrusted_external_data'); assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPOSE'));
});
test('get_issue checks exact numeric result and rejects swapped repo/private data', async () => {
  for (const badRepo of [{ ...repo, private: true }, { ...repo, full_name: 'elsewhere/repo' }, { ...repo, html_url: 'https://evil.test' }]) {
    let calls = 0; const connector = new GitHubPublicConnector({ repositories: [repository], fetch: async () => { calls++; return Response.json(badRepo); } });
    await assert.rejects(connector.call('get_issue', { repository, number: 3 }, signal()), ConnectorError); assert.equal(calls, 1);
  }
  const connector = new GitHubPublicConnector({ repositories: [repository], fetch: async url => Response.json(String(url).endsWith('/issues/3') ? { ...issue, number: 4 } : repo) });
  await assert.rejects(connector.call('get_issue', { repository, number: 3 }, signal()), ConnectorError);
});
test('upstream redirects/rate limits/errors/oversize fail safely with no retry or body leakage', async () => {
  for (const response of [new Response('SECRET_BODY', { status: 403 }), new Response('SECRET_BODY', { status: 302, headers: { location: 'https://evil.test' } }), new Response('x', { headers: { 'content-length': '1048577' } }), new Response('not JSON SECRET_BODY')]) {
    let calls = 0; const connector = new GitHubPublicConnector({ repositories: [repository], fetch: async () => { calls++; return response; } });
    await assert.rejects(connector.call('get_repo', { repository }, signal()), e => e instanceof ConnectorError && !e.message.includes('SECRET')); assert.equal(calls, 1); assert.equal(connector.status().lastSuccessfulReadAt, null);
  }
});
test('aborted calls do not emit a request or expose abort reason', async () => {
  let calls = 0; const c = new AbortController(); c.abort(Error('SECRET_REASON'));
  const connector = new GitHubPublicConnector({ repositories: [repository], fetch: async () => { calls++; return Response.json(repo); } });
  await assert.rejects(connector.call('get_repo', { repository }, c.signal), e => e instanceof ConnectorError && !e.message.includes('SECRET')); assert.equal(calls, 0);
});
test('live anonymous GitHub public repository read (explicit opt-in)', { skip: process.env.OPENDOTS_CONNECTOR_LIVE !== '1' }, async () => {
  const connector = new GitHubPublicConnector({ repositories: [repository] });
  const result = await connector.call('get_repo', { repository }, signal()) as any;
  assert.equal(result.result.repository, repository); assert.equal(result.accountConnected, false);
  console.log(JSON.stringify({ verification: 'live_public_github_get_repo', repository: result.result.repository, url: result.result.url, accountConnected: false }));
});
