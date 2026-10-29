import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const SERVICE_ID = 'keqSxRML0NxLxA6jChGqlz';
const bindings = ['divine-names', 'sync-failures', 'divine-name-sync-secrets'];

export function configuration(env) {
  if (env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error('Production requires a push or manual replay on main');
  }
  if (env.CD_ENABLED !== 'true') throw new Error('Production prerequisites have not been confirmed');
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('Missing source SHA');
  if (!env.FASTLY_CUSTOMER_ID || !env.FASTLY_API_TOKEN || !env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    throw new Error('Missing deployment prerequisites');
  }
  const health = new URL(env.PRODUCTION_HEALTH_URL);
  if (health.protocol !== 'https:' || health.pathname !== '/health' || health.search || health.hash || health.username || health.password || health.port) {
    throw new Error('Health URL must be a plain HTTPS /health endpoint');
  }
  const resources = JSON.parse(env.FASTLY_RESOURCE_IDS);
  if (Object.keys(resources).length !== bindings.length || bindings.some(name => typeof resources[name] !== 'string' || !resources[name])) {
    throw new Error('Expected all three existing resource IDs');
  }
  return { sha: env.GITHUB_SHA, customer: env.FASTLY_CUSTOMER_ID, health, resources };
}

// Clone only the active configuration; never provision resources or change domains.
export async function deploy(config, { api, currentMain, health, upload, record }) {
  const service = `/service/${SERVICE_ID}`;
  const assertCurrent = async () => {
    if (await currentMain() !== config.sha) throw new Error('Source is no longer the main tip; replay the current main commit');
  };
  await assertCurrent();
  const details = await api(service);
  if (details.customer_id !== config.customer) throw new Error('Unexpected Fastly account');
  const active = async () => {
    const versions = await api(`${service}/version`);
    const matches = versions.filter(version => version.active === true || version.active === 1);
    if (matches.length !== 1) throw new Error('Expected one active production version');
    return matches[0];
  };
  const previous = await active();
  const links = await api(`${service}/version/${previous.number}/resource`);
  for (const name of bindings) {
    if (!links.some(link => link.name === name && link.resource_id === config.resources[name])) {
      throw new Error(`Existing binding does not match: ${name}`);
    }
  }
  const domains = await api(`${service}/version/${previous.number}/domain`);
  if (!domains.some(domain => domain.name === config.health.hostname)) throw new Error('Health hostname is not bound to this service');
  const result = { source_sha: config.sha, service_id: SERVICE_ID, environment: 'production', previous_version: previous.number, activated: false, activation_status: 'not-attempted', result: 'started' };
  await record(result);
  try {
    const clone = await api(`${service}/version/${previous.number}/clone`, { method: 'PUT' });
    result.provider_version = clone.number;
    await record(result);
    await api(`${service}/version/${clone.number}`, { method: 'PUT', body: new URLSearchParams({ comment: `source:${config.sha}` }) });
    await upload(`${service}/version/${clone.number}/package`);
    const validation = await api(`${service}/version/${clone.number}/validate`);
    if (validation.status !== 'ok') throw new Error('Fastly version validation failed');
    await assertCurrent();
    if ((await active()).number !== previous.number) throw new Error('Active version changed outside this deployment');
    result.activation_status = 'unknown';
    await record(result);
    await api(`${service}/version/${clone.number}/activate`, { method: 'PUT' });
    result.activated = true;
    result.activation_status = 'confirmed';
    await record(result);
    const serving = await active();
    if (serving.number !== clone.number || serving.comment !== `source:${config.sha}`) throw new Error('Active version verification failed');
    await health(config.health);
    result.result = 'success';
    await record(result);
    return result;
  } catch (error) {
    result.result = 'failure';
    await record(result);
    throw error;
  }
}

async function main() {
  const config = configuration(process.env);
  const api = async (path, options = {}) => {
    const response = await fetch(`https://api.fastly.com${path}`, {
      ...options, headers: { 'Fastly-Key': process.env.FASTLY_API_TOKEN, Accept: 'application/json' }, signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Fastly request failed (${response.status})`);
    return response.json();
  };
  const result = await deploy(config, {
    api,
    currentMain: async () => {
      const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/git/ref/heads/main`, {
        headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Cannot verify main (${response.status})`);
      return (await response.json()).object.sha;
    },
    upload: async path => {
      const body = new FormData();
      body.set('package', new Blob([await readFile('pkg/divine-name-sync.tar.gz')]), 'divine-name-sync.tar.gz');
      await api(path, { method: 'PUT', body });
    },
    health: async url => {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (response.status !== 200 || await response.text() !== 'OK') throw new Error('Production health verification failed');
    },
    record: result => writeFile('deployment.json', `${JSON.stringify(result, null, 2)}\n`),
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `Production: ${result.result}\n\nSource: ${result.source_sha}\n\nFastly version: ${result.provider_version}\n\nPrevious version: ${result.previous_version}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
