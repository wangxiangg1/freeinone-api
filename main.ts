import { Hono } from "jsr:@hono/hono@^4";
import { cors } from "jsr:@hono/hono@^4/cors";
import * as v from "jsr:@valibot/valibot@^1";

let htmlContent = "";
try {
  htmlContent = await Deno.readTextFile(new URL("./admin.html", import.meta.url));
} catch (e) {
  console.error("Failed to read admin.html", e);
}

let configCache: any = null;
let configCacheTime = 0;
const CACHE_TTL_MS = 5000;

let configFetchPromise: Promise<any> | null = null;
let configCacheGeneration = 0;
const configKey = "CONFIG_V2";
const legacyConfigKey = "CONFIG";
const textEncoder = new TextEncoder();

let kv: Deno.Kv | null = null;
try {
  kv = await Deno.openKv();
} catch (e: any) {
  console.error("Failed to open Deno KV", e);
}

const app = new Hono();

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "x-requested-with"],
  maxAge: 86400
}));

app.get("/", (c) => Response.redirect(new URL("/admin", c.req.url).toString(), 302));

["/admin", "/admin/"].forEach((path) => app.get(path, () => adminHtmlResponse()));

["/api/config", "/api/config/", "/api/config/*"].forEach((path) =>
  app.all(path, (c) => handleAdminApi(c.req.raw))
);

["/v1/models", "/v1/models/"].forEach((path) =>
  app.get(path, (c) => handleModelsList(c.req.raw))
);

app.all("/v1/*", (c) => handleProxy(c.req.raw));

app.notFound(() =>
  jsonResponse({ error: { message: "Not Found", type: "invalid_request_error", code: "404" } }, 404)
);

app.onError((err) => {
  console.error(err);
  return jsonResponse({ message: "Internal Server Error" }, 500);
});

Deno.serve(app.fetch);

// --- Helpers ---
function adminHtmlResponse() {
  return new Response(htmlContent, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'Access-Control-Allow-Origin': '*'
  } });
}

function jsonResponse(body: any, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json',
    ...getCorsHeaders(),
    ...extraHeaders
  } });
}

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-requested-with',
    'Access-Control-Expose-Headers': 'X-Freeone-Channel, X-Freeone-Attempt',
    'Access-Control-Max-Age': '86400'
  };
}

async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string, salt: string }> {
  const salt = saltHex ? hexToUint8(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", textEncoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const derivedBits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, 256);
  return { hash: uint8ToHex(new Uint8Array(derivedBits)), salt: uint8ToHex(salt) };
}

async function sha256(message: string) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', textEncoder.encode(message));
  return uint8ToHex(new Uint8Array(hashBuffer));
}

function uint8ToHex(buf: Uint8Array) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToUint8(hex: string) {
  return Uint8Array.from(
    { length: Math.ceil(hex.length / 2) },
    (_, i) => parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  );
}

