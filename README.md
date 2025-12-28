# divine-name-sync

Fastly Compute service that receives webhooks from [divine-name-server](https://github.com/divinevideo/divine-name-server) and syncs username data to Fastly KV store for fast NIP-05 lookups.

## Architecture

```
divine-name-server (CF Worker)
        │
        │ POST /sync (HMAC-signed)
        ▼
divine-name-sync (Fastly Compute)
        │
        │ Verify signature
        │ Update KV store
        ▼
divine-names KV Store
        │
        │ (read by)
        ▼
divine-web (Fastly Compute)
        │
        │ Serve NIP-05 requests
        ▼
/.well-known/nostr.json
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /sync | Receive webhook from divine-name-server |
| GET | /health | Health check |
| GET | / | Service info |

## Webhook Format

**Headers:**
- `X-Webhook-Signature`: HMAC-SHA256 signature (base64)
- `X-Webhook-Timestamp`: Unix timestamp (seconds)

**Body:**
```json
{
  "name": "alice",
  "action": "upsert",
  "pubkey": "abc123...",
  "relays": ["wss://relay.example.com"],
  "status": "active"
}
```

Actions:
- `upsert`: Create or update username entry
- `delete`: Remove username entry

## Security

Webhooks are authenticated using HMAC-SHA256:
1. CF Worker signs `JSON.stringify(payload) + timestamp` with shared secret
2. Fastly Compute verifies signature matches
3. Timestamps older than 5 minutes are rejected (replay protection)

## Resources

| Resource | Name | Description |
|----------|------|-------------|
| Secret Store | divine-name-sync-secrets | Holds `webhook_secret` |
| KV Store | divine-names | Username mappings (shared with divine-web) |
| KV Store | sync-failures | Error log for failed syncs |

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Deploy to Fastly
npm run deploy
```

## Local Testing

```bash
# Start local server
npm run dev

# Test health endpoint
curl http://localhost:7676/health

# Test sync (will fail signature check with local secret)
curl -X POST http://localhost:7676/sync \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: test" \
  -H "X-Webhook-Timestamp: $(date +%s)" \
  -d '{"name":"test","action":"upsert","pubkey":"abc123"}'
```

## Deployment

1. Create Fastly Compute service
2. Create secret store and add `webhook_secret`
3. Link existing `divine-names` KV store
4. Create `sync-failures` KV store
5. Deploy service
6. Configure DNS for `name-sync.dvine.video`

## License

MIT
