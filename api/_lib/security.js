import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

export class AgentError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const LIMITS = Object.freeze({
  queryBytes: 8192,
  relayUrlBytes: 2048,
  relayRequestBytes: 16 * 1024,
  relayResponseBytes: 512 * 1024,
  publishBytes: 12 * 1024,
  relayTimeoutMs: 8000,
  relayMaxTimeoutMs: 10000,
  relayRedirects: 3,
});

const utf8Bytes = value => Buffer.byteLength(String(value ?? ''), 'utf8');
export const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

export const requestFingerprint = value => sha256(stable(value));

export function clientHash(req, secret = process.env.CLIENT_HASH_SECRET || process.env.DATABASE_URL || 'agentsite-dev-only') {
  const rawIp = String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0].trim();
  const ua = String(req?.headers?.['user-agent'] || '').slice(0, 300);
  const day = new Date().toISOString().slice(0, 10);
  return crypto.createHmac('sha256', secret).update(`${day}\n${rawIp}\n${ua}`).digest('hex');
}

export function ensureExecutableGet(req) {
  if (String(req.method || '').toUpperCase() !== 'GET') throw new AgentError('METHOD_NOT_ALLOWED', 'This action must be executed with GET.', 405);
  const markers = [
    req.headers?.purpose,
    req.headers?.['sec-purpose'],
    req.headers?.['x-purpose'],
    req.headers?.['x-moz'],
  ].filter(Boolean).join(' ').toLowerCase();
  if (/prefetch|prerender|preview/.test(markers)) throw new AgentError('PREFETCH_BLOCKED', 'Prefetch and prerender requests cannot execute actions.', 409);
}

export function enforceQueryLength(req) {
  const raw = req?.url || '';
  if (utf8Bytes(raw) > LIMITS.queryBytes) throw new AgentError('QUERY_TOO_LARGE', 'Request URL is too large.', 414);
}

export function assessTokenRecord(row, { family, client, requestHash }) {
  if (!row) return { ok: false, code: 'INVALID_ACTION_TOKEN', status: 403, message: 'Action token is invalid.' };
  if (String(row.action_family) !== String(family)) return { ok: false, code: 'ACTION_TOKEN_SCOPE_MISMATCH', status: 403, message: 'Action token is for a different action family.' };
  if (String(row.client_hash) !== String(client)) return { ok: false, code: 'ACTION_TOKEN_CLIENT_MISMATCH', status: 403, message: 'Action token is bound to a different client.' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, code: 'ACTION_TOKEN_EXPIRED', status: 410, message: 'Action token has expired.' };
  if (!row.used_at) return { ok: true, replay: false };
  if (row.request_hash && row.request_hash === requestHash && row.result_json != null) return { ok: true, replay: true, statusCode: Number(row.status_code || 200), result: row.result_json };
  return { ok: false, code: 'ACTION_TOKEN_USED', status: 409, message: 'Action token has already been used.' };
}

export function requireActionToken(value) {
  const token = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new AgentError('INVALID_ACTION_TOKEN', 'A valid one-use action token is required.', 403);
  return token;
}

export function parsePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return fallback;
  return Math.min(n, max);
}

export const isMutationMethod = method => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
export function normalizeRelayMethod(method) {
  const m = String(method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(m)) throw new AgentError('RELAY_METHOD_BLOCKED', 'Relay method is not allowed.', 405);
  return m;
}

const blockedSuffixes = ['.localhost', '.local', '.internal', '.home', '.lan', '.localdomain'];
function normalizeHost(host) { return String(host || '').trim().toLowerCase().replace(/\.$/, ''); }

