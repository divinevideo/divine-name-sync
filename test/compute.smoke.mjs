import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Serves the built package (bin/main.wasm) in Viceroy and sends it real webhooks, so the
// compiled module's secret store, HMAC and KV paths run end to end. Build first; CI runs this
// after `fastly compute build`. Needs `viceroy` on PATH, or its path in VICEROY.

const root = fileURLToPath(new URL('..', import.meta.url));
const wasm = join(root, 'bin/main.wasm');
const secret = 'synthetic-smoke-test-secret';
const pubkey = '0000000000000000000000000000000000000000000000000000000000000002';
let viceroy;
let workdir;
let origin;
let output = '';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

before(async () => {
  await access(wasm).catch(() => { throw new Error('bin/main.wasm is missing: build the package first'); });
  // A private copy of the manifest and its local stores, so this never reads or writes the
  // checkout's secrets.local.json or test-data/.
  workdir = await mkdtemp(join(tmpdir(), 'divine-name-sync-smoke-'));
  await mkdir(join(workdir, 'test-data'));
  for (const file of ['fastly.toml', 'test-data/names.json', 'test-data/failures.json']) {
    await copyFile(join(root, file), join(workdir, file));
  }
  await writeFile(join(workdir, 'secrets.local.json'), JSON.stringify({ webhook_secret: secret }));
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  let spawnError;
  viceroy = spawn(process.env.VICEROY ?? 'viceroy', ['serve', wasm, '-C', 'fastly.toml', '--addr', `127.0.0.1:${port}`], { cwd: workdir });
  viceroy.once('error', error => { spawnError = error; });
  viceroy.stdout.on('data', chunk => { output += chunk; });
  viceroy.stderr.on('data', chunk => { output += chunk; });
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    if (spawnError) throw spawnError;
    if (viceroy.exitCode !== null) throw new Error(`viceroy exited with ${viceroy.exitCode}:\n${output}`);
    // Each probe has its own timeout so one unanswered request cannot outlast the deadline.
    const ready = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) }).then(response => response.ok, () => false);
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`viceroy did not answer /health within 60s:\n${output}`);
});

after(async () => {
  if (viceroy?.exitCode === null && viceroy.signalCode === null) {
    const exited = new Promise(resolve => viceroy.once('exit', resolve));
    viceroy.kill();
    const forceKill = setTimeout(() => viceroy.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(forceKill);
  }
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

async function sync(payload, key = secret) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', key).update(body + timestamp).digest('base64');
  // A stuck handler must fail the run quickly, not hold it until fetch's own five-minute limit.
  return fetch(`${origin}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Timestamp': timestamp, 'X-Webhook-Signature': signature },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch(error => { throw new Error(`POST /sync got no response: ${error.message}\n${output}`); });
}

test('a signed upsert is verified and accepted', async () => {
  const response = await sync({ name: 'Smoke', action: 'upsert', pubkey, relays: ['wss://relay.example.test'] });
  assert.equal(response.status, 200, output);
  assert.equal(await response.text(), 'OK');
});

test('a signed delete is verified and accepted', async () => {
  const response = await sync({ name: 'smoke', action: 'delete' });
  assert.equal(response.status, 200, output);
  assert.equal(await response.text(), 'OK');
});

test('a webhook signed with the wrong secret is rejected', async () => {
  const response = await sync({ name: 'smoke', action: 'delete' }, 'not-the-webhook-secret');
  assert.equal(response.status, 401, output);
  assert.deepEqual(await response.json(), { error: 'Invalid signature' });
});