function timingSafeEqual(a: string, b: string) {
  const ab = textEncoder.encode(a), bb = textEncoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function parseKvValue(value: unknown, fallback: any = null) {
  return value ? (typeof value === 'string' ? JSON.parse(value) : value) : fallback;
}

async function getRawConfig() {
  const now = Date.now();
  if (configCache && (now - configCacheTime < CACHE_TTL_MS)) return configCache;
  if (configFetchPromise) return configFetchPromise;

  const readGeneration = configCacheGeneration;
  configFetchPromise = (async () => {
    try {
      if (!kv) throw new Error("KV not init");
      const result = await kv.get([configKey]);
      const freshConfig = parseKvValue(result.value);
      if (readGeneration === configCacheGeneration) {
        configCache = freshConfig;
        configCacheTime = Date.now();
      }
      return configCache;
    } catch (e) {
      console.error("Failed to read config", e);
      throw e;
    } finally {
      configFetchPromise = null;
    }
  })();
  
  return configFetchPromise;
}

async function updateConfig(modifier: (config: any) => any) {
  if (!kv) throw new Error('KV unavailable');
  for (let retries = 5; retries > 0; retries--) {
    const res = await kv.get([configKey]);
    const currentConfig = parseKvValue(res.value, {});

    // N5: cleanup sessions on every write
    if (currentConfig.sessions) currentConfig.sessions = currentConfig.sessions.filter((s: any) => s.expiresAt > Date.now());

    const newConfig = modifier(currentConfig);
    const commitRes = await kv.atomic().check(res).set([configKey], JSON.stringify(newConfig)).commit();
    if (commitRes.ok) {
      configCacheGeneration++;
      configCache = newConfig;
      configCacheTime = Date.now();
      return newConfig;
    }
  }
  throw new ConcurrentWriteError();
}

async function getLegacyConfig() {
  if (!kv) throw new Error('KV unavailable');
  const result = await kv.get([legacyConfigKey]);
  return parseKvValue(result.value);
}

function getLegacyMigrationInfo(legacyConfig: any) {
  return {
    migrationAvailable: typeof legacyConfig?.adminPasswordHash === 'string',
    legacyChannelCount: Array.isArray(legacyConfig?.channels) ? legacyConfig.channels.length : 0,
    legacyAccessKeyCount: Array.isArray(legacyConfig?.accessKeys) ? legacyConfig.accessKeys.length : 0
  };
}

function normalizeLegacyConfig(legacyConfig: any) {
  const stringArray = (value: any) => Array.isArray(value) ? value.filter((m: any) => typeof m === 'string') : [];
  const accessKeys = stringArray(legacyConfig?.accessKeys).filter((key: string) => key.trim());

  const channels = Array.isArray(legacyConfig?.channels)
    ? legacyConfig.channels.map((ch: any, index: number) => ({
      id: typeof ch.id === 'string' && ch.id ? ch.id : `ch_migrated_${Date.now()}_${index}`,
      name: typeof ch.name === 'string' && ch.name ? ch.name : `Migrated Channel ${index + 1}`,
      baseUrl: typeof ch.baseUrl === 'string' ? ch.baseUrl : '',
      weight: typeof ch.weight === 'number' ? ch.weight : 10,
      enabled: ch.enabled !== false,
      apiKey: typeof ch.apiKey === 'string' ? ch.apiKey : '',
      modelPrefix: typeof ch.modelPrefix === 'string' ? ch.modelPrefix : '',
      filterMode: ['none', 'keyword', 'manual'].includes(ch.filterMode) ? ch.filterMode : 'none',
      filterKeywords: typeof ch.filterKeywords === 'string' ? ch.filterKeywords : '',
      selectedModels: stringArray(ch.selectedModels),
      fetchedModels: stringArray(ch.fetchedModels),
      models: stringArray(ch.models)
    }))
    : [];

  return { accessKeys, channels };
}

class ConfigConflictError extends Error { constructor() { super('配置已被其他会话修改，请刷新后重试'); } }
class ConcurrentWriteError extends Error { constructor() { super('配置正在被其他会话修改，请稍后重试'); } }

function isWriteConflict(err: unknown) {
  return err instanceof ConfigConflictError || err instanceof ConcurrentWriteError;
}

const loginAttempts = new Map<string, { count: number, lockUntil: number }>();
function checkRateLimit(ip: string) {
  const record = loginAttempts.get(ip);
  return !record || Date.now() >= record.lockUntil;
}
function recordLoginFailure(ip: string) {
  const record = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };
  record.count++;
  if (record.count >= 5) {
    record.lockUntil = Date.now() + 60 * 1000;
    record.count = 0;
  }
  loginAttempts.set(ip, record);
}
function recordLoginSuccess(ip: string) { loginAttempts.delete(ip); }

async function isValidSession(token: string, config: any) {
  if (!config || !config.sessions) return false;
  const now = Date.now();
  const validSessions = config.sessions.filter((s: any) => s.expiresAt > now);
  const tokenHash = await sha256(token);
  return validSessions.some((s: any) => typeof s.tokenHash === 'string' && timingSafeEqual(s.tokenHash, tokenHash));
}

