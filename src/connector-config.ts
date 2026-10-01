import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';
import { ConnectorError, checkConnector, connectorBinding, connectorId, connectorKeys, connectorRecord, type ConnectorBinding } from './connector-types.ts';
import { GitHubPublicConnector } from './connector-github-public.ts';

/** Explicit private operator config only. Not a browser/model request DTO. */
export interface ConnectorConfig {
  readonly version: 1;
  readonly ownerId: string;
  readonly runtimeOrigin: string;
  readonly binding: Readonly<ConnectorBinding>;
  readonly callbackPort: number;
  readonly callbackToken: string;
  readonly allowPublicGithubReads: true;
  readonly repositories: readonly string[];
}
export function validateConnectorConfig(value: unknown): ConnectorConfig {
  const c = connectorRecord(value);
  connectorKeys(c, ['version','ownerId','runtimeOrigin','binding','callbackPort','callbackToken','allowPublicGithubReads','repositories']);
  checkConnector(c.version === 1 && c.allowPublicGithubReads === true && connectorId(c.ownerId), 'connector_configuration_invalid');
  const binding = connectorBinding(c.binding as ConnectorBinding);
  let origin: URL; try { origin = new URL(c.runtimeOrigin as string); } catch { throw new ConnectorError('connector_configuration_invalid'); }
  checkConnector(typeof c.runtimeOrigin === 'string' && origin.origin === c.runtimeOrigin && ['http:','https:'].includes(origin.protocol) && ['127.0.0.1','localhost','[::1]'].includes(origin.hostname) && !origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/', 'connector_configuration_invalid');
  checkConnector(Number.isInteger(c.callbackPort) && Number(c.callbackPort) >= 1024 && Number(c.callbackPort) <= 65535 && typeof c.callbackToken === 'string' && /^[\x21-\x7e]{32,1024}$/.test(c.callbackToken), 'connector_configuration_invalid');
  const adapter = new GitHubPublicConnector({ repositories: c.repositories as string[] });
  const repositories = adapter.status().repositories as string[];
  checkConnector(JSON.stringify(c.repositories) === JSON.stringify(repositories), 'connector_repositories_require_sorted_lowercase');
  return Object.freeze({ version: 1, ownerId: c.ownerId, runtimeOrigin: c.runtimeOrigin, binding, callbackPort: Number(c.callbackPort), callbackToken: c.callbackToken, allowPublicGithubReads: true, repositories: Object.freeze([...repositories]) });
}
function unchanged(a: Stats, b: Stats) { return a.ino === b.ino && a.dev === b.dev && a.mode === b.mode && a.uid === b.uid && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
/** Read exactly one explicitly supplied private file. No credential discovery,
 * fallback, chmod, writes, generation, pairing or host-manifest modification. */
export function readConnectorConfig(path: string): ConnectorConfig {
  checkConnector(typeof path === 'string' && path.length <= 1024 && isAbsolute(path) && normalize(path) === path && !/[\x00-\x1f\x7f]/.test(path), 'connector_configuration_path_invalid');
  checkConnector(process.platform === 'linux' && typeof process.geteuid === 'function', 'connector_configuration_platform_unsupported');
  let fd: number | undefined; const bytes = Buffer.alloc(16_385);
  try {
    const uid = process.geteuid();
    const parents = () => {
      for (let parent = dirname(path);;) {
        const info = lstatSync(parent);
        checkConnector(info.isDirectory() && !info.isSymbolicLink() && [0, uid].includes(info.uid) && ((info.mode & 0o022) === 0 || (info.uid === 0 && (info.mode & 0o1000) !== 0)), 'connector_configuration_path_untrusted');
        if (parent === dirname(parent)) break; parent = dirname(parent);
      }
    };
    const safe = (info: Stats) => checkConnector(info.isFile() && info.nlink === 1 && info.uid === uid && info.size > 0 && info.size <= 16_384 && (info.mode & 0o7177) === 0 && (info.mode & 0o400) !== 0, 'connector_configuration_file_invalid');
    parents(); const before = lstatSync(path); safe(before);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd); safe(opened); checkConnector(unchanged(before, opened), 'connector_configuration_changed');
    let length = 0;
    for (;;) { const read = readSync(fd, bytes, length, bytes.length - length, null); if (read === 0) break; length += read; checkConnector(length <= 16_384, 'connector_configuration_file_invalid'); }
    checkConnector(unchanged(opened, fstatSync(fd)) && unchanged(opened, lstatSync(path)), 'connector_configuration_changed'); parents();
    let parsed: unknown; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); } catch { throw new ConnectorError('connector_configuration_invalid'); }
    return validateConnectorConfig(parsed);
  } catch (error) { if (error instanceof ConnectorError) throw error; throw new ConnectorError('connector_configuration_unavailable', 503); }
  finally { bytes.fill(0); if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}