function ipv4Number(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] * 2 ** 24) + (p[1] * 2 ** 16) + (p[2] * 2 ** 8) + p[3]) >>> 0;
}
function inV4(ip, base, bits) {
  const a = ipv4Number(ip), b = ipv4Number(base);
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

const v4Blocked = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function normalizeMappedV4(ip) {
  const lower = ip.toLowerCase();
  const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  const h = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!h) return null;
  const hi = parseInt(h[1], 16), lo = parseInt(h[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPublicIp(address) {
  const ip = String(address || '').toLowerCase();
  const version = net.isIP(ip);
  if (version === 4) return !v4Blocked.some(([base, bits]) => inV4(ip, base, bits));
  if (version !== 6) return false;
  const mapped = normalizeMappedV4(ip);
  if (mapped) return isPublicIp(mapped);
  if (ip === '::' || ip === '::1') return false;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return false;
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return false;
  if (/^ff/i.test(ip)) return false;
  if (!/^[23][0-9a-f]{0,3}:/i.test(ip)) return false;
  if (/^2001:db8:/i.test(ip)) return false;
  if (/^2001:0?2:/i.test(ip)) return false;
  if (/^2001:(?:0?1[0-9a-f]|0?2[0-9a-f]):/i.test(ip)) return false;
  return true;
}

export async function validateRelayDestination(input, { resolver = dns.lookup, blockedHosts = [] } = {}) {
  if (utf8Bytes(input) > LIMITS.relayUrlBytes) throw new AgentError('RELAY_URL_TOO_LARGE', 'Relay destination URL is too large.', 414);
  let url;
  try { url = new URL(String(input)); } catch { throw new AgentError('INVALID_RELAY_URL', 'Relay destination must be a valid HTTPS URL.', 400); }
  if (url.protocol !== 'https:') throw new AgentError('RELAY_SCHEME_BLOCKED', 'Relay supports HTTPS only.', 400);
  if (url.port && url.port !== '443') throw new AgentError('RELAY_PORT_BLOCKED', 'Relay supports HTTPS port 443 only.', 400);
  if (url.username || url.password) throw new AgentError('RELAY_CREDENTIALS_BLOCKED', 'Credentials may not be embedded in relay URLs.', 400);
  for (const key of url.searchParams.keys()) if (credentialKey.test(key)) throw new AgentError('RELAY_CREDENTIALS_BLOCKED', 'Credential-like query parameters are not allowed in relay destinations.', 400);
  const host = normalizeHost(url.hostname);
  if (!host) throw new AgentError('INVALID_RELAY_URL', 'Relay destination hostname is missing.', 400);
  const allBlocked = new Set([...blockedHosts, ...KNOWN_SELF_HOSTS].map(normalizeHost).filter(Boolean));
  if (host === 'localhost' || blockedSuffixes.some(s => host.endsWith(s)) || allBlocked.has(host)) throw new AgentError('RELAY_DESTINATION_BLOCKED', 'Relay destination is not allowed.', 403);

  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new AgentError('RELAY_PRIVATE_ADDRESS', 'Relay destination resolves to a private or reserved address.', 403);
    return { url, host, addresses: [{ address: host, family: net.isIP(host) }] };
  }

  let answers;
  try { answers = await resolver(host, { all: true, verbatim: true }); } catch { throw new AgentError('RELAY_DNS_FAILED', 'Relay destination could not be resolved.', 502); }
  if (!Array.isArray(answers)) answers = [answers];
  const addresses = answers.map(a => typeof a === 'string' ? { address: a, family: net.isIP(a) } : a).filter(a => a?.address);
  if (!addresses.length) throw new AgentError('RELAY_DNS_FAILED', 'Relay destination returned no addresses.', 502);
  if (addresses.some(a => !isPublicIp(a.address))) throw new AgentError('RELAY_PRIVATE_ADDRESS', 'Relay destination includes a private or reserved address.', 403);
  return { url, host, addresses };
}

export const KNOWN_SELF_HOSTS = [
  'agentsite-live-figgy-ops-projects.vercel.app',
  'agentsite-live-bawxp1le4-figgy-ops-projects.vercel.app',
  'agentsite-figgy-ops-projects.vercel.app',
];

const allowedOutbound = new Set(['accept', 'content-type', 'if-none-match', 'if-modified-since']);
export function sanitizeOutboundHeaders(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    const k = String(key).toLowerCase();
    if (!allowedOutbound.has(k)) continue;
    const v = String(value ?? '').replace(/[\r\n]/g, '').slice(0, 1024);
    if (v) out[k] = v;
  }
  out['user-agent'] = 'AgentSite-Relay/1.0';
  return out;
}

const credentialKey = /(^|[_-])(password|passwd|secret|token|api[_-]?key|authorization|cookie|session|credential|private[_-]?key|access[_-]?key)($|[_-])/i;
function hasCredentialKey(value, depth = 0) {
  if (depth > 6 || value == null) return false;
  if (Array.isArray(value)) return value.some(v => hasCredentialKey(v, depth + 1));
  if (typeof value !== 'object') return false;
  return Object.entries(value).some(([k, v]) => credentialKey.test(k) || hasCredentialKey(v, depth + 1));
}

export function encodeRelayBody(body, contentType = 'text/plain') {
  if (body == null || body === '') return null;
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  const supported = new Set(['application/json', 'text/plain', 'application/xml', 'text/xml', 'application/x-www-form-urlencoded']);
  if (!supported.has(ct)) throw new AgentError('RELAY_CONTENT_TYPE_BLOCKED', 'Relay request content type is not supported.', 415);
  let text = String(body);
  if (ct === 'application/json') {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new AgentError('INVALID_RELAY_BODY', 'Relay JSON body is invalid.', 400); }
    if (hasCredentialKey(parsed)) throw new AgentError('RELAY_CREDENTIALS_BLOCKED', 'Credential-like fields are not allowed in relay bodies.', 400);
    text = JSON.stringify(parsed);
  } else if (ct === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(text);
    for (const key of params.keys()) if (credentialKey.test(key)) throw new AgentError('RELAY_CREDENTIALS_BLOCKED', 'Credential-like fields are not allowed in relay bodies.', 400);
  }
  if (utf8Bytes(text) > LIMITS.relayRequestBytes) throw new AgentError('RELAY_REQUEST_TOO_LARGE', 'Relay request body is too large.', 413);
  return Buffer.from(text, 'utf8');
}

