/**
 * @local/dsh-balance-lite — host half.
 *
 * Exposes one read-only route, `GET /dsh-balance-lite/api/balance`, that answers
 * the current DeepSeek wallet balances. Two credential paths are supported:
 *
 *   1. The signed-in DeepSeek account (`ctx.deepseekAccount.getBalance`) — this
 *      is what the desktop application uses after browser sign-in.
 *   2. A stored `DEEPSEEK_API_KEY` credential, queried against the official
 *      `GET https://api.deepseek.com/user/balance` endpoint.
 *
 * The route sits behind the composition's `connection` trust fence (the same
 * login-cookie / Host / Origin check every shipped host route uses).
 */

/** Cordis function-plugin name. */
const name = 'dsh-balance-lite';

/** The route carrier; other services are read lazily so the plugin also loads without an account provider. */
const inject = ['webServer'];

/** Single read-only route. */
const ROUTE = '/dsh-balance-lite/api/balance';

/** Official API-key balance endpoint. */
const API_KEY_BALANCE_URL = 'https://api.deepseek.com/user/balance';

/** Cache lifetime for a resolved balance; keeps polling clients from hammering the platform. */
const CACHE_TTL_MS = 20_000;

/** Deadline for the API-key request. */
const API_KEY_TIMEOUT_MS = 15_000;

/** Official OpenCode Go usage endpoint (API-key auth). */
const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

/** Deadline for the OpenCode Go usage request. */
const OPENCODE_GO_TIMEOUT_MS = 15_000;

/** Usage changes slowly; one successful read serves every client for a minute. */
const OPENCODE_GO_CACHE_TTL_MS = 60_000;

/** Failures are re-tried sooner than successes. */
const OPENCODE_GO_FAIL_TTL_MS = 10_000;

/** Windows the usage endpoint reports, in display order. */
const OPENCODE_GO_WINDOW_KEYS = ['rolling', 'weekly', 'monthly'];

/** Credential reference that holds the OpenCode Go API key. */
const OPENCODE_GO_KEY_REF = 'OPENCODE_API_KEY';

/** Upper bound on wallets rendered/serialized from one upstream response. */
const MAX_WALLETS = 20;

/** Upper bound on a balance response body read from the official endpoint. */
const MAX_RESPONSE_BYTES = 256 * 1024;

/** Failure snapshots are cached briefly so a broken upstream is not retried per request. */
const FAIL_CACHE_TTL_MS = 5_000;

/** Default deadline for one full balance resolution, covering the account path too. */
const DEFAULT_RESOLVE_TIMEOUT_MS = 20_000;

/** Allowed bounds for the configurable resolution timeout. */
const MIN_RESOLVE_TIMEOUT_MS = 100;
const MAX_RESOLVE_TIMEOUT_MS = 60_000;

/**
 * Clamp a numeric config value.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function clampTimeout(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_RESOLVE_TIMEOUT_MS, Math.max(MIN_RESOLVE_TIMEOUT_MS, Math.floor(parsed)));
}

/**
 * JSON response with no-store caching and hardening headers.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.end(JSON.stringify(payload));
}

/**
 * The identity metadata the account service forwards to the Platform.
 * Locale/zone only affect Platform-side rendering, never the amount.
 * @returns {{ version: string, locale: string, timezoneOffsetSeconds: number }}
 */
function clientMetadata() {
  return {
    version: '0.2.2-rc.1',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  };
}

/**
 * Normalize one wallet list.
 * @param {unknown} wallets
 * @returns {{ currency: string, balance: string }[]}
 */
function normalizeWallets(wallets) {
  if (!Array.isArray(wallets)) return [];
  const out = [];
  for (const wallet of wallets) {
    if (out.length >= MAX_WALLETS) break;
    if (wallet === null || typeof wallet !== 'object') continue;
    const currency = typeof wallet.currency === 'string' ? wallet.currency : '';
    const balance = typeof wallet.balance === 'string' ? wallet.balance : String(wallet.balance ?? '');
    if (currency === '' || balance === '') continue;
    out.push({ currency, balance });
  }
  return out;
}

/**
 * Read a JSON response body with a hard byte ceiling.
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<unknown>}
 */