function getClientIp(request: Request) {
  const cfIp = request.headers.get('cf-connecting-ip')?.trim();
  if (cfIp) return cfIp;
  const forwardedFor = request.headers.get('x-forwarded-for') || '';
  const firstForwardedIp = forwardedFor.split(',')[0]?.trim();
  return firstForwardedIp || 'unknown';
}

const passwordInputSchema = v.pipe(v.string(), v.minLength(6));
const adminPostSchemas = {
  migrateV1: v.object({ action: v.literal('migrate_v1'), oldPassword: v.string(), newPassword: passwordInputSchema }),
  init: v.object({ action: v.literal('init'), password: passwordInputSchema }),
  login: v.object({ action: v.literal('login'), password: v.optional(v.string()) }),
  update: v.object({ action: v.literal('update'), config: v.unknown() }),
  changePassword: v.object({ action: v.literal('changePassword'), oldPassword: v.string(), newPassword: passwordInputSchema }),
  ping: v.object({ action: v.literal('ping'), channelId: v.string() }),
  fetchUpstreamModels: v.object({ action: v.literal('fetch_upstream_models'), baseUrl: v.string(), apiKey: v.string() })
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAdminBody(schema: any, body: unknown) {
  const result = v.safeParse(schema, body);
  return result.success ? result.output : null;
}

function getStringField(body: Record<string, unknown>, field: string) {
  return typeof body[field] === 'string' ? body[field] : '';
}

async function readJsonRecord(request: Request) {
  const body = await request.json().catch(() => ({}));
  return isRecord(body) ? body : {};
}

async function writeAction(label: string, fallbackMessage: string, action: () => Promise<Response>) {
  try {
    return await action();
  } catch (e) {
    console.error(label, e);
    return jsonResponse({ message: isWriteConflict(e) ? (e as Error).message : fallbackMessage }, isWriteConflict(e) ? 409 : 500);
  }
}

// --- Admin API ---
async function handleAdminApi(request: Request) {
  let config;
  try {
    config = await getRawConfig();
  } catch (_err) {
    return jsonResponse({ message: 'KV unavailable' }, 500);
  }
  
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const isAuthenticated = await isValidSession(token, config);

  if (request.method === 'GET') return getAdminConfig(config, isAuthenticated);
  if (request.method !== 'POST') return jsonResponse({ message: 'Method Not Allowed' }, 405);
  if (!kv) return jsonResponse({ message: 'KV unavailable' }, 500); // N1

  const body = await readJsonRecord(request);
  const action = getStringField(body, 'action');

  switch (action) {
    case 'migrate_v1': return migrateV1Config(request, config, body);
    case 'init': return initAdminConfig(config, body);
    case 'login': return loginAdmin(request, config, body);
  }

  if (!isAuthenticated) return jsonResponse({ message: 'Unauthorized' }, 401);

  switch (action) {
    case 'update': return updateAdminConfig(body);
    case 'changePassword': return changeAdminPassword(config, body);
    case 'ping': return pingChannel(config, body);
    case 'fetch_upstream_models': return fetchUpstreamModels(body);
    default: return jsonResponse({ message: 'Invalid action' }, 400);
  }
}

async function getAdminConfig(config: any, isAuthenticated: boolean) {
  if (!config) {
    const legacyConfig = await getLegacyConfig().catch(() => null);
    return jsonResponse({ message: 'Uninitialized', ...getLegacyMigrationInfo(legacyConfig) }, 412);
  }
  if (!isAuthenticated) return jsonResponse({ message: 'Unauthorized' }, 401);

  return jsonResponse({
    initialized: true,
    configVersion: config.configVersion || 0,
    accessKeys: config.accessKeys || [],
    channels: (config.channels || []).map(({ id, name, baseUrl, weight, enabled, apiKey, modelPrefix = '', filterMode = 'none', filterKeywords = '', selectedModels = [], fetchedModels = [], models = [] }: any) => ({
      id, name, baseUrl, weight, enabled, apiKey, modelPrefix, filterMode, filterKeywords, selectedModels, fetchedModels, models
    }))
  });
}

async function migrateV1Config(request: Request, config: any, body: Record<string, unknown>) {
  if (config) return jsonResponse({ message: 'V2 already initialized' }, 400);
  const parsedBody = parseAdminBody(adminPostSchemas.migrateV1, body);
  const oldPassword = parsedBody?.oldPassword ?? getStringField(body, 'oldPassword');
  const newPassword = parsedBody?.newPassword ?? getStringField(body, 'newPassword');
  if (!oldPassword) return jsonResponse({ message: '请输入旧版面板密码' }, 400);
  if (!newPassword || newPassword.length < 6) return jsonResponse({ message: '新面板密码至少为6位' }, 400);

  const clientIp = getClientIp(request);
  if (!checkRateLimit(clientIp)) return jsonResponse({ message: 'Too many attempts, locked for 1 min' }, 429);

  const legacyConfig = await getLegacyConfig().catch(() => null);
  if (typeof legacyConfig?.adminPasswordHash !== 'string') return jsonResponse({ message: '未检测到可迁移的 V1 配置' }, 404);
  if (!timingSafeEqual(await sha256(oldPassword || ''), legacyConfig.adminPasswordHash)) {
    recordLoginFailure(clientIp);
    return jsonResponse({ message: '旧版面板密码错误' }, 401);
  }

  recordLoginSuccess(clientIp);
  const { hash, salt } = await hashPassword(newPassword);
  const migrated = normalizeLegacyConfig(legacyConfig);
  return writeAction("V1 migration failed:", '迁移失败', async () => {
    await updateConfig((c: any) => {
      if (c.initialized) throw new ConfigConflictError();
      return {
        initialized: true,
        adminPasswordHash: hash,
        adminPasswordSalt: salt,
        accessKeys: migrated.accessKeys,
        channels: migrated.channels,
        sessions: [],
        migratedFrom: 'CONFIG',
        migratedAt: new Date().toISOString(),
        configVersion: 1
      };
    });
    return jsonResponse({ message: 'V1 配置迁移完成', channelCount: migrated.channels.length, accessKeyCount: migrated.accessKeys.length });
  });
}

async function initAdminConfig(config: any, body: Record<string, unknown>) {
  if (config) return jsonResponse({ message: 'Already initialized' }, 400);
  const parsedBody = parseAdminBody(adminPostSchemas.init, body);
  const password = parsedBody?.password ?? getStringField(body, 'password');
  if (!password || password.length < 6) return jsonResponse({ message: 'Password too short' }, 400);

  const { hash, salt } = await hashPassword(password);
  return writeAction("Init failed:", 'Init failed', async () => {
    await updateConfig((c: any) => {
      if (c.initialized) throw new ConfigConflictError();
      return { initialized: true, adminPasswordHash: hash, adminPasswordSalt: salt, accessKeys: [], channels: [], sessions: [], configVersion: 1 };
    });
    return jsonResponse({ message: 'Initialized successfully' });
  });
}

async function loginAdmin(request: Request, config: any, body: Record<string, unknown>) {
  if (!config) return jsonResponse({ message: 'Uninitialized' }, 412);
  const clientIp = getClientIp(request);
  if (!checkRateLimit(clientIp)) return jsonResponse({ message: 'Too many attempts, locked for 1 min' }, 429);

  const parsedBody = parseAdminBody(adminPostSchemas.login, body);
  const password = parsedBody?.password ?? '';
  const { hash } = await hashPassword(password, config.adminPasswordSalt);
  if (!timingSafeEqual(hash, config.adminPasswordHash)) {
    recordLoginFailure(clientIp);
    return jsonResponse({ message: 'Invalid password' }, 401);
  }

  recordLoginSuccess(clientIp);
  const sessionToken = crypto.randomUUID();
  const tokenHash = await sha256(sessionToken);
  return writeAction("Login session write failed:", 'Login failed', async () => {
    await updateConfig((c: any) => {
      if (!c.sessions) c.sessions = [];
      c.sessions.push({ tokenHash, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7 }); // 7 days
      return c;
    });
    return jsonResponse({ token: sessionToken });
  });
}

async function updateAdminConfig(body: Record<string, unknown>) {
  const clientConfig = parseAdminBody(adminPostSchemas.update, body)?.config;
  if (!clientConfig) return jsonResponse({ message: 'Missing config' }, 400);

  return writeAction("Config update failed:", 'Update failed', async () => {
    const updatedConfig = await updateConfig((c: any) => {
      const currentVersion = c.configVersion || 0;
      if (typeof clientConfig.configVersion === 'number' && clientConfig.configVersion !== currentVersion) throw new ConfigConflictError();
      c.accessKeys = clientConfig.accessKeys || [];
      c.channels = clientConfig.channels || [];
      c.configVersion = currentVersion + 1;
      return c;
    });
    return jsonResponse({ message: 'Updated', configVersion: updatedConfig.configVersion });
  });
}

async function changeAdminPassword(config: any, body: Record<string, unknown>) {
  const parsedBody = parseAdminBody(adminPostSchemas.changePassword, body);
  const oldPassword = parsedBody?.oldPassword ?? getStringField(body, 'oldPassword');
  const newPassword = parsedBody?.newPassword ?? getStringField(body, 'newPassword');
  const { hash: oldHash } = await hashPassword(oldPassword || '', config.adminPasswordSalt);
  if (!timingSafeEqual(oldHash, config.adminPasswordHash)) return jsonResponse({ message: '旧密码输入错误' }, 400);
  if (!newPassword || newPassword.length < 6) return jsonResponse({ message: '新密码至少为6位' }, 400);

  const { hash, salt } = await hashPassword(newPassword);
  return writeAction("Password update failed:", 'Update failed', async () => {
    await updateConfig((c: any) => {
      c.adminPasswordHash = hash;
      c.adminPasswordSalt = salt;
      c.sessions = []; // Invalidate all sessions
      c.configVersion = (c.configVersion || 0) + 1;
      return c;
    });
    return jsonResponse({ message: 'Password updated successfully' });
  });
}

async function pingChannel(config: any, body: Record<string, unknown>) {
  const channelId = parseAdminBody(adminPostSchemas.ping, body)?.channelId;
  const ch = (config.channels || []).find((c: any) => c.id === channelId);
  if (!ch) return jsonResponse({ message: 'Channel not found' }, 404);

  try {
    const pingRes = await fetchModelsEndpoint(ch.baseUrl, ch.apiKey, 5000);
    return jsonResponse({ status: 'ok', statusCode: pingRes.status });
  } catch (_err) {
    return jsonResponse({ status: 'error', error: 'Fetch failed' });
  }
}

function fetchModelsEndpoint(baseUrl: string, apiKey: string, timeoutMs: number) {
  return fetch(getTargetUrl(baseUrl, '/v1/models'), {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs)
  });
}

