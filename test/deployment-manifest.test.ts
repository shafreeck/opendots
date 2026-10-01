import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('desktop build includes vendored runtime dependencies without changing isolation defaults', () => {
  const dockerfile=readFileSync(new URL('../deploy/computer/Dockerfile',import.meta.url),'utf8');
  for(const directory of ['src','public','vendor','licenses']) assert.match(dockerfile,new RegExp(`COPY ${directory} \\./${directory}`));
  assert.match(dockerfile,/USER node/);
  assert.doesNotMatch(dockerfile,/--no-sandbox|full_access|danger-full-access/);
  const ignore=readFileSync(new URL('../.dockerignore',import.meta.url),'utf8');
  assert.match(ignore,/^\.git$/m);assert.match(ignore,/^\.env$/m);assert.match(ignore,/^\.data$/m);
});