async function readBoundedJson(response, maxBytes) {
  const stream = response.body;
  if (stream === null || stream === undefined) return response.json();
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('balance response body is too large');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released by cancel */
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

/**
 * Read a balance through the signed-in DeepSeek account.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{ kind: 'ready', wallets: object[], bonusWallets: object[] } | { kind: 'signed-out' } | { kind: 'failed' } | undefined>}
 */
async function readAccountBalance(ctx) {
  const account = ctx.get('deepseekAccount');
  if (account === undefined || account === null) return undefined;
  const result = await account.getBalance(clientMetadata());
  if (result === null || result === undefined) return { kind: 'signed-out' };
  if (result.status !== 'ready') return { kind: 'failed' };
  return {
    kind: 'ready',
    wallets: normalizeWallets(result.value),
    bonusWallets: normalizeWallets(result.bonusWallets),
  };
}

/**
 * Read a balance through a stored API key.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{ kind: 'ready', wallets: object[], bonusWallets: object[] } | { kind: 'no-key' } | { kind: 'failed' } | undefined>}
 */
async function readApiKeyBalance(ctx) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined || credentials === null) return undefined;
  let resolved;
  try {
    resolved = await credentials.resolve('DEEPSEEK_API_KEY');
  } catch {
    return { kind: 'no-key' };
  }
  const apiKey = resolved && typeof resolved.value === 'string' ? resolved.value : '';
  if (apiKey === '') return { kind: 'no-key' };

  let response;
  try {
    response = await fetch(API_KEY_BALANCE_URL, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(API_KEY_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'failed' };
  }
  if (!response.ok) return { kind: 'failed' };

  let body;
  try {
    body = await readBoundedJson(response, MAX_RESPONSE_BYTES);
  } catch {
    return { kind: 'failed' };
  }
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const wallets = normalizeWallets(
    infos.map((info) => ({ currency: info?.currency, balance: info?.total_balance })),
  );
  return { kind: 'ready', wallets, bonusWallets: [] };
}

/**
 * Normalize one OpenCode Go usage window.
 * @param {string} key - rolling | weekly | monthly.
 * @param {unknown} value - upstream window object.
 * @returns {{ key: string, status: string, percentRemaining: number, resetsAt: string } | null}
 */
function normalizeUsageWindow(key, value) {
  if (value === null || typeof value !== 'object') return null;
  const status = value.status === 'rate-limited' ? 'rate-limited' : value.status === 'ok' ? 'ok' : '';
  if (status === '') return null;
  const percent = Number(value.percent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return {
    key,
    status,
    percentRemaining: status === 'rate-limited' ? 0 : Math.round((100 - percent) * 10) / 10,
    resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : '',
  };
}

/**
 * Read OpenCode Go plan usage through the official API-key endpoint.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{ ok: true, windows: object[], updatedAt: string } | { ok: false, code: string, message: string }>}
 */
async function readOpenCodeGoUsage(ctx) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined || credentials === null) {
    return { ok: false, code: 'unavailable', message: '凭据服务不可用。' };
  }
  let resolved;
  try {
    resolved = await credentials.resolve(OPENCODE_GO_KEY_REF);
  } catch {
    return { ok: false, code: 'no-key', message: '未配置 OPENCODE_API_KEY。' };
  }
  const apiKey = resolved && typeof resolved.value === 'string' ? resolved.value : '';
  if (apiKey === '') return { ok: false, code: 'no-key', message: '未配置 OPENCODE_API_KEY。' };

  let response;
  try {
    response = await fetch(OPENCODE_GO_USAGE_URL, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(OPENCODE_GO_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'failed', message: 'OpenCode Go 用量读取失败。' };
  }

  if (response.status === 403) {
    let refusal;
    try {
      refusal = await readBoundedJson(response, 32 * 1024);
    } catch {
      refusal = null;
    }
    if (refusal?.type === 'error' && refusal?.error?.type === 'EntitlementError') {
      return { ok: false, code: 'not-subscribed', message: '当前账号未订阅 OpenCode Go。' };
    }
  }
  if (!response.ok) {
    return { ok: false, code: 'failed', message: `OpenCode Go 用量接口返回 ${response.status}。` };
  }

  let body;
  try {
    body = await readBoundedJson(response, MAX_RESPONSE_BYTES);
  } catch {
    return { ok: false, code: 'failed', message: 'OpenCode Go 用量响应无法解析。' };
  }
  const usage = body?.usage;
  if (usage === null || typeof usage !== 'object') {
    return { ok: false, code: 'failed', message: 'OpenCode Go 用量响应格式不正确。' };
  }

  const windows = [];
  for (const key of OPENCODE_GO_WINDOW_KEYS) {
    const window = normalizeUsageWindow(key, usage[key]);
    if (window === null) {
      return { ok: false, code: 'failed', message: 'OpenCode Go 用量响应格式不正确。' };
    }
    windows.push(window);
  }
  return { ok: true, windows, updatedAt: new Date().toISOString() };
}

/**
 * Resolve one balance snapshot, preferring the account and falling back to an API key.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {boolean} allowApiKey - whether the API-key fallback may read `DEEPSEEK_API_KEY`.
 * @returns {Promise<{ ok: true, source: string, wallets: object[], bonusWallets: object[], updatedAt: string } | { ok: false, code: string, message: string }>}
 */