async function fetchUpstreamModels(body: Record<string, unknown>) {
  const parsedBody = parseAdminBody(adminPostSchemas.fetchUpstreamModels, body);
  const baseUrl = parsedBody?.baseUrl ?? getStringField(body, 'baseUrl');
  const apiKey = parsedBody?.apiKey ?? getStringField(body, 'apiKey');
  if (!baseUrl || !apiKey) return jsonResponse({ message: 'Missing params' }, 400);

  try {
    const modelsRes = await fetchModelsEndpoint(baseUrl, apiKey, 10000);
    if (!modelsRes.ok) return jsonResponse({ status: 'error', message: `HTTP ${modelsRes.status}` });
    const data = await modelsRes.json();
    return jsonResponse({ status: 'ok', models: (data.data || []).map((m: any) => m.id) });
  } catch (_err) {
    return jsonResponse({ status: 'error', message: 'Fetch error' });
  }
}

// --- Proxy ---
async function getAuthorizedGatewayConfig(request: Request, initMessage: string) {
  let config;
  try {
    config = await getRawConfig();
  } catch (_err) {
    return jsonResponse({ error: { message: 'Gateway storage unavailable' } }, 503);
  }
  if (!config) return jsonResponse({ error: { message: initMessage } }, 503);

  const clientKey = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!(config.accessKeys || []).some((k: string) => timingSafeEqual(k, clientKey))) {
    return jsonResponse({ error: { message: 'Incorrect API key', code: 'invalid_api_key' } }, 401);
  }
  return config;
}