const safeResponseHeaders = new Set(['content-type', 'content-length', 'cache-control', 'etag', 'last-modified', 'location']);
export function safeRelayResponseHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (safeResponseHeaders.has(String(k).toLowerCase()) && v != null) out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

function pinnedLookup(addresses) {
  let index = 0;
  return (_hostname, options, callback) => {
    const candidates = options?.family ? addresses.filter(a => Number(a.family) === Number(options.family)) : addresses;
    const pick = candidates[index++ % Math.max(candidates.length, 1)] || addresses[0];
    callback(null, pick.address, Number(pick.family) || net.isIP(pick.address));
  };
}

function requestOnce(validated, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const opts = {
      protocol: 'https:', hostname: validated.host, port: 443,
      path: `${validated.url.pathname}${validated.url.search}`,
      method, headers,
      servername: net.isIP(validated.host) ? undefined : validated.host,
      lookup: pinnedLookup(validated.addresses),
      timeout: timeoutMs,
    };
    const req = https.request(opts, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > LIMITS.relayResponseBytes) {
          response.destroy(new AgentError('RELAY_RESPONSE_TOO_LARGE', 'Relay response exceeded the size limit.', 502));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: Number(response.statusCode || 0), headers: response.headers, body: Buffer.concat(chunks), bytes }));
    });
    req.on('timeout', () => req.destroy(new AgentError('RELAY_TIMEOUT', 'Relay request timed out.', 504)));
    req.on('error', reject);
    if (body && method !== 'HEAD') req.write(body);
    req.end();
  });
}

export async function relayRequest(input, {
  method = 'GET', headers = {}, body = null, contentType = 'text/plain', timeoutMs = LIMITS.relayTimeoutMs,
  maxRedirects = LIMITS.relayRedirects, blockedHosts = [], resolver = dns.lookup, requestFn = requestOnce,
} = {}) {
  method = normalizeRelayMethod(method);
  timeoutMs = Math.max(100, Math.min(Number(timeoutMs) || LIMITS.relayTimeoutMs, LIMITS.relayMaxTimeoutMs));
  const encodedBody = encodeRelayBody(body, contentType);
  const outbound = sanitizeOutboundHeaders(headers);
  if (encodedBody) {
    outbound['content-type'] = contentType;
    outbound['content-length'] = String(encodedBody.length);
  }
  let current = String(input); let redirects = 0; const started = Date.now();
  while (true) {
    const validated = await validateRelayDestination(current, { resolver, blockedHosts });
    const response = await requestFn(validated, { method, headers: outbound, body: encodedBody, timeoutMs });
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      if (redirects >= maxRedirects) throw new AgentError('RELAY_REDIRECT_LIMIT', 'Relay redirect limit exceeded.', 502);
      current = new URL(String(location), validated.url).toString();
      redirects += 1;
      continue;
    }
    const type = String(response.headers['content-type'] || '').toLowerCase();
    const textLike = /(^text\/)|json|xml|javascript|x-www-form-urlencoded/.test(type);
    return {
      status: response.status,
      headers: safeRelayResponseHeaders(response.headers),
      encoding: textLike ? 'utf-8' : 'base64',
      body: textLike ? response.body.toString('utf8') : response.body.toString('base64'),
      finalUrl: current,
      redirects,
      durationMs: Date.now() - started,
      requestBytes: encodedBody?.length || 0,
      responseBytes: response.bytes,
      destinationHost: new URL(current).hostname,
      method,
    };
  }
}

export function decodeRelayResponse(envelope) {
  return envelope.encoding === 'base64' ? Buffer.from(envelope.body, 'base64') : Buffer.from(envelope.body || '', 'utf8');
}
