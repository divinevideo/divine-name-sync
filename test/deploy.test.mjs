import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, deploy } from '../scripts/deploy.mjs';

const sha = 'a'.repeat(40);
const resources = { 'divine-names': 'names-id', 'sync-failures': 'failures-id', 'divine-name-sync-secrets': 'secrets-id' };
const environment = () => ({
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sha,
  CD_ENABLED: 'true', FASTLY_CUSTOMER_ID: 'account-id', FASTLY_RESOURCE_IDS: JSON.stringify(resources),
  PRODUCTION_HEALTH_URL: 'https://sync.example.test/health', FASTLY_API_TOKEN: 'synthetic-token',
  GITHUB_TOKEN: 'synthetic-token', GITHUB_REPOSITORY: 'example/sync',
});

test('configuration accepts only enabled main push or main manual replay', () => {
  assert.equal(configuration(environment()).sha, sha);
  assert.equal(configuration({ ...environment(), GITHUB_EVENT_NAME: 'workflow_dispatch' }).sha, sha);
  for (const change of [
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { CD_ENABLED: '' }, { FASTLY_API_TOKEN: '' }, { GITHUB_SHA: '' },
    { FASTLY_RESOURCE_IDS: '{}' }, { PRODUCTION_HEALTH_URL: 'http://sync.example.test/health' },
    { PRODUCTION_HEALTH_URL: 'https://sync.example.test/sync' },
    { PRODUCTION_HEALTH_URL: 'https://sync.example.test/health?extra=1' },
    { PRODUCTION_HEALTH_URL: 'https://user:pass@sync.example.test/health' },
  ]) assert.throws(() => configuration({ ...environment(), ...change }));
});

function fixture(overrides = {}) {
  const calls = [];
  const records = [];
  let activated = false;
  const dependencies = {
    currentMain: async () => sha,
    api: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET' });
      if (path.endsWith('/clone')) return { number: 2 };
      if (path.endsWith('/activate')) { activated = true; return {}; }
      if (path.endsWith('/validate')) return { status: 'ok' };
      if (path.endsWith('/resource')) return Object.entries(resources).map(([name, resource_id]) => ({ name, resource_id }));
      if (path.endsWith('/domain')) return [{ name: 'sync.example.test' }];
      if (path.endsWith('/version')) return [{ number: activated ? 2 : 1, active: true, comment: activated ? `source:${sha}` : '' }];
      return { customer_id: 'account-id' };
    },
    upload: async path => { calls.push({ path, method: 'UPLOAD' }); },
    health: async () => { calls.push({ path: '/health', method: 'HEALTH' }); },
    record: async result => { records.push(structuredClone(result)); },
    ...overrides,
  };
  return { dependencies, calls, records };
}

test('deploy clones active bindings, uploads checked package, validates, activates and verifies', async () => {
  const { dependencies, calls, records } = fixture();
  const result = await deploy(configuration(environment()), dependencies);
  assert.equal(result.source_sha, sha);
  assert.equal(result.previous_version, 1);
  assert.equal(result.provider_version, 2);
  assert.equal(result.result, 'success');
  assert.deepEqual(records.map(record => record.result), ['started', 'started', 'success']);
  assert.ok(calls.findIndex(call => call.method === 'UPLOAD') < calls.findIndex(call => call.path.endsWith('/activate')));
  assert.equal(calls.at(-1).method, 'HEALTH');
});

test('stale main is refused before any provider request', async () => {
  const { dependencies, calls } = fixture({ currentMain: async () => 'b'.repeat(40) });
  await assert.rejects(deploy(configuration(environment()), dependencies), /no longer/);
  assert.equal(calls.length, 0);
});

test('main advances while uploading: never activate', async () => {
  let checks = 0;
  const { dependencies, calls, records } = fixture({ currentMain: async () => ++checks === 1 ? sha : 'b'.repeat(40) });
  await assert.rejects(deploy(configuration(environment()), dependencies), /no longer/);
  assert.equal(calls.some(call => call.path.endsWith('/activate')), false);
  assert.equal(records.at(-1).result, 'failure');
});

for (const fault of ['account', 'binding', 'domain', 'validation', 'upload', 'activation', 'active-version', 'health']) {
  test(`${fault} failure propagates and prevents success`, async () => {
    const { dependencies, calls, records } = fixture();
    const original = dependencies.api;
    dependencies.api = async (path, options) => {
      if (fault === 'account' && !path.includes('/version')) return { customer_id: 'wrong-account' };
      if (fault === 'binding' && path.endsWith('/resource')) return [];
      if (fault === 'domain' && path.endsWith('/domain')) return [];
      if (fault === 'validation' && path.endsWith('/validate')) return { status: 'error' };
      if (fault === 'activation' && path.endsWith('/activate')) throw new Error('activation failed');
      const value = await original(path, options);
      if (fault === 'active-version' && path.endsWith('/version') && value[0].number === 2) return [{ number: 3, active: true }];
      return value;
    };
    if (fault === 'upload') dependencies.upload = async () => { throw new Error('upload failed'); };
    if (fault === 'health') dependencies.health = async () => { throw new Error('health failed'); };
    await assert.rejects(deploy(configuration(environment()), dependencies));
    assert.equal(records.some(record => record.result === 'success'), false);
    if (['account', 'binding', 'domain', 'validation', 'upload'].includes(fault)) {
      assert.equal(calls.some(call => call.path.endsWith('/activate')), false);
    }
  });
}