async function resolveBalance(ctx, allowApiKey) {
  let accountFailure;
  try {
    const account = await readAccountBalance(ctx);
    if (account?.kind === 'ready') {
      return {
        ok: true,
        source: 'account',
        wallets: account.wallets,
        bonusWallets: account.bonusWallets,
        updatedAt: new Date().toISOString(),
      };
    }
    if (account?.kind === 'signed-out') accountFailure = 'signed-out';
    if (account?.kind === 'failed') accountFailure = 'failed';
  } catch {
    accountFailure = 'failed';
  }

  if (allowApiKey) {
    try {
      const apiKey = await readApiKeyBalance(ctx);
      if (apiKey?.kind === 'ready') {
        return {
          ok: true,
          source: 'api-key',
          wallets: apiKey.wallets,
          bonusWallets: apiKey.bonusWallets,
          updatedAt: new Date().toISOString(),
        };
      }
      if (apiKey?.kind === 'failed') accountFailure = 'failed';
    } catch {
      accountFailure = 'failed';
    }
  }

  if (accountFailure === 'signed-out') {
    return {
      ok: false,
      code: 'signed-out',
      apiKeyEnabled: allowApiKey,
      message: allowApiKey
        ? '尚未登录 DeepSeek 账号，也未配置 DEEPSEEK_API_KEY。'
        : '尚未登录 DeepSeek 账号（API Key 回退已在配置中禁用）。',
    };
  }
  return {
    ok: false,
    code: accountFailure ?? 'unavailable',
    apiKeyEnabled: allowApiKey,
    message: '余额读取失败；登录状态或网络可能不可用。',
  };
}

/**
 * Register the balance route.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ allowApiKey?: boolean } | undefined} config
 */
function apply(ctx, config) {
  /** Least privilege: the API-key fallback is opt-in, never on by default. */
  const allowApiKey = config?.allowApiKey === true;
  /** OpenCode Go usage is on unless explicitly disabled; it only runs when its key is configured. */
  const showOpenCodeGo = config?.showOpenCodeGo !== false;
  const resolveTimeoutMs = clampTimeout(config?.timeoutMs, DEFAULT_RESOLVE_TIMEOUT_MS);
  /** Coalesced snapshot cache; `at` is the epoch millisecond of the read. */
  let cached;
  let inflight;

  const snapshot = async (force) => {
    const now = Date.now();
    if (force === true) cached = undefined;
    if (cached !== undefined) {
      const ttl = cached.result.ok ? CACHE_TTL_MS : FAIL_CACHE_TTL_MS;
      if (now - cached.at < ttl) return cached.result;
    }
    if (inflight === undefined) {
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, code: 'timeout', apiKeyEnabled: allowApiKey, message: '余额读取超时。' }),
          resolveTimeoutMs,
        );
      });
      inflight = Promise.race([resolveBalance(ctx, allowApiKey), timeout])
        .then((result) => {
          cached = { at: Date.now(), result };
          return result;
        })
        .catch(() => {
          const result = {
            ok: false,
            code: 'unavailable',
            apiKeyEnabled: allowApiKey,
            message: '余额读取失败。',
          };
          cached = { at: Date.now(), result };
          return result;
        })
        .finally(() => {
          clearTimeout(timer);
          inflight = undefined;
        });
    }
    return inflight;
  };

  /** Coalesced OpenCode Go usage cache, independent of the balance snapshot. */
  let usageCached;
  let usageInflight;

  const usageSnapshot = async (force) => {
    if (!showOpenCodeGo) {
      return { ok: false, code: 'disabled', message: 'OpenCode Go 用量显示已在配置中禁用。' };
    }
    const now = Date.now();
    if (force === true) usageCached = undefined;
    if (usageCached !== undefined) {
      const ttl = usageCached.result.ok ? OPENCODE_GO_CACHE_TTL_MS : OPENCODE_GO_FAIL_TTL_MS;
      if (now - usageCached.at < ttl) return usageCached.result;
    }
    if (usageInflight === undefined) {
      usageInflight = readOpenCodeGoUsage(ctx)
        .catch(() => ({ ok: false, code: 'failed', message: 'OpenCode Go 用量读取失败。' }))
        .then((result) => {
          usageCached = { at: Date.now(), result };
          return result;
        })
        .finally(() => {
          usageInflight = undefined;
        });
    }
    return usageInflight;
  };

  /** Answer an untrusted/unauthenticated request; true when it was rejected. */
  const rejected = (req, res) => {
    const connection = ctx.get('connection');
    if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
      // Fail closed: without the composition's trust fence no request is admitted.
      sendJson(res, 503, {
        ok: false,
        code: 'unavailable',
        message: '本地连接鉴权服务不可用，已拒绝请求。',
      });
      return true;
    }
    let rejection;
    try {
      rejection = connection.requestRejection(req);
    } catch {
      sendJson(res, 503, {
        ok: false,
        code: 'unavailable',
        message: '本地连接鉴权失败，已拒绝请求。',
      });
      return true;
    }
    if (rejection === undefined || rejection === null) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('allow', 'GET');
            res.end();
            return;
          }
          try {
            const requestUrl = new URL(req.url ?? ROUTE, 'http://localhost');
            const force = requestUrl.searchParams.get('force') === '1';
            const [result, opencodeGo] = await Promise.all([snapshot(force), usageSnapshot(force)]);
            const status = result.ok === true || result.code === 'signed-out' ? 200 : 502;
            sendJson(res, status, { ...result, opencodeGo });
          } catch {
            sendJson(res, 502, {
              ok: false,
              code: 'unavailable',
              apiKeyEnabled: allowApiKey,
              message: '余额读取失败。',
            });
          }
        },
      }),
    `dsh-balance-lite: GET ${ROUTE}`,
  );
}

export { apply, inject, name };
