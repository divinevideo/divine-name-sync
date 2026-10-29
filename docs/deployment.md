# Checked production deployments

The `Compute` workflow checks PRs and pushes to `main`. Only a push to `main`
or an explicit **Run workflow** with branch **main** can enter the production
job. `npm test` and `fastly compute build` must pass in that run. The deploy job
downloads that run's SHA-named package; it never rebuilds it with credentials.
Actions are pinned by commit, Node by release, and Fastly CLI/Viceroy by release.

## Enablement prerequisites (maintainer-owned)

CD is **not enabled by this change**. Before enabling it, a maintainer must
confirm the manifest's existing service, its owning Fastly account, active
version, hostname and all resource links against serving production. Do not
create replacement resources, domains, runtime secrets or move traffic.

Create or confirm the GitHub `production` environment, including its intended
reviewer protections and main-only deployment branch policy. An environment
name in YAML is not proof of a protection rule. Keep the enable flag unset
until these prerequisites are verified. This change does not configure GitHub
environments or their protections.

Set these **production environment variables**, after recording the evidence:

| Variable | Value |
| --- | --- |
| `FASTLY_CD_ENABLED` | Exactly `true`, only after the checks above |
| `FASTLY_CUSTOMER_ID` | Confirmed owning account ID |
| `FASTLY_RESOURCE_IDS` | JSON object with keys `divine-names`, `sync-failures`, `divine-name-sync-secrets`, each mapped to its existing resource ID |
| `PRODUCTION_HEALTH_URL` | Confirmed service hostname, HTTPS `/health`, no credentials, query or redirect |

Set the environment secret `FASTLY_API_TOKEN` using the approved credential
process. Use an automation token restricted to this existing service, with
Fastly `global` scope for service version clone/update, package upload,
validation and activation. `global:read` cannot deploy. Do not supply a personal
account-wide token. Existing webhook secrets stay in Fastly's existing secret
store: CD does not read their values. GitHub's token only needs `contents: read`.

Before its first provider write, the script checks the account, active version,
all three resource links and health domain. It clones that active configuration
and uploads the checked package through Fastly's
[package API](https://www.fastly.com/documentation/reference/api/services/package/).
It never calls resource creation, domain mutation or secret APIs. After provider
validation it rechecks the main tip and unchanged active version, then activates.

## Ordering and release evidence

The production job uses one non-cancelling concurrency group. GitHub need not
schedule waiting jobs FIFO: stale jobs therefore fail if their source is no
longer main, both before cloning and immediately before activation. A running
older deployment may finish before the newer one; queued older work cannot
overwrite a newer successful main release. Coordinate all manual provider
changes with this same production lane; external actors are not locked by
GitHub concurrency. A main push after the final check can leave production
temporarily behind until its own checked run deploys.

`deployment.json` records source SHA, environment, service, previous version,
new provider version and success/failure after provider preflight. It is retained
as a run artifact, including after upload/validation/activation/health failures.
Failures before preflight remain failed step logs with no deployment receipt.
The provider version comment also records `source:<full SHA>`. A success requires
that exact version/comment to be active and a read-only `/health` response of
HTTP 200 with body `OK`. No webhook smoke request or KV write is sent. The health
probe establishes availability, not end-to-end webhook or KV correctness.

For a controlled first merge, the maintainer must inspect check execution,
production environment authorization, the deployment artifact, active version
and safe health result. Exercise failed-check and non-main manual runs without
production mutation. These live acceptance checks are not established by local
mock tests. Missing prerequisites fail visibly, never report a successful release.

## Replay and rollback

To replay, use **Run workflow** on the current main branch. Checks rebuild the
same source before deployment; old-main replays are refused. Do not rerun an
obsolete SHA to roll back.

For rollback, first pause the automated lane by unsetting `FASTLY_CD_ENABLED`,
and ensure any in-flight production job has finished before changing provider
state. From the failed run's receipt, identify and independently verify the
previous version and its source. With separately authorized production access,
activate that existing known-good version in Fastly. Verify the active version
and the same safe health endpoint, then record the incident, version and source.
Do not delete versions or stores. Prefer a revert PR to main for a durable
rollback that the normal checked deployment can carry. Re-enable the lane only
after main and the intended release agree.

There are no migrations in this change. Resource or schema migrations need a
separate compatibility and ordering plan; do not add them implicitly to deploy.
