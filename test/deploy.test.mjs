import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configuration, deploy, SERVICE_ID } from '../scripts/deploy.mjs';

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
  for (const [pattern, changes] of [
    [/push or manual replay on main/, [{ GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' }]],
    [/not been confirmed/, [{ CD_ENABLED: '' }, { CD_ENABLED: 'false' }, { CD_ENABLED: 'TRUE' }]],
    [/source SHA/, [{ GITHUB_SHA: '' }, { GITHUB_SHA: 'a'.repeat(39) }]],
    [/deployment prerequisites/, [{ FASTLY_API_TOKEN: '' }, { FASTLY_CUSTOMER_ID: '' }, { GITHUB_TOKEN: '' }, { GITHUB_REPOSITORY: '' }]],
    [/plain HTTPS \/health/, [
      { PRODUCTION_HEALTH_URL: 'http://sync.example.test/health' },
      { PRODUCTION_HEALTH_URL: 'https://sync.example.test/sync' },
      { PRODUCTION_HEALTH_URL: 'https://sync.example.test/health?extra=1' },
      { PRODUCTION_HEALTH_URL: 'https://sync.example.test/health#frag' },
      { PRODUCTION_HEALTH_URL: 'https://sync.example.test:8443/health' },
      { PRODUCTION_HEALTH_URL: 'https://user:pass@sync.example.test/health' },
      { PRODUCTION_HEALTH_URL: 'https://:pass@sync.example.test/health' },
    ]],
    [/three existing resource IDs/, [
      { FASTLY_RESOURCE_IDS: '{}' }, { FASTLY_RESOURCE_IDS: JSON.stringify({ ...resources, extra: 'extra-id' }) },
      { FASTLY_RESOURCE_IDS: JSON.stringify({ ...resources, 'divine-names': 1 }) },
    ]],
  ]) for (const change of changes) assert.throws(() => configuration({ ...environment(), ...change }), pattern, JSON.stringify(change));
});

function fixture(overrides = {}) {
  const calls = [];
  const records = [];
  let activated = false;
  let comment = '';
  const dependencies = {
    currentMain: async () => sha,
    api: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET', body: options.body?.toString() });
      if (path.endsWith('/clone')) return { number: 2 };
      if (path.endsWith('/activate')) { activated = true; return {}; }
      if (path.endsWith('/validate')) return { status: 'ok' };
      if (path.endsWith('/resource')) return Object.entries(resources).map(([name, resource_id]) => ({ name, resource_id }));
      if (path.endsWith('/domain')) return [{ name: 'sync.example.test' }];
      if (path.endsWith('/version/2') && options.method === 'PUT') { comment = options.body.get('comment'); return {}; }
      if (path.endsWith('/version')) return [{ number: activated ? 2 : 1, active: true, comment: activated ? comment : '' }];
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
  assert.deepEqual(records.map(record => record.activation_status), ['not-attempted', 'not-attempted', 'unknown', 'confirmed', 'confirmed']);
  assert.equal(result.activated, true);
  assert.equal(records.at(-1).result, 'success');
  assert.ok(calls.some(call => call.path.endsWith('/version/1/clone') && call.method === 'PUT'));
  const commentUpdate = calls.find(call => call.path.endsWith('/version/2') && call.method === 'PUT');
  assert.equal(new URLSearchParams(commentUpdate.body).get('comment'), `source:${sha}`);
  assert.ok(calls.some(call => call.path.endsWith('/version/2/package') && call.method === 'UPLOAD'));
  assert.ok(calls.some(call => call.path.endsWith('/version/2/validate')));
  assert.ok(calls.findIndex(call => call.method === 'UPLOAD') < calls.findIndex(call => call.path.endsWith('/activate')));
  assert.equal(calls.at(-1).method, 'HEALTH');
});

test('deployment service matches the manifest', async () => {
  const manifest = await readFile(new URL('../fastly.toml', import.meta.url), 'utf8');
  assert.equal(manifest.match(/^service_id = "([^"]+)"/m)?.[1], SERVICE_ID);
});

test('workflow pins its actions and keeps the production job guarded, queued and receipted', async () => {
  const workflow = await readFile(new URL('../.github/workflows/compute.yml', import.meta.url), 'utf8');
  const uses = workflow.match(/^[ \t]*(?:- )?uses:.*$/gm) ?? [];
  assert.ok(uses.length > 0);
  for (const line of uses) {
    assert.match(line, /uses:\s+["']?(?:\.\/\S+|[^\s@"']+@[0-9a-f]{40}|docker:\/\/[^\s@"']+@sha256:[0-9a-f]{64})["']?(?:\s+#.*)?$/, line);
  }
  const [job] = workflow.match(/^ {2}deploy:\n(?: {4,}.*\n|\s*#.*\n|\n)*/m) ?? [''];
  for (const line of [
    '    needs: checks',
    "    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    '    environment: production',
    '      group: fastly-production',
    '      cancel-in-progress: false',
    '      queue: max',
  ]) assert.ok(job.includes(`\n${line}\n`), line);
  const receipt = job.split(/\n {6}- /).find(step => step.includes('path: deployment.json'));
  assert.match(receipt ?? '', /\n {8}if: always\(\)\n/);
  assert.match(job, /^ {10}FASTLY_API_TOKEN: \$\{\{ secrets\.FASTLY_PRODUCTION_DEPLOY_TOKEN \}\}$/m);
  assert.doesNotMatch(workflow, /secrets\s*(?:\.\s*fastly_api_token\b|\[\s*['"]fastly_api_token['"]\s*\])/i);
  const setup = workflow.split(/\n {6}- /).find(step => step.startsWith('uses: fastly/compute-actions/setup@'));
  assert.match(setup ?? '', /\n {10}token: \$\{\{ github\.token \}\}(?:\n|$)/);
  const pin = workflow.indexOf('name: Install pinned wasm-tools');
  assert.ok(pin > 0 && pin < workflow.indexOf('- run: fastly compute build'));
  // Pinned whole: a shell override, `set +e`, continue-on-error or a dropped PATH export would ship an unverified or latest wasm-tools.
  assert.doesNotMatch(workflow, /^\s*shell:/m);
  assert.equal(workflow.split(/\n {6}- /).find(step => step.startsWith('name: Install pinned wasm-tools')), [
    'name: Install pinned wasm-tools',
    '        run: |',
    '          cd "$RUNNER_TEMP"',
    '          curl --fail --location --retry 3 https://github.com/bytecodealliance/wasm-tools/releases/download/v1.262.0/wasm-tools-1.262.0-x86_64-linux.tar.gz -o wasm-tools.tar.gz',
    "          echo '655b8df67d54c3ef9b52fc237c4e94bbfbb5f5f43825245cb0940a7002a9ed65  wasm-tools.tar.gz' | sha256sum --check --strict",
    '          tar -xzf wasm-tools.tar.gz',
    '          echo "$RUNNER_TEMP/wasm-tools-1.262.0-x86_64-linux" >> "$GITHUB_PATH"',
    '          "$RUNNER_TEMP/wasm-tools-1.262.0-x86_64-linux/wasm-tools" --version',
  ].join('\n'));
});

test('checks compile with a checksum-verified weval and fail if the build fetched its own', async () => {
  const workflow = await readFile(new URL('../.github/workflows/compute.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/\n {6}- /);
  // js-compute 4 compiles ahead of time with weval. Given no binary, it downloads one with no checksum.
  assert.equal(steps.find(step => step.startsWith('name: Install pinned weval')), [
    'name: Install pinned weval',
    '        run: |',
    '          cd "$RUNNER_TEMP"',
    '          curl --fail --location --retry 3 https://github.com/bytecodealliance/weval/releases/download/v0.5.1/weval-v0.5.1-x86_64-linux.tar.xz -o weval.tar.xz',
    "          echo 'ed36a23a4e7f5fdd72659c68647427ab9aee137278e2439bddd813de7db1e2c8  weval.tar.xz' | sha256sum --check --strict",
    '          tar -xJf weval.tar.xz',
    '          "$RUNNER_TEMP/weval-v0.5.1-x86_64-linux/weval" --version',
    '          # js-compute reads its weval path from this file in the project root.',
    `          printf '{"wevalBin":"%s"}\\n' "$RUNNER_TEMP/weval-v0.5.1-x86_64-linux/weval" > "$GITHUB_WORKSPACE/.fastlycomputerc.json"`,
  ].join('\n'));
  assert.equal(steps.find(step => step.startsWith('name: Check the build used the pinned weval')), [
    'name: Check the build used the pinned weval',
    // Every installed copy of the weval package, including one nested under js-compute.
    `        run: test -z "$(find node_modules -path '*/@bytecodealliance/weval/*' -name weval -type f)"`,
  ].join('\n'));
  const order = ['name: Install pinned weval', 'run: fastly compute build --non-interactive', 'name: Check the build used the pinned weval', 'uses: actions/upload-artifact@']
    .map(prefix => steps.findIndex(step => step.startsWith(prefix)));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), `step order ${order}`);
  // js-compute's ahead-of-time cache is built for the weval version it depends on, so a
  // dependency update that moves weval must move this pin (URL and digest) with it.
  // Resolve weval the way js-compute does: its own nested copy first, then the top-level one.
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const weval = lock.packages['node_modules/@fastly/js-compute/node_modules/@bytecodealliance/weval']
    ?? lock.packages['node_modules/@bytecodealliance/weval'];
  assert.equal(weval?.version, '0.5.1');
});

test('checks install dependencies without running install scripts', async () => {
  const workflow = await readFile(new URL('../.github/workflows/compute.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/\n {6}- /);
  // js-compute bundles a wasmtime whose postinstall downloads an unverified binary that the
  // ahead-of-time build never runs. Running it also makes npm ci, and so the tests, depend on GitHub.
  assert.ok(steps.includes('run: npm ci --ignore-scripts'));
  // Covers every install-like command anywhere in the workflow, in named steps and scripts too.
  assert.doesNotMatch(workflow, /\bnpm (?:ci|install|i|rebuild)\b(?![^\n]*--ignore-scripts)/);
});

test('checks smoke-test the compiled package before uploading it', async () => {
  const workflow = await readFile(new URL('../.github/workflows/compute.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/\n {6}- /);
  // The unit tests run the source in Node; only this step runs the compiled module that ships.
  assert.ok(steps.includes('name: Smoke-test the built package in Viceroy\n        run: node --test test/compute.smoke.mjs'));
  const order = ['run: fastly compute build --non-interactive', 'name: Smoke-test the built package in Viceroy', 'uses: actions/upload-artifact@']
    .map(prefix => steps.findIndex(step => step.startsWith(prefix)));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), `step order ${order}`);
  // A second build would replace the checked package before it is uploaded.
  assert.equal(workflow.match(/fastly compute build/g)?.length, 1);
});

test('clone follows the observed active version rather than a fixed version', async () => {
  const { dependencies, calls } = fixture();
  const original = dependencies.api;
  dependencies.api = async (path, options) => {
    const value = await original(path, options);
    if (path.endsWith('/version') && value[0].number === 1) value[0].number = 7;
    return value;
  };
  const result = await deploy(configuration(environment()), dependencies);
  assert.equal(result.previous_version, 7);
  assert.ok(calls.some(call => call.path.endsWith('/version/7/clone')));
});

test('external activation during upload prevents this activation', async () => {
  const { dependencies, calls, records } = fixture();
  const original = dependencies.api;
  let reads = 0;
  dependencies.api = async (path, options) => {
    if (path.endsWith('/version') && ++reads === 2) return [{ number: 3, active: true }];
    return original(path, options);
  };
  await assert.rejects(deploy(configuration(environment()), dependencies), /changed outside/);
  assert.equal(calls.some(call => call.path.endsWith('/activate')), false);
  assert.equal(records.at(-1).activation_status, 'not-attempted');
});

test('multiple active versions are rejected before cloning', async () => {
  const { dependencies, calls } = fixture();
  const original = dependencies.api;
  dependencies.api = async (path, options) => path.endsWith('/version')
    ? [{ number: 1, active: true }, { number: 3, active: true }]
    : original(path, options);
  await assert.rejects(deploy(configuration(environment()), dependencies), /one active/);
  assert.equal(calls.some(call => call.path.endsWith('/clone')), false);
});

test('correct active version with wrong source comment cannot report success', async () => {
  const { dependencies, records } = fixture();
  const original = dependencies.api;
  dependencies.api = async (path, options) => {
    const value = await original(path, options);
    if (path.endsWith('/version') && value[0].number === 2) value[0].comment = 'wrong-source';
    return value;
  };
  await assert.rejects(deploy(configuration(environment()), dependencies), /verification failed/);
  assert.equal(records.at(-1).result, 'failure');
  assert.equal(records.at(-1).activated, true);
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
      if (fault === 'binding' && path.endsWith('/resource')) return Object.entries(resources).map(([name, resource_id]) => ({ name, resource_id: name === 'sync-failures' ? 'other-id' : resource_id }));
      if (fault === 'domain' && path.endsWith('/domain')) return [{ name: 'other.example.test' }];
      if (fault === 'validation' && path.endsWith('/validate')) return { status: 'error' };
      if (fault === 'activation' && path.endsWith('/activate')) throw new Error('activation failed');
      const value = await original(path, options);
      if (fault === 'active-version' && path.endsWith('/version') && value[0].number === 2) return [{ number: 3, active: true, comment: `source:${sha}` }];
      return value;
    };
    if (fault === 'upload') dependencies.upload = async () => { throw new Error('upload failed'); };
    if (fault === 'health') dependencies.health = async () => { throw new Error('health failed'); };
    await assert.rejects(deploy(configuration(environment()), dependencies));
    assert.equal(records.some(record => record.result === 'success'), false);
    if (fault === 'validation') {
      assert.equal(records.at(-1).activated, false);
      assert.equal(records.at(-1).activation_status, 'not-attempted');
    }
    if (fault === 'activation') {
      assert.equal(records.at(-1).activation_status, 'unknown');
      assert.equal(records.at(-1).activated, false);
    }
    if (fault === 'health') {
      assert.equal(records.at(-1).activated, true);
      assert.equal(records.at(-1).activation_status, 'confirmed');
    }
    if (['account', 'binding', 'domain'].includes(fault)) {
      assert.deepEqual(records, []);
      assert.equal(calls.some(call => call.method !== 'GET'), false);
    }
    if (['account', 'binding', 'domain', 'validation', 'upload'].includes(fault)) {
      assert.equal(calls.some(call => call.path.endsWith('/activate')), false);
    }
  });
}

// Replaces fetch inside the spawned deploy process; every request is logged to calls.jsonl.
function stubNetwork(appendFileSync, scenario, sha, resources) {
  let activated = false;
  let comment = '';
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    const headers = new Headers(options.headers);
    const form = options.body instanceof FormData ? [...options.body.keys()] : undefined;
    appendFileSync('calls.jsonl', `${JSON.stringify({ url, method: options.method ?? 'GET', redirect: options.redirect, form, fastlyKey: headers.has('fastly-key'), authorization: headers.has('authorization') })}\n`);
    if (url === 'https://api.github.com/repos/example/sync/git/ref/heads/main') return json({ object: { sha } }, scenario === 'main-error' ? 500 : 200);
    if (url.startsWith('https://api.github.com/')) return json({}, 404);
    if (url === 'https://sync.example.test/health') return new Response(scenario === 'health-body' ? 'NOT OK' : 'OK', { status: scenario === 'health-status' ? 503 : 200 });
    if (url.endsWith('/activate')) {
      if (scenario === 'activation-rejected') return json({}, 403);
      activated = true;
      return json({});
    }
    if (url.endsWith('/clone')) return json({ number: 2 });
    if (url.endsWith('/validate')) return json({ status: 'ok' });
    if (url.endsWith('/resource')) return json(Object.entries(resources).map(([name, resource_id]) => ({ name, resource_id })));
    if (url.endsWith('/domain')) return json([{ name: 'sync.example.test' }]);
    if (url.endsWith('/package')) return json({});
    if (url.endsWith('/version/2')) { comment = options.body.get('comment'); return json({}); }
    if (url.endsWith('/version')) return json([{ number: activated ? 2 : 1, active: true, comment: activated ? comment : '' }]);
    return json({ customer_id: 'account-id' });
  };
}

async function runMain(scenario) {
  const directory = await mkdtemp(join(tmpdir(), 'divine-name-sync-deploy-'));
  try {
    await mkdir(join(directory, 'pkg'));
    await writeFile(join(directory, 'pkg/divine-name-sync.tar.gz'), 'package');
    await writeFile(join(directory, 'stub.mjs'), `import { appendFileSync } from 'node:fs';\n(${stubNetwork})(appendFileSync, ${JSON.stringify(scenario)}, ${JSON.stringify(sha)}, ${JSON.stringify(resources)});\n`);
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(join(directory, 'stub.mjs')).href, fileURLToPath(new URL('../scripts/deploy.mjs', import.meta.url))], {
      cwd: directory, encoding: 'utf8', env: environment(), timeout: 30_000,
    });
    const read = name => readFile(join(directory, name), 'utf8').catch(() => '');
    const receipt = await read('deployment.json');
    const calls = (await read('calls.jsonl')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, receipt: receipt && JSON.parse(receipt), calls };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('production adapters attach each credential only to its own API and verify health', async () => {
  const { status, stdout, stderr, receipt, calls } = await runMain('success');
  assert.equal(status, 0, stderr);
  assert.equal(receipt.result, 'success');
  for (const call of calls) {
    assert.equal(call.fastlyKey, call.url.startsWith('https://api.fastly.com/'));
    assert.equal(call.authorization, call.url.startsWith('https://api.github.com/'));
    if (call.fastlyKey) assert.equal(call.redirect, 'error');
  }
  assert.ok(stdout.includes('"previous_version": 1'));
  assert.ok(stdout.includes('"result": "success"'));
  assert.deepEqual(calls.find(call => call.url.endsWith('/package')).form, ['package']);
  assert.deepEqual(['/clone', '/version/2', '/package', '/activate'].map(suffix => calls.find(call => call.url.endsWith(suffix)).method), ['PUT', 'PUT', 'PUT', 'PUT']);
  assert.equal(calls.find(call => call.url === 'https://sync.example.test/health').redirect, 'error');
});

for (const [scenario, activation] of [['health-status', 'confirmed'], ['health-body', 'confirmed'], ['activation-rejected', 'unknown']]) {
  test(`production adapters fail on ${scenario}`, async () => {
    const { status, stdout, stderr, receipt } = await runMain(scenario);
    assert.equal(status, 1, stderr);
    assert.equal(receipt.result, 'failure');
    assert.ok(stdout.includes('"result": "failure"'));
    assert.equal(receipt.activation_status, activation);
    assert.equal(receipt.activated, activation === 'confirmed');
  });
}

test('production adapters stop before Fastly when main cannot be verified', async () => {
  const { status, stderr, receipt, calls } = await runMain('main-error');
  assert.equal(status, 1);
  assert.match(stderr, /Cannot verify main \(500\)/);
  assert.equal(receipt, '');
  assert.equal(calls.some(call => call.url.startsWith('https://api.fastly.com/')), false);
});
