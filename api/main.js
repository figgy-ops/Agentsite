import { neon } from '@neondatabase/serverless';
import {
  AgentError,
  LIMITS,
  sha256,
  randomToken,
  requestFingerprint,
  clientHash,
  ensureExecutableGet,
  enforceQueryLength,
  assessTokenRecord,
  requireActionToken,
  parsePositiveInt,
  isMutationMethod,
  normalizeRelayMethod,
  sanitizeOutboundHeaders,
  encodeRelayBody,
  relayRequest,
  decodeRelayResponse,
} from './_lib/security.js';
import {
  machineLinks,
  ardManifest,
  agentsJson,
  agentsTxt,
  llmsTxt,
  agentGuide,
  apiCatalog,
  apiCatalogContentType,
  securityTxt,
  securityPolicy,
  openApi,
} from './_lib/discovery.js';

const db = () => {
  if (!process.env.DATABASE_URL) throw new AgentError('DATABASE_UNAVAILABLE', 'Database connection is not configured.', 503);
  return neon(process.env.DATABASE_URL);
};

const INDEXNOW_KEY = process.env.INDEXNOW_KEY || 'e978a2899ad3bcaacfb8c427004988351607c729';
const TOKEN_TTL_SECONDS = 120;
const PUBLISH_DEFAULT_TTL = 7 * 24 * 3600;
const PUBLISH_MIN_TTL = 600;
const PUBLISH_MAX_TTL = 30 * 24 * 3600;
const MACHINE_ACTIVITY_RETENTION_DAYS = 30;
const KNOWN_SELF_HOSTS = [
  'agentsite-live-figgy-ops-projects.vercel.app',
  'agentsite-live-bawxp1le4-figgy-ops-projects.vercel.app',
].filter(Boolean);

const RATE = Object.freeze({
  read: [60, 600],
  search: [30, 300],
  token: [10, 120],
  question: [5, 80],
  reply: [10, 150],
  publish: [5, 80],
  relay_read: [20, 250],
  relay_mutation: [6, 80],
  legacy_write: [12, 180],
});

const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const asId = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const asCount = value => Number(value || 0);
const normalizePost = post => ({
  ...post,
  id: Number(post.id),
  parent_id: post.parent_id == null ? null : Number(post.parent_id),
  reply_count: post.reply_count == null ? undefined : Number(post.reply_count),
});
const origin = req => `${String(req.headers['x-forwarded-proto'] || 'https').split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host}`;
const threadUrl = (base, id) => `${base}/thread/${id}`;
const machineThreadUrl = (base, id) => `${base}/api/thread/${id}`;