async function handleModelsList(request: Request) {
  const config = await getAuthorizedGatewayConfig(request, 'Gateway not initialized');
  if (config instanceof Response) return config;

  const modelSet = new Set();
  const enabledChannels = (config.channels || []).filter((ch: any) => ch.enabled);
  for (const ch of enabledChannels) {
    if (Array.isArray(ch.models)) ch.models.forEach((m: string) => modelSet.add(m));
  }

  const modelsData = Array.from(modelSet).map(id => ({
    id, object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'cf-free-all'
  }));
  return jsonResponse({ object: 'list', data: modelsData });
}

async function handleProxy(request: Request) {
  const config = await getAuthorizedGatewayConfig(request, 'Gateway not init');
  if (config instanceof Response) return config;

  const enabledChannels = (config.channels || []).filter((ch: any) => ch.enabled);
  if (enabledChannels.length === 0) return jsonResponse({ error: { message: 'No channels' } }, 503);

  const reqUrl = new URL(request.url);
  const isHasBody = ['POST', 'PUT', 'PATCH'].includes(request.method);
  const isJson = (request.headers.get('content-type') || '').includes('application/json');

  let parsedBody: any = null;
  let requestedModel = '';
  let bodyBuffer: ArrayBuffer | null = null;
  let requestBodyText = '';

  if (isHasBody) {
    if (isJson) {
      try {
        requestBodyText = await request.text();
        parsedBody = JSON.parse(requestBodyText);
        requestedModel = parsedBody.model || '';
      } catch (e) { /* ignore */ }
    } else {
      bodyBuffer = await request.arrayBuffer(); // Read into buffer once
    }
  }

  let candidateChannels = enabledChannels;
  if (requestedModel) {
    candidateChannels = enabledChannels.filter((ch: any) => channelSupportsModel(ch, requestedModel));
  }

  if (candidateChannels.length === 0) {
    return jsonResponse({ error: { message: `Model '${requestedModel}' not supported` } }, 404);
  }

  let attempts = 0;
  // Try every eligible channel at most once, with a safety cap for latency.
  const maxAttempts = Math.min(candidateChannels.length, 5);
  let remainingCandidates = [...candidateChannels];
  
  while (attempts < maxAttempts && remainingCandidates.length > 0) {
    attempts++;
    const selectedChannel = selectChannelWeightedStateless(remainingCandidates);
    if (!selectedChannel) break;

    const targetUrl = getTargetUrl(selectedChannel.baseUrl, reqUrl.pathname + reqUrl.search);
    const upstreamModel = getOriginalModelForChannel(selectedChannel, requestedModel) || requestedModel;

    let finalBody: BodyInit | null = null;
    if (isHasBody) {
      if (isJson) {
        if (parsedBody && requestedModel !== upstreamModel) {
          finalBody = JSON.stringify({ ...parsedBody, model: upstreamModel });
        } else {
          finalBody = requestBodyText;
        }
      } else {
        finalBody = bodyBuffer ? bodyBuffer.slice(0) : null; // N2: clone ArrayBuffer for retry
      }
    }

    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${selectedChannel.apiKey}`);
    ['Host', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'x-forwarded-for', 'x-real-ip', 'cookie', 'Content-Length'].forEach(h => headers.delete(h));

    const forwardRequest = new Request(targetUrl, {
      method: request.method,
      headers,
      body: finalBody,
      redirect: 'follow'
    });

    try {
      const upstreamResponse = await fetch(forwardRequest);
      if (isRetryableUpstreamStatus(upstreamResponse.status) && attempts < maxAttempts && remainingCandidates.length > 1) {
        remainingCandidates = remainingCandidates.filter(c => c.id !== selectedChannel.id);
        if (upstreamResponse.body) await upstreamResponse.body.cancel().catch(()=>{});
        continue;
      }

      const responseHeaders = new Headers(upstreamResponse.headers);
      ['Content-Encoding', 'Content-Length', 'Transfer-Encoding'].forEach(h => responseHeaders.delete(h));
      Object.entries(getCorsHeaders()).forEach(([k, v]) => responseHeaders.set(k, v));
      const selectedChannelIndex = enabledChannels.findIndex((channel: any) => channel.id === selectedChannel.id);
      const anonymousChannelLabel = selectedChannelIndex >= 0 ? `channel-${selectedChannelIndex + 1}` : 'channel-unknown';
      responseHeaders.set('X-Freeone-Channel', anonymousChannelLabel);
      responseHeaders.set('X-Freeone-Attempt', String(attempts));

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders
      });
    } catch (err: any) {
      console.error("Proxy fetch error:", err.message); // N6: Do not leak to user
      if (attempts < maxAttempts && remainingCandidates.length > 1) {
        remainingCandidates = remainingCandidates.filter(c => c.id !== selectedChannel.id);
        continue;
      }
      break;
    }
  }

  return jsonResponse({ error: { message: `Upstream routing failed. Attempts: ${attempts}.` } }, 502); // N6
}

function getTargetUrl(baseUrl: string, requestPath: string) {
  const base = baseUrl.replace(/\/+$/, '');
  const path = requestPath.startsWith('/') ? requestPath : '/' + requestPath;
  if (base.endsWith('/v1') && path.startsWith('/v1/')) return base + path.substring(3);
  return base + path;
}

function getOriginalModelForChannel(channel: any, requestedModel: string) {
  if (!requestedModel) return '';
  const prefix = (channel.modelPrefix || '').replace(/\/+$/, '');
  if (!prefix) return requestedModel;
  if (!requestedModel.startsWith(prefix + '/')) return null;
  return requestedModel.substring(prefix.length + 1);
}

function channelSupportsModel(channel: any, requestedModel: string) {
  if (Array.isArray(channel.models) && channel.models.includes(requestedModel)) return true;

  const originalModel = getOriginalModelForChannel(channel, requestedModel);
  if (!originalModel) return false;

  const fetchedModels = channel.fetchedModels || [];
  const savedModels = channel.models || [];
  const mode = channel.filterMode || 'none';

  if (mode === 'none' && fetchedModels.length === 0 && savedModels.length === 0) {
    return true;
  }

  return applyKeywordFilter(fetchedModels, mode, channel.filterKeywords || '', channel.selectedModels || []).includes(originalModel);
}

// N4: Unified keyword filtering function
function applyKeywordFilter(fetchedModels: string[], mode: string, filterKeywords: string, selectedModels: string[]) {
  if (mode === 'none') return fetchedModels;
  if (mode === 'keyword') {
    const kw = filterKeywords.split(',').map((k: string) => k.trim().toLowerCase()).filter((k: string) => k);
    if (!kw.length) return fetchedModels;
    return fetchedModels.filter((m: string) => kw.some((k: string) => m.toLowerCase().includes(k)));
  }
  if (mode === 'manual') return selectedModels;
  return fetchedModels;
}

function isRetryableUpstreamStatus(status: number) {
  return status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function normalizedChannelWeight(channel: any) {
  const weight = Number(channel?.weight ?? 10);
  return Number.isFinite(weight) && weight > 0 ? weight : 10;
}

// Deno Deploy is stateless across isolates. Use a state-free weighted draw so
// routing does not depend on an in-memory cursor that resets on cold starts.
function selectChannelWeightedStateless(channels: any[]) {
  if (!channels.length) return null;
  if (channels.length === 1) return channels[0];

  const totalWeight = channels.reduce((sum, channel) => sum + normalizedChannelWeight(channel), 0);
  const randomBytes = crypto.getRandomValues(new Uint32Array(1));
  let draw = (randomBytes[0] / 0x100000000) * totalWeight;

  for (const channel of channels) {
    draw -= normalizedChannelWeight(channel);
    if (draw < 0) return channel;
  }
  return channels[channels.length - 1];
}
