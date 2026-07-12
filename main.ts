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
  allowHeaders: ["Content-Type", "Authorization", "x-requested-with", "x-goog-api-key"],
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

["/v1beta/models", "/v1beta/models/"].forEach((path) =>
  app.get(path, (c) => handleGeminiModelsList(c.req.raw))
);

app.all("/v1beta/*", (c) => handleGeminiProxy(c.req.raw));
app.all("/v1/*", (c) => handleOpenAIProxy(c.req.raw));

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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-requested-with, x-goog-api-key',
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

function stringArray(value: any) {
  return Array.isArray(value) ? value.filter((item: any) => typeof item === 'string') : [];
}

function normalizeChannel(channel: any, index: number) {
  const id = typeof channel?.id === 'string' && channel.id ? channel.id : `ch_normalized_${index}`;
  const rawKeys = Array.isArray(channel?.apiKeys)
    ? channel.apiKeys
    : (typeof channel?.apiKey === 'string' && channel.apiKey.trim()
      ? [{ id: `${id}_legacy_key`, key: channel.apiKey, enabled: true }]
      : []);
  const seenKeys = new Set<string>();
  const apiKeys = rawKeys.flatMap((entry: any, keyIndex: number) => {
    const key = typeof entry === 'string' ? entry.trim() : (typeof entry?.key === 'string' ? entry.key.trim() : '');
    if (!key || seenKeys.has(key)) return [];
    seenKeys.add(key);
    return [{
      id: typeof entry?.id === 'string' && entry.id ? entry.id : `${id}_key_${keyIndex}`,
      key,
      enabled: entry?.enabled !== false
    }];
  });
  const protocol = channel?.protocol === 'gemini' ? 'gemini' : 'openai';
  const filterMode = ['none', 'keyword', 'manual'].includes(channel?.filterMode) ? channel.filterMode : 'none';
  return {
    id,
    name: typeof channel?.name === 'string' && channel.name ? channel.name : `Channel ${index + 1}`,
    protocol,
    baseUrl: typeof channel?.baseUrl === 'string' ? channel.baseUrl : '',
    weight: Number.isFinite(Number(channel?.weight)) && Number(channel.weight) > 0 ? Number(channel.weight) : 10,
    enabled: channel?.enabled !== false,
    apiKeys,
    modelPrefix: typeof channel?.modelPrefix === 'string' ? channel.modelPrefix : '',
    filterMode,
    filterKeywords: typeof channel?.filterKeywords === 'string' ? channel.filterKeywords : '',
    selectedModels: stringArray(channel?.selectedModels),
    fetchedModels: stringArray(channel?.fetchedModels),
    models: stringArray(channel?.models),
    modelMetadata: channel?.modelMetadata && typeof channel.modelMetadata === 'object' && !Array.isArray(channel.modelMetadata)
      ? channel.modelMetadata
      : {}
  };
}

function normalizeConfigShape(config: any) {
  if (!config || typeof config !== 'object') return config;
  return {
    ...config,
    schemaVersion: 3,
    accessKeys: stringArray(config.accessKeys).map((key: string) => key.trim()).filter(Boolean),
    channels: Array.isArray(config.channels) ? config.channels.map(normalizeChannel) : []
  };
}