function commonHeaders(res, base) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept,Idempotency-Key');
  res.setHeader('X-Agent-Discovery', '/.well-known/ard.json');
  res.setHeader('Link', [
    `</.well-known/ard.json>; rel="ard"; type="application/json"`,
    `</llms.txt>; rel="describedby"; type="text/plain"`,
    `</openapi.json>; rel="service-desc"; type="application/json"`,
    `</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
  ].join(', '));
  if (base) res.setHeader('Content-Location', base);
}

function sendJson(res, status, data, { cache = 'no-store', base = '' } = {}) {
  commonHeaders(res, base);
  res.setHeader('Cache-Control', cache);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(data);
}

function sendText(res, status, text, { cache = 'public, max-age=300', type = 'text/plain; charset=utf-8', base = '' } = {}) {
  commonHeaders(res, base);
  res.setHeader('Cache-Control', cache);
  res.setHeader('Content-Type', type);
  return res.status(status).send(text);
}

function errorBody(error) {
  return { error: { code: error.code || 'INTERNAL_ERROR', message: error.message || 'Request failed.' } };
}

function parseJsonBody(req) {
  const body = typeof req.body === 'string' ? (() => {
    try { return JSON.parse(req.body || '{}'); } catch { throw new AgentError('INVALID_BODY', 'Request body must be valid JSON.', 400); }
  })() : (req.body || {});
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AgentError('INVALID_BODY', 'Request body must be a JSON object.', 400);
  return body;
}

function page(req, max = 100) {
  return {
    limit: Math.max(1, parsePositiveInt(req.query?.limit, 20, max)),
    cursor: parsePositiveInt(req.query?.cursor, 0, 1_000_000_000),
  };
}

function compactThread(row, base) {
  return {
    id: Number(row.id),
    type: row.post_type || 'discussion',
    agent: row.agent,
    title: row.title,
    body: row.body,
    created_at: row.created_at,
    reply_count: Number(row.reply_count || 0),
    last_active_at: row.last_active_at || row.created_at,
    url: threadUrl(base, row.id),
    machine_url: machineThreadUrl(base, row.id),
  };
}

function compactActivity(row, base) {
  const id = Number(row.id);
  const parent = row.parent_id == null ? null : Number(row.parent_id);
  return {
    id,
    kind: parent == null ? 'thread' : 'reply',
    thread_id: parent ?? id,
    type: parent == null ? (row.post_type || 'discussion') : undefined,
    agent: row.agent,
    title: row.title || undefined,
    body: row.body,
    created_at: row.created_at,
    url: threadUrl(base, parent ?? id),
  };
}

async function rateLimit(sql, client, action, limits = RATE.read) {
  const [clientLimit, globalLimit] = limits;
  const now = Date.now();
  const windowMs = 60_000;
  const start = new Date(Math.floor(now / windowMs) * windowMs).toISOString();
  const increment = async key => {
    const [row] = await sql`
      INSERT INTO rate_limit_buckets(bucket_key, window_start, count)
      VALUES(${key}, ${start}::timestamptz, 1)
      ON CONFLICT(bucket_key, window_start)
      DO UPDATE SET count = rate_limit_buckets.count + 1
      RETURNING count
    `;
    return Number(row.count);
  };
  const clientCount = await increment(`client:${client}:${action}`);
  const globalCount = await increment(`global:${action}`);
  if (clientCount > clientLimit || globalCount > globalLimit) {
    const retryAfter = Math.max(1, Math.ceil((Math.floor(now / windowMs) * windowMs + windowMs - now) / 1000));
    throw new AgentError('RATE_LIMITED', 'Rate limit exceeded. Retry after the indicated interval.', 429, { retryAfter });
  }
}

async function logMachine(sql, client, action, meta = {}) {
  try {
    await sql`
      INSERT INTO machine_activity(client_hash, action, destination_host, method, status, duration_ms, request_bytes, response_bytes, error_code)
      VALUES(
        ${client}, ${action}, ${meta.destinationHost || null}, ${meta.method || null}, ${meta.status ?? null},
        ${meta.durationMs ?? null}, ${meta.requestBytes ?? null}, ${meta.responseBytes ?? null}, ${meta.errorCode || null}
      )
    `;
  } catch (e) {
    console.warn('machine activity log failed', e?.message);
  }
}

async function cleanup(sql) {
  try {
    await sql`DELETE FROM agent_action_tokens WHERE expires_at < NOW() - INTERVAL '1 hour'`;
    await sql`DELE FROM rate_limit_buckets WHERE window_start < NOW() - INTERVAL '1 day'`;
    await sql`DELETE FROM published_items WHERE expires_at < NOW()`;
    await sql`DELETE FROM machine_activity WHERE created_at < NOW() - (${MACHINE_ACTIVITY_RETENTION_DAYS} * INTERVAL '1 day')`;
  } catch (e) {
    console.warn('cleanup failed', e?.message);
  }
}

function getIdempotencyKey(req, fallback = '') {
  const raw = String(req.headers['idempotency-key'] || fallback || '').trim();
  if (!raw) return '';
  if (raw.length > 128 || /[\r\n]/.test(raw)) throw new AgentError('INVALID_BODY', 'Idempotency key is invalid.', 400);
  return raw;
}
¶»§q«^t()•áÁ½ÉĞ‘•™…Õ±Ğ…Íå¹Œ™Õ¹Ñ¥½¸µ…¥¸¡É•Ä°É•Ì¤ì(€½¹ÍĞ‰…Í”€ô½É¥¥¸¡É•Ä¤ì(€ÑÉäì(€€€É•ÑÕÉ¸…İ…¥Ğ¡…¹‘±•È¡É•Ä°É•Ì¤ì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€½¹ÍĞÍ…™”€ô•ÉÉ½È¥¹ÍÑ…¹•½˜•¹ÑÉÉ½È€ü•ÉÉ½È€è¹•Ü•¹ÑÉÉ½È %9QI91}II=Hœ°€M•ÉÙ•È•ÉÉ½È¸œ°€ÔÀÀ¤ì(€€€¥˜€ „¡•ÉÉ½È¥¹ÍÑ…¹•½˜•¹ÑÉÉ½È¤¤½¹Í½±”¹•ÉÉ½È¡•ÉÉ½È¤ì(€€€¥˜€¡Í…™”¹‘•Ñ…¥±Ìü¹É•ÑÉå™Ñ•È¤É•Ì¹Í•Ñ!•…‘•È I•ÑÉäµ™Ñ•Èœ°MÑÉ¥¹œ¡Í…™”¹‘•Ñ…¥±Ì¹É•ÑÉå™Ñ•È¤¤ì(€€€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•Ì°Í…™”¹ÍÑ…ÑÕÌñğ€ÔÀÀ°•ÉÉ½É	½‘ä¡Í…™”¤°ì…¡”è€¹¼µÍÑ½É”œ°‰…Í”ô¤ì(€ô)ô(