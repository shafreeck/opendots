import { readFileSync, existsSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('morphz-source.lock.json', root)));
if (!/^[a-f0-9]{40}$/.test(lock.revision)) throw new Error('Invalid revision');
if (lock.runtimeModificationPolicy !== 'upstream-unmodified-only') throw new Error('Runtime must remain unmodified');
if (lock.repository !== 'https://github.com/morphz-ai/morphz') throw new Error('Unexpected source repository');
if (!lock.validation || !['passed', 'not_run'].includes(lock.validation.actualRuntimeWithDeterministicProvider)) throw new Error('Missing explicit validation level');
for (const path of lock.validation.evidence ?? []) {
  if (!/^docs\/[A-Z_]+\.md$/.test(path) || !existsSync(new URL(path, root))) throw new Error('Missing evidence document');
}
console.log(`Source pinned: ${lock.revision}; Runtime policy: ${lock.runtimeModificationPolicy}`);
console.log(JSON.stringify(lock.validation, null, 2));