function expandRuntimeChannels(config: any, protocol: 'openai' | 'gemini') {
  const groups = Array.isArray(config?.channels) ? config.channels : [];
  return groups.flatMap((channel: any, parentIndex: number) => {
    if (!channel.enabled || channel.protocol !== protocol) return [];
    return (channel.apiKeys || []).flatMap((apiKey: any, keyIndex: number) => {
      if (!apiKey.enabled || !apiKey.key) return [];
      return [{
        ...channel,
        id: `${channel.id}::${apiKey.id}`,
        parentId: channel.id,
        keyId: apiKey.id,
        parentIndex,
        keyIndex,
        apiKey: apiKey.key
      }];
    });
  });
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
      const freshConfig = normalizeConfigShape(parseKvValue(result.value));
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
    const currentConfig = normalizeConfigShape(parseKvValue(res.value, {}));

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
  const accessKeys = stringArray(legacyConfig?.accessKeys).map((key: string) => key.trim()).filter(Boolean);
  const channels = Array.isArray(legacyConfig?.channels)
    ? legacyConfig.channels.map((channel: any, index: number) => normalizeChannel({
      ...channel,
      id: typeof channel?.id === 'string' && channel.id ? channel.id : `ch_migrated_${Date.now()}_${index}`,
      protocol: 'openai'
    }, index))
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
  ping: v.object({ action: v.literal('ping'), channelId: v.string(), keyId: v.optional(v.string()) }),
  fetchUpstreamModels: v.object({ action: v.literal('fetch_upstream_models'), baseUrl: v.string(), protocol: v.optional(v.string()), apiKeys: v.optional(v.array(v.string())), apiKey: v.optional(v.string()) })
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
    schemaVersion: 3,
    configVersion: config.configVersion || 0,
    accessKeys: config.accessKeys || [],
    channels: (config.channels || []).map((channel: any) => ({
      id: channel.id,
      name: channel.name,
      protocol: channel.protocol,
      baseUrl: channel.baseUrl,
      weight: channel.weight,
      enabled: channel.enabled,
      apiKeys: channel.apiKeys,
      modelPrefix: channel.modelPrefix || '',
      filterMode: channel.filterMode || 'none',
      filterKeywords: channel.filterKeywords || '',
      selectedModels: channel.selectedModels || [],
      fetchedModels: channel.fetchedModels || [],
      models: channel.models || [],
      modelMetadata: channel.modelMetadata || {}
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
        configVersion: 1,
        schemaVersion: 3
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
      return { initialized: true, adminPasswordHash: hash, adminPasswordSalt: salt, accessKeys: [], channels: [], sessions: [], configVersion: 1, schemaVersion: 3 };
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
      const normalizedClientConfig = normalizeConfigShape(clientConfig);
      if (normalizedClientConfig.channels.some((channel: any) => !channel.baseUrl || channel.apiKeys.length === 0)) {
        throw new Error('每个渠道都必须包含 Base URL 和至少一个 API Key');
      }
      c.accessKeys = normalizedClientConfig.accessKeys;
      c.channels = normalizedClientConfig.channels;
      c.schemaVersion = 3;
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
  const parsed = parseAdminBody(adminPostSchemas.ping, body);
  const channelId = parsed?.channelId;
  const keyId = parsed?.keyId;
  const channel = (config.channels || []).find((item: any) => item.id === channelId);
  if (!channel) return jsonResponse({ message: 'Channel not found' }, 404);
  const apiKey = (channel.apiKeys || []).find((item: any) => item.id === keyId) || (channel.apiKeys || []).find((item: any) => item.enabled);
  if (!apiKey) return jsonResponse({ message: 'API Key not found' }, 404);

  try {
    const pingRes = await fetchModelsEndpoint(channel.baseUrl, apiKey.key, channel.protocol, 5000);
    if (!pingRes.ok) return jsonResponse({ status: 'error', statusCode: pingRes.status });
    if (pingRes.body) await pingRes.body.cancel().catch(() => {});
    return jsonResponse({ status: 'ok', statusCode: pingRes.status });
  } catch (_err) {
    return jsonResponse({ status: 'error', error: 'Fetch failed' });
  }
}

function fetchModelsEndpoint(baseUrl: string, apiKey: string, protocol: string, timeoutMs: number) {
  const isGemini = protocol === 'gemini';
  const headers = isGemini
    ? { 'x-goog-api-key': apiKey }
    : { 'Authorization': `Bearer ${apiKey}` };
  return fetch(getTargetUrl(baseUrl, isGemini ? '/v1beta/models' : '/v1/models'), {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

async function fetchUpstreamModels(body: Record<string, unknown>) {
  const parsed = parseAdminBody(adminPostSchemas.fetchUpstreamModels, body);
  const baseUrl = parsed?.baseUrl ?? getStringField(body, 'baseUrl');
  const protocol = parsed?.protocol === 'gemini' ? 'gemini' : 'openai';
  const suppliedKeys = Array.isArray(parsed?.apiKeys) ? parsed.apiKeys : [];
  const legacyKey = parsed?.apiKey ?? getStringField(body, 'apiKey');
  const apiKeys = [...new Set([...suppliedKeys, legacyKey].map((key: string) => key.trim()).filter(Boolean))];
  if (!baseUrl || apiKeys.length === 0) return jsonResponse({ message: 'Missing params' }, 400);

  let lastMessage = 'Fetch error';
  for (const apiKey of apiKeys) {
    try {
      const modelsRes = await fetchModelsEndpoint(baseUrl, apiKey, protocol, 10000);
      if (!modelsRes.ok) {
        lastMessage = `HTTP ${modelsRes.status}`;
        if (modelsRes.body) await modelsRes.body.cancel().catch(() => {});
        continue;
      }
      const data = await modelsRes.json();
      if (protocol === 'gemini') {
        const metadata: Record<string, any> = {};
        const models = (Array.isArray(data.models) ? data.models : []).flatMap((model: any) => {
          if (typeof model?.name !== 'string') return [];
          const id = model.name.replace(/^models\//, '');
          metadata[id] = model;
          return [id];
        });
        return jsonResponse({ status: 'ok', models, modelMetadata: metadata });
      }
      return jsonResponse({ status: 'ok', models: (data.data || []).map((model: any) => model.id), modelMetadata: {} });
    } catch (_err) {
      lastMessage = 'Fetch error';
    }
  }
  return jsonResponse({ status: 'error', message: lastMessage });
}

// --- Proxy ---
function getPresentedGatewayKeys(request: Request, protocol: 'openai' | 'gemini') {
  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (protocol === 'openai') return [bearer].filter(Boolean);
  const url = new URL(request.url);
  return [
    bearer,
    (request.headers.get('x-goog-api-key') || '').trim(),
    (url.searchParams.get('key') || '').trim()
  ].filter(Boolean);
}

async function getAuthorizedGatewayConfig(request: Request, initMessage: string, protocol: 'openai' | 'gemini' = 'openai') {
  let config;
  try {
    config = await getRawConfig();
  } catch (_err) {
    return jsonResponse({ error: { message: 'Gateway storage unavailable' } }, 503);
  }
  if (!config) return jsonResponse({ error: { message: initMessage } }, 503);

  const presentedKeys = getPresentedGatewayKeys(request, protocol);
  const authorized = presentedKeys.some((presentedKey: string) =>
    (config.accessKeys || []).some((configuredKey: string) => timingSafeEqual(configuredKey, presentedKey))
  );
  if (!authorized) {
    return jsonResponse({ error: { message: 'Incorrect API key', code: 'invalid_api_key' } }, 401);
  }
  return config;
}

async function handleModelsList(request: Request) {
  const config = await getAuthorizedGatewayConfig(request, 'Gateway not initialized', 'openai');
  if (config instanceof Response) return config;

  const modelSet = new Set<string>();
  const enabledGroups = (config.channels || []).filter((channel: any) =>
    channel.enabled && channel.protocol === 'openai' && (channel.apiKeys || []).some((key: any) => key.enabled)
  );
  for (const channel of enabledGroups) {
    if (Array.isArray(channel.models)) channel.models.forEach((model: string) => modelSet.add(model));
  }

  const modelsData = Array.from(modelSet).map(id => ({
    id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'deno-free-all'
  }));
  return jsonResponse({ object: 'list', data: modelsData });
}

async function handleGeminiModelsList(request: Request) {
  const config = await getAuthorizedGatewayConfig(request, 'Gateway not initialized', 'gemini');
  if (config instanceof Response) return config;

  const models = new Map<string, any>();
  const groups = (config.channels || []).filter((channel: any) =>
    channel.enabled && channel.protocol === 'gemini' && (channel.apiKeys || []).some((key: any) => key.enabled)
  );
  for (const channel of groups) {
    for (const exposedModel of channel.models || []) {
      if (models.has(exposedModel)) continue;
      const originalModel = getOriginalModelForChannel(channel, exposedModel) || exposedModel;
      const metadata = channel.modelMetadata?.[originalModel];
      models.set(exposedModel, metadata
        ? { ...metadata, name: `models/${exposedModel}` }
        : { name: `models/${exposedModel}`, displayName: exposedModel });
    }
  }
  return jsonResponse({ models: Array.from(models.values()) });
}

async function handleOpenAIProxy(request: Request) {
  const config = await getAuthorizedGatewayConfig(request, 'Gateway not initialized', 'openai');
  if (config instanceof Response) return config;

  const enabledChannels = expandRuntimeChannels(config, 'openai');
  if (enabledChannels.length === 0) return jsonResponse({ error: { message: 'No OpenAI channels' } }, 503);

  const reqUrl = new URL(request.url);
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(request.method);
  const isJson = (request.headers.get('content-type') || '').includes('application/json');
  let parsedBody: any = null;
  let requestedModel = '';
  let bodyBuffer: ArrayBuffer | null = null;
  let requestBodyText = '';

  if (hasBody) {
    if (isJson) {
      requestBodyText = await request.text();
      try {
        parsedBody = JSON.parse(requestBodyText);
        requestedModel = typeof parsedBody?.model === 'string' ? parsedBody.model : '';
      } catch (_err) { /* preserve invalid JSON for upstream */ }
    } else {
      bodyBuffer = await request.arrayBuffer();
    }
  }

  let candidates = requestedModel
    ? enabledChannels.filter((channel: any) => channelSupportsModel(channel, requestedModel))
    : enabledChannels;
  if (candidates.length === 0) {
    return jsonResponse({ error: { message: `Model '${requestedModel}' not supported` } }, 404);
  }

  return forwardWithFailover({
    request,
    candidates,
    buildRequest: (selectedChannel: any) => {
      const upstreamModel = getOriginalModelForChannel(selectedChannel, requestedModel) || requestedModel;
      let body: BodyInit | null = null;
      if (hasBody) {
        if (isJson) body = parsedBody && requestedModel !== upstreamModel
          ? JSON.stringify({ ...parsedBody, model: upstreamModel })
          : requestBodyText;
        else body = bodyBuffer ? bodyBuffer.slice(0) : null;
      }
      const headers = sanitizedForwardHeaders(request.headers);
      headers.set('Authorization', `Bearer ${selectedChannel.apiKey}`);
      headers.delete('x-goog-api-key');
      return new Request(getTargetUrl(selectedChannel.baseUrl, reqUrl.pathname + reqUrl.search), {
        method: request.method, headers, body, redirect: 'follow'
      });
    }
  });
}

function parseGeminiModelPath(pathname: string) {
  const match = pathname.match(/^\/v1beta\/models\/(.+?)(:[^/]+)?\/?$/);
  if (!match) return null;
  try {
    return { model: decodeURIComponent(match[1]), action: match[2] || '' };
  } catch (_err) {
    return { model: match[1], action: match[2] || '' };
  }
}

function rewriteGeminiModelPath(upstreamModel: string, action: string) {
  const encodedModel = upstreamModel.split('/').map(part => encodeURIComponent(part)).join('/');
  return `/v1beta/models/${encodedModel}${action}`;
}

async function handleGeminiProxy(request: Request) {
  const config = await getAuthorizedGatewayConfig(request, 'Gateway not initialized', 'gemini');
  if (config instanceof Response) return config;

  const enabledChannels = expandRuntimeChannels(config, 'gemini');
  if (enabledChannels.length === 0) return jsonResponse({ error: { message: 'No Gemini channels' } }, 503);

  const reqUrl = new URL(request.url);
  const modelPath = parseGeminiModelPath(reqUrl.pathname);
  const requestedModel = modelPath?.model || '';
  let candidates = requestedModel
    ? enabledChannels.filter((channel: any) => channelSupportsModel(channel, requestedModel))
    : enabledChannels;
  if (candidates.length === 0) {
    return jsonResponse({ error: { message: `Model '${requestedModel}' not supported` } }, 404);
  }

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const bodyBuffer = hasBody ? await request.arrayBuffer() : null;
  return forwardWithFailover({
    request,
    candidates,
    buildRequest: (selectedChannel: any) => {
      const targetUrl = new URL(request.url);
      targetUrl.searchParams.delete('key');
      let pathname = targetUrl.pathname;
      if (modelPath) {
        const upstreamModel = getOriginalModelForChannel(selectedChannel, requestedModel) || requestedModel;
        pathname = rewriteGeminiModelPath(upstreamModel, modelPath.action);
      }
      const headers = sanitizedForwardHeaders(request.headers);
      headers.delete('Authorization');
      headers.delete('x-goog-api-key');
      headers.set('x-goog-api-key', selectedChannel.apiKey);
      return new Request(getTargetUrl(selectedChannel.baseUrl, pathname + targetUrl.search), {
        method: request.method,
        headers,
        body: bodyBuffer ? bodyBuffer.slice(0) : null,
        redirect: 'follow'
      });
    }
  });
}

function sanitizedForwardHeaders(source: Headers) {
  const headers = new Headers(source);
  [
    'Host', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry',
    'x-forwarded-for', 'x-real-ip', 'cookie', 'Content-Length'
  ].forEach(header => headers.delete(header));
  return headers;
}

async function forwardWithFailover(options: {
  request: Request;
  candidates: any[];
  buildRequest: (channel: any) => Request;
}) {
  let attempts = 0;
  let remainingCandidates = [...options.candidates];
  const maxAttempts = Math.min(remainingCandidates.length, 5);

  while (attempts < maxAttempts && remainingCandidates.length > 0) {
    attempts++;
    const selectedChannel = selectChannelWeightedStateless(remainingCandidates);
    if (!selectedChannel) break;

    try {
      const upstreamResponse = await fetch(options.buildRequest(selectedChannel));
      if (isRetryableUpstreamStatus(upstreamResponse.status) && attempts < maxAttempts && remainingCandidates.length > 1) {
        remainingCandidates = remainingCandidates.filter(channel => channel.id !== selectedChannel.id);
        if (upstreamResponse.body) await upstreamResponse.body.cancel().catch(() => {});
        continue;
      }
      return proxyResponse(upstreamResponse, selectedChannel, attempts);
    } catch (err: any) {
      console.error('Proxy fetch error:', err?.message || 'unknown');
      if (attempts < maxAttempts && remainingCandidates.length > 1) {
        remainingCandidates = remainingCandidates.filter(channel => channel.id !== selectedChannel.id);
        continue;
      }
      break;
    }
  }
  return jsonResponse({ error: { message: `Upstream routing failed. Attempts: ${attempts}.` } }, 502);
}

function proxyResponse(upstreamResponse: Response, selectedChannel: any, attempts: number) {
  const responseHeaders = new Headers(upstreamResponse.headers);
  ['Content-Encoding', 'Content-Length', 'Transfer-Encoding'].forEach(header => responseHeaders.delete(header));
  Object.entries(getCorsHeaders()).forEach(([key, value]) => responseHeaders.set(key, value));
  responseHeaders.set('X-Freeone-Channel', `channel-${selectedChannel.parentIndex + 1}-key-${selectedChannel.keyIndex + 1}`);
  responseHeaders.set('X-Freeone-Attempt', String(attempts));
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders
  });
}

function getTargetUrl(baseUrl: string, requestPath: string) {
  const base = baseUrl.replace(/\/+$/, '');
  const path = requestPath.startsWith('/') ? requestPath : '/' + requestPath;
  for (const version of ['/v1beta', '/v1']) {
    if (base.endsWith(version) && (path === version || path.startsWith(version + '/'))) {
      return base + path.substring(version.length);
    }
  }
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
  if (mode === 'none' && fetchedModels.length === 0 && savedModels.length === 0) return true;
  return applyKeywordFilter(fetchedModels, mode, channel.filterKeywords || '', channel.selectedModels || []).includes(originalModel);
}

function applyKeywordFilter(fetchedModels: string[], mode: string, filterKeywords: string, selectedModels: string[]) {
  if (mode === 'none') return fetchedModels;
  if (mode === 'keyword') {
    const keywords = filterKeywords.split(',').map((key: string) => key.trim().toLowerCase()).filter(Boolean);
    if (!keywords.length) return fetchedModels;
    return fetchedModels.filter((model: string) => keywords.some((key: string) => model.toLowerCase().includes(key)));
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
