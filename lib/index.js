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
    if (wallet === null || typeof wallet !== 'object') continue;
    const currency = typeof wallet.currency === 'string' ? wallet.currency : '';
    const balance = typeof wallet.balance === 'string' ? wallet.balance : String(wallet.balance ?? '');
    if (currency === '' || balance === '') continue;
    out.push({ currency, balance });
  }
  return out;
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
    body = await response.json();
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
      message: allowApiKey
        ? '尚未登录 DeepSeek 账号，也未配置 DEEPSEEK_API_KEY。'
        : '尚未登录 DeepSeek 账号（API Key 回退已在配置中禁用）。',
    };
  }
  return {
    ok: false,
    code: accountFailure ?? 'unavailable',
    message: '余额读取失败；登录状态或网络可能不可用。',
  };
}

/**
 * Register the balance route.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ allowApiKey?: boolean } | undefined} config
 */
function apply(ctx, config) {
  /** API-key fallback stays available unless the composition explicitly disables it. */
  const allowApiKey = config?.allowApiKey !== false;
  /** Coalesced snapshot cache; `at` is the epoch millisecond of the last successful read. */
  let cached;
  let inflight;

  const snapshot = async (force) => {
    const now = Date.now();
    if (force === true) cached = undefined;
    if (cached !== undefined && cached.result.ok && now - cached.at < CACHE_TTL_MS) return cached.result;
    if (inflight === undefined) {
      inflight = resolveBalance(ctx, allowApiKey)
        .then((result) => {
          if (result.ok) cached = { at: Date.now(), result };
          return result;
        })
        .catch(() => ({ ok: false, code: 'unavailable', message: '余额读取失败。' }))
        .finally(() => {
          inflight = undefined;
        });
    }
    return inflight;
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
            sendJson(res, 200, await snapshot(force));
          } catch {
            sendJson(res, 200, {
              ok: false,
              code: 'unavailable',
              message: '余额读取失败。',
            });
          }
        },
      }),
    `dsh-balance-lite: GET ${ROUTE}`,
  );
}

export { apply, inject, name };
