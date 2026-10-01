import { checkConnector, connectorGet, connectorKeys, connectorRecord, type ConnectorAdapter, type ConnectorOperation, type Json } from './connector-types.ts';

export const GITHUB_PUBLIC_CONNECTOR = 'github_public';
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const short = (value: unknown, limit: number): string => typeof value === 'string' ? value.slice(0, limit) : '';
const positive = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max;
/** Credential-free GitHub PUBLIC reads. No account, OAuth, cookies, token env,
 * configurable host, arbitrary query, redirects, or write operations exist. */
export class GitHubPublicConnector implements ConnectorAdapter {
  readonly id = GITHUB_PUBLIC_CONNECTOR;
  readonly label = 'GitHub public repositories';
  readonly operations: readonly ConnectorOperation[];
  private repositories: readonly string[]; private fetcher: typeof fetch; private now: () => number;
  private lastSuccessAt: number | null = null;
  constructor(options: { repositories: readonly string[]; fetch?: typeof fetch; now?: () => number }) {
    checkConnector(Array.isArray(options.repositories) && options.repositories.length >= 1 && options.repositories.length <= 50, 'connector_repositories_invalid');
    checkConnector(options.repositories.every(repo => typeof repo === 'string' && REPO.test(repo) && !['.','..'].includes(repo.split('/')[1]!)), 'connector_repositories_invalid');
    this.repositories = Object.freeze([...new Set(options.repositories.map(repo => repo.toLowerCase()))].sort());
    this.fetcher = options.fetch ?? fetch; this.now = options.now ?? Date.now;
    const repo: Json = { type: 'string', enum: [...this.repositories] };
    this.operations = Object.freeze<ConnectorOperation[]>([
      { id: 'get_repo', description: 'Read metadata for one operator-allowlisted public repository.', effect: 'public_read', inputSchema: { type: 'object', additionalProperties: false, required: ['repository'], properties: { repository: repo } } },
      { id: 'list_issues', description: 'Read one bounded page of public repository issues; GitHub also returns pull requests, explicitly labelled in results.', effect: 'public_read', inputSchema: { type: 'object', additionalProperties: false, required: ['repository'], properties: { repository: repo, state: { enum: ['open','closed','all'] }, page: { type: 'integer', minimum: 1, maximum: 100 }, perPage: { type: 'integer', minimum: 1, maximum: 20 } } } },
      { id: 'get_issue', description: 'Read one public issue or pull-request issue record, at a known numeric issue number.', effect: 'public_read', inputSchema: { type: 'object', additionalProperties: false, required: ['repository','number'], properties: { repository: repo, number: { type: 'integer', minimum: 1, maximum: 2_147_483_647 } } } },
    ] satisfies ConnectorOperation[]);
  }
  status(): Record<string, Json> {
    return { access: 'public_data', accountConnected: false, authentication: 'none', state: 'configured', repositories: [...this.repositories], lastSuccessfulReadAt: this.lastSuccessAt, probePerformed: false };
  }
  validate(operation: string, parameters: unknown): Record<string, Json> {
    const p = connectorRecord(parameters);
    if (operation === 'get_repo') connectorKeys(p, ['repository']);
    else if (operation === 'get_issue') { connectorKeys(p, ['repository','number']); checkConnector(positive(p.number, 2_147_483_647)); }
    else { checkConnector(operation === 'list_issues', 'connector_operation_unavailable', 404); connectorKeys(p, ['repository'], ['state','page','perPage']); checkConnector(p.state === undefined || (typeof p.state === 'string' && ['open','closed','all'].includes(p.state))); checkConnector(p.page === undefined || positive(p.page, 100)); checkConnector(p.perPage === undefined || positive(p.perPage, 20)); }
    checkConnector(typeof p.repository === 'string' && this.repositories.includes(p.repository), 'connector_repository_denied', 403);
    return operation === 'list_issues' ? { repository: p.repository, state: (p.state ?? 'open') as string, page: (p.page ?? 1) as number, perPage: (p.perPage ?? 20) as number } : { ...p } as Record<string, Json>;
  }
  private issue(value: unknown, repository: string, bodyLimit: number): Json {
    const v = connectorRecord(value);
    checkConnector(positive(v.number, 2_147_483_647) && ['open','closed'].includes(String(v.state)), 'connector_provider_response_invalid', 502);
    const pullRequest = v.pull_request !== undefined;
    const expected = `https://github.com/${repository}/${pullRequest ? 'pull' : 'issues'}/${v.number}`;
    checkConnector(typeof v.html_url === 'string' && v.html_url.toLowerCase() === expected.toLowerCase(), 'connector_provider_response_invalid', 502);
    return { number: v.number, kind: pullRequest ? 'pull_request' : 'issue', state: v.state as string, title: short(v.title, 500), body: short(v.body, bodyLimit), bodyTruncated: typeof v.body === 'string' && v.body.length > bodyLimit, url: v.html_url, updatedAt: short(v.updated_at, 40) };
  }
  async call(operation: string, parameters: unknown, callerSignal: AbortSignal): Promise<Json> {
    const p = this.validate(operation, parameters), repository = p.repository as string;
    const path = `/repos/${repository.split('/').map(encodeURIComponent).join('/')}`;
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(5_000)]);
    const get = (suffix: string) => connectorGet(this.fetcher, `https://api.github.com${path}${suffix}`, { accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10', 'user-agent': 'opendots-public-connector' }, signal, 1_048_576);
    // Confirm exact public repository on every call; no stale public/private cache.
    const repo = connectorRecord(await get(''));
    checkConnector(repo.private === false && typeof repo.full_name === 'string' && repo.full_name.toLowerCase() === repository && typeof repo.html_url === 'string' && repo.html_url.toLowerCase() === `https://github.com/${repository}`, 'connector_public_repository_unconfirmed', 403);
    let result: Json;
    if (operation === 'get_repo') {
      result = { repository, url: repo.html_url, description: short(repo.description, 2_000), archived: repo.archived === true, defaultBranch: short(repo.default_branch, 200), openIssuesAndPullRequests: Number.isSafeInteger(repo.open_issues_count) && Number(repo.open_issues_count) >= 0 ? repo.open_issues_count as number : null };
    } else if (operation === 'get_issue') {
      const issue = this.issue(await get(`/issues/${p.number}`), repository, 24_000) as Record<string, Json>;
      checkConnector(issue.number === p.number, 'connector_provider_response_invalid', 502); result = { repository, issue };
    } else {
      const query = new URLSearchParams({ state: p.state as string, page: String(p.page), per_page: String(p.perPage), sort: 'updated', direction: 'desc' });
      const issues = await get(`/issues?${query}`);
      checkConnector(Array.isArray(issues) && issues.length <= Number(p.perPage), 'connector_provider_response_invalid', 502);
      result = { repository, page: p.page!, perPage: p.perPage!, includesPullRequests: true, mayHaveMore: issues.length === p.perPage, paginationLimitReached: p.page === 100, issues: issues.map(i => this.issue(i, repository, 2_000)) };
    }
    checkConnector(!signal.aborted, 'connector_request_aborted', 503); this.lastSuccessAt = this.now();
    return { source: 'github_public_rest', accountConnected: false, contentTrust: 'untrusted_external_data', observedAt: this.lastSuccessAt, result };
  }
}
