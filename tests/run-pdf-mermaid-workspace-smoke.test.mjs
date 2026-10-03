import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const runner = await import('./run-pdf-mermaid-workspace-smoke.mjs');

assert.equal(runner.repoRoot, resolve(testDir, '..'), 'runner must derive the current checkout root');
assert.equal(runner.testPath, '/tests/pdf-mermaid-workspace-smoke.html');

const temporary = await fs.mkdtemp(join(tmpdir(), 'docsmith-pdf-runner-'));
const fixturePath = join(temporary, 'fixture.md');
const fixtureText = '# private fixture route\n';
await fs.writeFile(fixturePath, fixtureText);

const server = await runner.serveRepository(fixturePath);
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + runner.testPath);
  const fixture = await fetch(base + '/fixture.md');
  const escaped = await fetch(base + '/%2e%2e%2fREADME.md');
  const legacy = await fetch(base + '/projects/docsmith/code/README.md');

  assert.equal(page.status, 200, 'current checkout smoke page must be served');
  assert.equal(fixture.status, 200, 'explicit fixture must be available only at /fixture.md');
  assert.equal(await fixture.text(), fixtureText);
  assert.equal(escaped.status, 403, 'paths outside the checkout must be rejected');
  assert.equal(legacy.status, 404, 'the old hard-coded checkout route must not be served');
} finally {
  await new Promise(resolveClose => server.close(resolveClose));
  await fs.rm(temporary, { recursive: true, force: true });
}

console.log('PDF Mermaid runner path and serving regression passed');
