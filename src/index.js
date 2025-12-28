// ABOUTME: Webhook receiver for divine-name-server username sync
// ABOUTME: Validates HMAC-SHA256 signatures and updates divine-names KV store

/// <reference types="@fastly/js-compute" />

const TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes
const SECRET_STORE_NAME = 'divine-name-sync-secrets';
const WEBHOOK_SECRET_KEY = 'webhook_secret';
const NAMES_KV_STORE = 'divine-names';
const FAILURES_KV_STORE = 'sync-failures';

// eslint-disable-next-line no-restricted-globals
addEventListener('fetch', (event) => event.respondWith(handleRequest(event.request)));

/**
 * Main request router
 */
async function handleRequest(request) {
  try {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/sync') {
      return handleSync(request);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(JSON.stringify({
        service: 'divine-name-sync',
        version: '1.0.0',
        endpoints: {
          sync: 'POST /sync',
          health: 'GET /health',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  } catch (err) {
    console.error('Request handler error:', err.message, err.stack);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * Handle incoming sync webhook from divine-name-server
 */
async function handleSync(request) {
  let body = '';

  try {
    // Extract headers
    const signature = request.headers.get('X-Webhook-Signature');
    const timestamp = request.headers.get('X-Webhook-Timestamp');

    if (!signature || !timestamp) {
      return errorResponse('Missing signature or timestamp', 401);
    }

    // Validate timestamp freshness (replay protection)
    const timestampError = validateTimestamp(timestamp);
    if (timestampError) {
      return errorResponse(timestampError, 401);
    }

    // Read body
    body = await request.text();
    if (!body) {
      return errorResponse('Empty request body', 400);
    }

    // Verify HMAC signature
    const signatureError = await verifySignature(body, timestamp, signature);
    if (signatureError) {
      return errorResponse(signatureError, 401);
    }

    // Parse and validate payload
    const payload = parsePayload(body);
    if (payload.error) {
      return errorResponse(payload.error, 400);
    }

    // Update KV store
    await updateKVStore(payload);

    console.log(`Sync successful: ${payload.action} ${payload.name}`);
    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('Sync error:', err.message);
    await logFailure(body, err);
    return errorResponse('Internal error', 500);
  }
}

/**
 * Validate timestamp is within acceptable window
 */
function validateTimestamp(timestamp) {
  const requestTime = parseInt(timestamp, 10);
  if (isNaN(requestTime)) {
    return 'Invalid timestamp format';
  }

  const now = Math.floor(Date.now() / 1000);
  const age = Math.abs(now - requestTime);

  if (age > TIMESTAMP_TOLERANCE_SECONDS) {
    return `Request timestamp too old (${age}s)`;
  }

  return null;
}

/**
 * Verify HMAC-SHA256 signature
 */
async function verifySignature(body, timestamp, providedSignature) {
  const { SecretStore } = await import('fastly:secret-store');
  const secrets = new SecretStore(SECRET_STORE_NAME);
  const secretEntry = await secrets.get(WEBHOOK_SECRET_KEY);

  if (!secretEntry) {
    throw new Error('Webhook secret not configured');
  }

  const secret = secretEntry.plaintext();
  const expectedSignature = await computeHmac(body + timestamp, secret);

  if (!timingSafeEqual(providedSignature, expectedSignature)) {
    return 'Invalid signature';
  }

  return null;
}

/**
 * Compute HMAC-SHA256 and return base64-encoded result
 */
async function computeHmac(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(data)
  );

  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

/**
 * Parse and validate webhook payload
 */
function parsePayload(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: 'Invalid JSON' };
  }

  if (!data.name || typeof data.name !== 'string') {
    return { error: 'Missing or invalid name' };
  }

  if (!data.action || !['upsert', 'delete'].includes(data.action)) {
    return { error: 'Missing or invalid action (must be upsert or delete)' };
  }

  if (data.action === 'upsert' && !data.pubkey) {
    return { error: 'Missing pubkey for upsert action' };
  }

  if (data.pubkey && typeof data.pubkey !== 'string') {
    return { error: 'Invalid pubkey format' };
  }

  if (data.relays && !Array.isArray(data.relays)) {
    return { error: 'Invalid relays format (must be array)' };
  }

  return {
    name: data.name.toLowerCase().trim(),
    action: data.action,
    pubkey: data.pubkey || null,
    relays: data.relays || [],
    status: data.status || 'active',
  };
}

/**
 * Update the divine-names KV store
 */
async function updateKVStore(payload) {
  const { KVStore } = await import('fastly:kv-store');
  const store = new KVStore(NAMES_KV_STORE);
  const key = `user:${payload.name}`;

  if (payload.action === 'delete') {
    await store.delete(key);
    console.log(`Deleted key: ${key}`);
  } else {
    const value = JSON.stringify({
      pubkey: payload.pubkey,
      relays: payload.relays,
      status: payload.status,
    });
    await store.put(key, value);
    console.log(`Upserted key: ${key}`);
  }
}

/**
 * Log sync failure to KV store for later debugging
 */
async function logFailure(body, err) {
  try {
    const { KVStore } = await import('fastly:kv-store');
    const store = new KVStore(FAILURES_KV_STORE);
    const timestamp = new Date().toISOString();
    const key = `${Date.now()}-${randomId()}`;

    await store.put(key, JSON.stringify({
      timestamp,
      error: err.message,
      stack: err.stack,
      body: body.slice(0, 1000), // Truncate large bodies
    }));

    console.log(`Logged failure: ${key}`);
  } catch (logErr) {
    console.error('Failed to log failure:', logErr.message);
  }
}

/**
 * Generate a short random ID for failure log keys
 */
function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Create a JSON error response
 */
function errorResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
