import { createHash } from 'node:crypto';
import type { IoEvent } from './morphz-adapter.ts';

export class ArtifactError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface ArtifactView {
  id: string; name: string; mediaType: string; sizeBytes: number; sha256: string;
  sourceEventId: string; origin: 'input' | 'output'; createdAt: string | null;
  downloadable: boolean; downloadPath: string;
}
interface RegisteredResource { view: ArtifactView; resourceId: string }
export interface ArtifactAdapter { readResource(sessionId: string, resourceId: string, maximumBytes: number): Promise<Uint8Array> }
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const MAXIMUM_RESOURCE_BYTES = 32 * 1024 * 1024;

/** Catalog only immutable Event-owned resources that Runtime advertised in this
 * Session. No filesystem crawl, model-text URL extraction, source-path download,
 * fabricated file, or user-supplied resource ID is accepted.
 */
export class Artifacts {
  private sessionId: string;
  private adapter: ArtifactAdapter;
  private events: () => IoEvent[];
  private maximumBytes: number;
  constructor(adapter: ArtifactAdapter, sessionId: string, events: () => IoEvent[], maximumBytes = MAXIMUM_RESOURCE_BYTES) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 128 * 1024 * 1024) throw new ArtifactError(500, 'Invalid resource size limit');
    this.adapter = adapter; this.sessionId = sessionId; this.events = events; this.maximumBytes = maximumBytes;
  }
  private catalog(): Map<string, RegisteredResource> {
    const catalog = new Map<string, RegisteredResource>();
    for (const event of this.events()) {
      if (event.session_id && event.session_id !== this.sessionId) throw new ArtifactError(502, 'Resource history does not match the current Session');
      if (!['input.accepted', 'output.committed'].includes(event.type)) continue;
      const binding = object(event.binding);
      const items = [...(Array.isArray(event.resources) ? event.resources : []), ...(Array.isArray(binding?.resources) ? binding.resources : [])];
      for (const raw of items) {
        const resource = object(raw);
        if (!resource || typeof resource.resource_id !== 'string' || !/^io-resource:[A-Za-z0-9_-]{1,2048}$/.test(resource.resource_id) || resource.source_event_id !== event.event_id) throw new ArtifactError(502, 'Runtime resource provenance is invalid');
        if (typeof resource.name !== 'string' || typeof resource.media_type !== 'string' || !Number.isSafeInteger(resource.size_bytes) || Number(resource.size_bytes) < 0 || typeof resource.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(resource.sha256)) throw new ArtifactError(502, 'Runtime resource metadata is incomplete');
        const name = resource.name.split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200) || 'download';
        const mediaType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(resource.media_type) ? resource.media_type : 'application/octet-stream';
        const id = sha256(`${this.sessionId}\0${resource.resource_id}`);
        const view: ArtifactView = { id, name, mediaType, sizeBytes: Number(resource.size_bytes), sha256: resource.sha256.toLowerCase(), sourceEventId: event.event_id, origin: event.type === 'input.accepted' ? 'input' : 'output', createdAt: typeof event.timestamp === 'string' ? event.timestamp : null, downloadable: Number(resource.size_bytes) <= this.maximumBytes, downloadPath: `/api/artifacts/${id}/content` };
        const previous = catalog.get(id);
        if (previous && JSON.stringify(previous.view) !== JSON.stringify(view)) throw new ArtifactError(502, 'Immutable Runtime resource metadata changed');
        catalog.set(id, { view, resourceId: resource.resource_id });
      }
    }
    return catalog;
  }
  list(): ArtifactView[] { return [...this.catalog().values()].map(value => ({ ...value.view })); }
  async download(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new ArtifactError(404, 'Registered resource not found');
    const resource = this.catalog().get(id);
    if (!resource) throw new ArtifactError(404, 'Registered resource not found');
    if (!resource.view.downloadable) throw new ArtifactError(413, 'This registered resource exceeds the current 32 MiB download limit');
    // Runtime rechecks Principal/Session authority and attachment integrity before
    // AND after loading. No persistent external download URL is returned.
    const bytes = await this.adapter.readResource(this.sessionId, resource.resourceId, this.maximumBytes);
    if (bytes.byteLength !== resource.view.sizeBytes || sha256(bytes) !== resource.view.sha256) throw new ArtifactError(502, 'Runtime resource integrity verification failed. No bytes were delivered.');
    return { artifact: { ...resource.view }, bytes };
  }
}
