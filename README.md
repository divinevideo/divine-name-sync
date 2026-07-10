# Divine Name Sync

`divine-name-sync` is a [Fastly Compute](https://www.fastly.com/products/compute) service that receives signed webhooks from [divine-name-server](https://github.com/divinevideo/divine-name-server) and keeps a Fastly KV store of usernames in sync. That KV store is read by the edge for fast [NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md) identity lookups, so a name change made in the name server shows up at the edge without a database round trip on every request.

## Features

- Single webhook endpoint (`POST /sync`) that applies `upsert` and `delete` changes to the KV store.
- HMAC-SHA256 request authentication with a timing-safe signature comparison.
- Replay protection: requests whose timestamp is more than five minutes off are rejected.
- Failed syncs are logged to a separate KV store for later debugging instead of being silently dropped.
- Health and service-info endpoints for monitoring.

## Architecture

```
divine-name-server (CF Worker)
        │
        │ POST /sync (HMAC-signed)
        ▼
divine-name-sync (Fastly Compute)   ← this service
        │
        │ verify signature, then upsert/delete
        ▼
divine-names KV store
        │
        │ read at the edge
        ▼
divine-web (Fastly Compute)
        │
        ▼
/.well-known/nostr.json (NIP-05)
```

The name server is the source of truth; this service is a thin, stateless receiver. Running it on Fastly Compute puts the write next to the same `divine-names` KV store that `divine-web` reads from, so both sides of the sync live on one platform.

### Endpoints

| Method | Path      | Description                            |
| ------ | --------- | -------------------------------------- |
| `POST` | `/sync`   | Receive a webhook from the name server |
| `GET`  | `/health` | Health check (returns `OK`)            |
| `GET`  | `/`       | Service info as JSON                   |

### Webhook format

Requests to `/sync` must include both headers:

- `X-Webhook-Signature` — HMAC-SHA256 of the raw request body concatenated with the timestamp, base64-encoded.
- `X-Webhook-Timestamp` — Unix time in seconds.

Body:

```json
{
  "name": "alice",
  "action": "upsert",
  "pubkey": "abc123...",
  "relays": ["wss://relay.example.com"],
  "status": "active"
}
```

- `action` is `upsert` (create or update) or `delete`.
- `pubkey` is required for `upsert`.
- `name` is lowercased and trimmed before use; entries are stored under the key `user:<name>`.
- `relays` defaults to `[]` and `status` defaults to `active`.

### Signature verification

1. The name server signs `body + timestamp` with the shared secret.
2. This service recomputes the HMAC and compares it with a timing-safe check.
3. Timestamps outside a five-minute window (in either direction) are rejected before the signature is checked.

Missing headers, stale timestamps, and bad signatures all return `401`; malformed payloads return `400`.

## Getting started

Requires Node.js and the [Fastly CLI](https://www.fastly.com/documentation/reference/cli/).

```bash
# Install dependencies
npm install

# Serve locally through Fastly Compute
npm run dev

# Build the Wasm package
npm run build

# Publish to Fastly
npm run deploy
```

With the local server running, check the endpoints:

```bash
# Health check
curl http://localhost:7676/health

# Sync request (signature check will fail without a matching local secret)
curl -X POST http://localhost:7676/sync \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: test" \
  -H "X-Webhook-Timestamp: $(date +%s)" \
  -d '{"name":"test","action":"upsert","pubkey":"abc123"}'
```

The local server reads sample KV and secret data from the paths configured in `fastly.toml` (`test-data/names.json`, `test-data/failures.json`, and `secrets.local.json`). `secrets.local.json` holds the local `webhook_secret` and is gitignored — create it yourself to exercise a passing signature check.

## Configuration

The service is configured through Fastly resources rather than environment variables. Names are defined in `src/index.js` and provisioned via the `[setup]` block in `fastly.toml`:

| Resource     | Name                        | Purpose                                                   |
| ------------ | --------------------------- | --------------------------------------------------------- |
| Secret store | `divine-name-sync-secrets`  | Holds `webhook_secret`, the shared HMAC key               |
| KV store     | `divine-names`              | Username-to-pubkey mappings, shared with `divine-web`     |
| KV store     | `sync-failures`             | Log of failed sync attempts for debugging                 |

## Deployment

1. Create the Fastly Compute service.
2. Create the `divine-name-sync-secrets` secret store and add `webhook_secret` (must match the name server's shared secret).
3. Link the existing `divine-names` KV store.
4. Create the `sync-failures` KV store.
5. Publish with `npm run deploy`.
6. Point the service's hostname at the URL the name server sends webhooks to.

## License

MIT

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)
