/**
 * Zero-dependency test suite for @local/dsh-balance-lite.
 *
 * Run with: node test/plugin.test.mjs
 */
import { apply } from '../lib/index.js';

const results = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(body) {
      if (body !== undefined) this.body = String(body);
    },
    json() {
      try {
        return JSON.parse(this.body);
      } catch {
        return null;
      }
    },
  };
}

/**
 * @param {{ connection?: object|null, account?: object|null, credentials?: object|null }} options
 */
function makeCtx(options = {}) {
  const handlers = [];
  const connection = options.connection === undefined
    ? { requestRejection: () => undefined }
    : options.connection;
  const ctx = {
    get(name) {
      if (name === 'connection') return connection;
      if (name === 'deepseekAccount') return options.account ?? null;
      if (name === 'credentials') return options.credentials ?? null;
      return undefined;
    },
    webServer: {
      register(spec) {
        handlers.push(spec);
        return () => {};
      },
    },
    effect(fn) {
      const disposer = fn();
      return () => disposer?.();
    },
  };
  return { ctx, handlers };
}

async function call(handler, { method = 'GET', url = '/dsh-balance-lite/api/balance?force=1' } = {}) {
  const res = makeRes();
  await handler({ method, url, headers: {} }, res);
  return res;
}

const readyAccount = (wallets = [{ currency: 'CNY', balance: '1.23' }]) => ({
  getBalance: async () => ({ status: 'ready', value: wallets, bonusWallets: [] }),
});

// 1. Missing connection service -> fail closed.
{
  const { ctx, handlers } = makeCtx({ connection: null });
  apply(ctx, {});
  const res = await call(handlers[0].handler);
  check('missing connection returns 503', res.statusCode === 503);
}

// 2. Account ready -> 200 with hardening headers.
{
  const { ctx, handlers } = makeCtx({ account: readyAccount() });
  apply(ctx, {});
  const res = await call(handlers[0].handler);
  const body = res.json();
  check('account ready returns 200', res.statusCode === 200 && body.ok === true && body.source === 'account');
  check('wallet value preserved', body.wallets[0].balance === '1.23');
  check(
    'hardening headers present',
    res.headers['x-content-type-options'] === 'nosniff'
      && res.headers['referrer-policy'] === 'no-referrer'
      && res.headers['cache-control'] === 'no-store',
  );
}

// 3. Default config: API key channel stays disabled and the credential store is untouched.
{
  let credentialReads = 0;
  const { ctx, handlers } = makeCtx({
    account: { getBalance: async () => null },
    credentials: {
      resolve: async () => {
        credentialReads += 1;
        return { value: 'sk-should-not-be-read' };
      },
    },
  });
  apply(ctx, {});
  const res = await call(handlers[0].handler);
  const body = res.json();
  check('allowApiKey defaults to false', credentialReads === 0);
  check('signed-out response advertises disabled API key', body.apiKeyEnabled === false && /禁用/.test(body.message));
  check('signed-out stays 200', res.statusCode === 200);
}

// 4. Explicit opt-in: fixed endpoint, no redirects, bearer header, no key in the response.
{
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return {
      ok: true,
      body: null,
      json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '9.99' }] }),
    };
  };
  const { ctx, handlers } = makeCtx({
    account: { getBalance: async () => null },
    credentials: { resolve: async () => ({ value: 'sk-test-key' }) },
  });
  apply(ctx, { allowApiKey: true });
  const res = await call(handlers[0].handler);
  const body = res.json();
  check('API key path returns 200', res.statusCode === 200 && body.source === 'api-key');
  check('fixed official endpoint', seen?.url === 'https://api.deepseek.com/user/balance');
  check('redirects rejected', seen?.init?.redirect === 'error');
  check('bearer header used', seen?.init?.headers?.authorization === 'Bearer sk-test-key');
  check('response contains no key material', !JSON.stringify(body).includes('sk-test-key'));
}

// 5. A hung account query cannot wedge the route forever.
{
  let accountCalls = 0;
  const { ctx, handlers } = makeCtx({
    account: {
      getBalance: () => {
        accountCalls += 1;
        return new Promise(() => {});
      },
    },
  });
  apply(ctx, { timeoutMs: 120 });
  const first = await call(handlers[0].handler);
  const firstBody = first.json();
  check('hung resolution times out', firstBody.code === 'timeout' && first.statusCode === 502);
  const second = await call(handlers[0].handler, { url: '/dsh-balance-lite/api/balance?force=1' });
  check('timeout clears in-flight state', accountCalls === 2 && second.json().code === 'timeout');
}

// 6. Failed lookups are cached briefly instead of hitting the account service per request.
{
  let accountCalls = 0;
  const { ctx, handlers } = makeCtx({
    account: {
      getBalance: async () => {
        accountCalls += 1;
        return { status: 'failed' };
      },
    },
  });
  apply(ctx, {});
  const first = await call(handlers[0].handler, { url: '/dsh-balance-lite/api/balance' });
  const second = await call(handlers[0].handler, { url: '/dsh-balance-lite/api/balance' });
  check('failures cached for a short window', accountCalls === 1 && first.statusCode === 502 && second.statusCode === 502);
}

// 7. Wallet arrays are bounded.
{
  const many = Array.from({ length: 100 }, (_, index) => ({ currency: `C${index}`, balance: '1.00' }));
  const { ctx, handlers } = makeCtx({ account: readyAccount(many) });
  apply(ctx, {});
  const res = await call(handlers[0].handler);
  check('wallet list capped at 20', res.json().wallets.length === 20);
}

// 8. Non-GET methods are rejected after authentication.
{
  const { ctx, handlers } = makeCtx({ account: readyAccount() });
  apply(ctx, {});
  const res = await call(handlers[0].handler, { method: 'POST' });
  check('POST returns 405', res.statusCode === 405 && res.headers.allow === 'GET');
}

for (const { name, ok, detail } of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === '' ? '' : `  (${detail})`}`);
}
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
