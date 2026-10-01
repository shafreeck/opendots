import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import { ProductStore } from './store.ts';

const { dbPath, durationMs = 5000 } = workerData as { dbPath: string; durationMs?: number };
const store = new ProductStore(dbPath);
const abort = new AbortController();
let running = true;
parentPort?.on('message', (message) => {
  if (message === 'stop') { running = false; abort.abort(); }
});
parentPort?.postMessage({ status: 'ready' });

try {
  while (running) {
    const job = store.claim();
    if (!job) {
      await sleep(250, undefined, { signal: abort.signal });
      continue;
    }
    // Deliberately a timer-based simulation, not model execution or an agent loop.
    const end = Date.now() + durationMs;
    let ownsLease = true;
    while (running && Date.now() < end) {
      await sleep(Math.min(1000, end - Date.now()), undefined, { signal: abort.signal });
      ownsLease = store.renew(job.id, job.lease_token!);
      if (!ownsLease) break;
    }
    if (running && ownsLease) store.complete(job.id, job.lease_token!);
  }
} catch (error) {
  if (!(error instanceof Error && error.name === 'AbortError')) throw error;
} finally {
  store.close();
  parentPort?.close();
}
