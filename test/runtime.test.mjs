import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('health and rejected webhook requests do not need provider resources', async () => {
  let listener;
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    addEventListener: (name, callback) => { assert.equal(name, 'fetch'); listener = callback; },
    URL, Response, console,
  });
  async function request(path, options) {
    let response;
    listener({ request: new Request(`https://sync.example.test${path}`, options), respondWith: result => { response = result; } });
    return response;
  }
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'OK');
  assert.equal((await request('/sync', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await request('/unknown')).status, 404);
});
