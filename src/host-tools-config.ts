import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';
import { validateConnectorConfig } from './connector-config.ts';
import { GitHubPublicConnector } from './connector-github-public.ts';
import { ConnectorError, checkConnector, connectorBinding, connectorId, connectorKeys, connectorRecord, type ConnectorBinding } from './connector-types.ts';

export interface GithubPublicHostToolConfig {
  readonly callbackToken: string;
  readonly allowPublicGithubReads: true;
  readonly repositories: readonly string[];
}
export interface CalendarProposalsHostToolConfig {
  readonly callbackToken: string;
  readonly allowProposals: true;
}
/** Normalized, server-owned config from one explicitly selected private file. */
export interface HostToolsConfig {
  readonly sourceVersion: 1 | 2;
  readonly ownerId: string;
  readonly runtimeOrigin: string;
  readonly binding: Readonly<ConnectorBinding>;
  readonly callbackPort: number;
  readonly tools: Readonly<{
    githubPublic?: Readonly<GithubPublicHostToolConfig>;
    calendarProposals?: Readonly<CalendarProposalsHostToolConfig>;
  }>;
}

const token = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{32,1024}$/.test(value);

/** Validate only supplied data; never discovers, generates, or writes credentials. */
export function validateHostToolsConfig(value: unknown): HostToolsConfig {
  try {
    const c = connectorRecord(value);
    if (c.version === 1) {
      const old = validateConnectorConfig(value);
      return Object.freeze({
        sourceVersion: 1, ownerId: old.ownerId, runtimeOrigin: old.runtimeOrigin,
        binding: old.binding, callbackPort: old.callbackPort,
        tools: Object.freeze({ githubPublic: Object.freeze({ callbackToken: old.callbackToken, allowPublicGithubReads: true, repositories: old.repositories }) }),
      });
    }
    connectorKeys(c, ['version', 'ownerId', 'runtimeOrigin', 'binding', 'callbackPort', 'tools']);
    checkConnector(c.version === 2 && connectorId(c.ownerId), 'host_tools_configuration_invalid');
    const binding = connectorBinding(c.binding as ConnectorBinding);
    checkConnector(typeof c.runtimeOrigin === 'string', 'host_tools_configuration_invalid');
    let origin: URL;
    try { origin = new URL(c.runtimeOrigin); } catch { throw new ConnectorError('host_tools_configuration_invalid'); }
    checkConnector(origin.origin === c.runtimeOrigin && ['http:', 'https:'].includes(origin.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && !origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/', 'host_tools_configuration_invalid');
    checkConnector(Number.isInteger(c.callbackPort) && Number(c.callbackPort) >= 1024 && Number(c.callbackPort) <= 65535, 'host_tools_configuration_invalid');
    const configured = connectorRecord(c.tools);
    connectorKeys(configured, [], ['githubPublic', 'calendarProposals']);
    checkConnector(Object.keys(configured).length >= 1, 'host_tools_configuration_invalid');
    const tools: { githubPublic?: Readonly<GithubPublicHostToolConfig>; calendarProposals?: Readonly<CalendarProposalsHostToolConfig> } = {};
    if (Object.hasOwn(configured, 'githubPublic')) {
      const github = connectorRecord(configured.githubPublic);
      connectorKeys(github, ['callbackToken', 'allowPublicGithubReads', 'repositories']);
      checkConnector(token(github.callbackToken) && github.allowPublicGithubReads === true, 'host_tools_configuration_invalid');
      const adapter = new GitHubPublicConnector({ repositories: github.repositories as string[] });
      const repositories = adapter.status().repositories as string[];
      checkConnector(JSON.stringify(github.repositories) === JSON.stringify(repositories), 'connector_repositories_require_sorted_lowercase');
      tools.githubPublic = Object.freeze({ callbackToken: github.callbackToken, allowPublicGithubReads: true, repositories: Object.freeze([...repositories]) });
    }
    if (Object.hasOwn(configured, 'calendarProposals')) {
      const calendar = connectorRecord(configured.calendarProposals);
      connectorKeys(calendar, ['callbackToken', 'allowProposals']);
      checkConnector(token(calendar.callbackToken) && calendar.allowProposals === true, 'host_tools_configuration_invalid');
      tools.calendarProposals = Object.freeze({ callbackToken: calendar.callbackToken, allowProposals: true });
    }
    checkConnector(!tools.githubPublic || !tools.calendarProposals || tools.githubPublic.callbackToken !== tools.calendarProposals.callbackToken, 'host_tools_configuration_tokens_must_differ');
    return Object.freeze({ sourceVersion: 2, ownerId: c.ownerId, runtimeOrigin: c.runtimeOrigin, binding, callbackPort: Number(c.callbackPort), tools: Object.freeze(tools) });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError('host_tools_configuration_invalid');
  }
}

function unchanged(a: Stats, b: Stats) {
  return a.ino === b.ino && a.dev === b.dev && a.mode === b.mode && a.uid === b.uid && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Read exactly one explicit private file. No discovery, fallback, writes, chmod,
 * token generation, pairing, or host-manifest changes occur here. */
export function readHostToolsConfig(path: string): HostToolsConfig {
  checkConnector(typeof path === 'string' && path.length <= 1024 && isAbsolute(path) && normalize(path) === path && !/[\x00-\x1f\x7f]/.test(path), 'host_tools_configuration_path_invalid');
  checkConnector(process.platform === 'linux' && typeof process.geteuid === 'function', 'host_tools_configuration_platform_unsupported');
  let fd: number | undefined;
  const bytes = Buffer.alloc(16_385);
  try {
    const uid = process.geteuid();
    const parents = () => {
      for (let parent = dirname(path);;) {
        const info = lstatSync(parent);
        checkConnector(info.isDirectory() && !info.isSymbolicLink() && [0, uid].includes(info.uid) && ((info.mode & 0o022) === 0 || (info.uid === 0 && (info.mode & 0o1000) !== 0)), 'host_tools_configuration_path_untrusted');
        if (parent === dirname(parent)) break;
        parent = dirname(parent);
      }
    };
    const safe = (info: Stats) => checkConnector(info.isFile() && info.nlink === 1 && info.uid === uid && info.size > 0 && info.size <= 16_384 && (info.mode & 0o7177) === 0 && (info.mode & 0o400) !== 0, 'host_tools_configuration_file_invalid');
    parents();
    const before = lstatSync(path); safe(before);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd); safe(opened);
    checkConnector(unchanged(before, opened), 'host_tools_configuration_changed');
    let length = 0;
    for (;;) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
      checkConnector(length <= 16_384, 'host_tools_configuration_file_invalid');
    }
    checkConnector(unchanged(opened, fstatSync(fd)) && unchanged(opened, lstatSync(path)), 'host_tools_configuration_changed');
    parents();
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { throw new ConnectorError('host_tools_configuration_invalid'); }
    return validateHostToolsConfig(parsed);
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError('host_tools_configuration_unavailable', 503);
  } finally {
    bytes.fill(0);
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}
