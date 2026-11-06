window.__ModuleLoader__.load({
  id: '@local/dsh-balance-lite',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

    /** Must match the host route registered by lib/index.js. */
    const ROUTE = '/dsh-balance-lite/api/balance';
    /** Auto-refresh cadence. */
    const POLL_MS = 60_000;

    const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' };

    /**
     * Share formatting for one wallet.
     * @param {{ currency?: string, balance?: string }} wallet
     * @returns {string}
     */
    function formatWallet(wallet) {
      const currency = typeof wallet.currency === 'string' ? wallet.currency : '';
      const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
      const raw = wallet.balance ?? '';
      const amount = Number(raw);
      const text = Number.isFinite(amount)
        ? amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : raw;
      return `${symbol}${text}`;
    }

    /**
     * @param {{ wallets?: object[] }} data
     * @returns {string}
     */
    function primaryAmount(data) {
      const wallets = Array.isArray(data?.wallets) ? data.wallets : [];
      const wallet = wallets.find((item) => item.currency === 'CNY') ?? wallets[0];
      return wallet === undefined ? '--' : formatWallet(wallet);
    }

    /**
     * @param {string} iso
     * @returns {string}
     */
    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleTimeString();
    }

    const buttonStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '4px 8px',
      borderRadius: 6,
      border: '1px solid rgba(127,127,127,0.3)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: 11,
      lineHeight: 1.2,
      whiteSpace: 'nowrap',
      maxWidth: 120,
      overflow: 'hidden',
    };

    const panelStyle = {
      position: 'fixed',
      left: 12,
      bottom: 64,
      zIndex: 9999,
      width: 230,
      padding: 10,
      borderRadius: 10,
      border: '1px solid rgba(127,127,127,0.3)',
      background: 'rgba(127,127,127,0.16)',
      backdropFilter: 'blur(12px)',
      color: 'inherit',
      font: 'inherit',
      fontSize: 12,
      lineHeight: 1.5,
      boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
    };

    const rowStyle = {
      display: 'flex',
      justifyContent: 'space-between',
      gap: 12,
    };

    const mutedStyle = { opacity: 0.65, fontSize: 11 };

    /**
     * Sidebar-footer balance badge with a click-through detail panel.
     * @returns {import('react').ReactElement}
     */
    function BalanceBadge() {
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [open, setOpen] = useState(false);
      const alive = useRef(true);

      const load = useCallback(async (force) => {
        setLoading(true);
        try {
          const response = await fetch(force === true ? `${ROUTE}?force=1` : ROUTE, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          const body = await response.json();
          if (alive.current) setData(body);
        } catch (_error) {
          if (alive.current) {
            setData({ ok: false, code: 'network', message: '无法连接本地服务。' });
          }
        } finally {
          if (alive.current) setLoading(false);
        }
      }, []);

      useEffect(() => {
        alive.current = true;
        void load(false);
        const timer = setInterval(() => void load(false), POLL_MS);
        return () => {
          alive.current = false;
          clearInterval(timer);
        };
      }, [load]);

      const ready = data !== null && data.ok === true;
      const label = loading && data === null ? '...' : ready ? primaryAmount(data) : '余额';
      const detail = ready ? `点击查看明细（${data.source === 'api-key' ? 'API Key' : '账号'}）` : '点击查看状态';

      const wallets = ready && Array.isArray(data.wallets) ? data.wallets : [];
      const bonusWallets = ready && Array.isArray(data.bonusWallets) ? data.bonusWallets : [];

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            style: { ...buttonStyle, opacity: loading && data !== null ? 0.6 : 1 },
            title: detail,
            onClick: () => {
              setOpen((value) => !value);
              void load(false);
            },
          },
          h('span', { style: { opacity: 0.7 } }, '余额'),
          h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
        ),
        open === true
          ? h(
              'div',
              { style: panelStyle },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 } },
                h('strong', null, 'DeepSeek 余额'),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => void load(true),
                    style: {
                      border: 'none',
                      background: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      font: 'inherit',
                      fontSize: 11,
                      opacity: 0.75,
                      padding: 0,
                    },
                  },
                  loading ? '刷新中…' : '刷新',
                ),
              ),
              ready
                ? h(
                    React.Fragment,
                    null,
                    wallets.map((wallet) =>
                      h(
                        'div',
                        { style: rowStyle, key: `normal-${wallet.currency}` },
                        h('span', { style: { opacity: 0.75 } }, '充值余额'),
                        h('strong', null, formatWallet(wallet)),
                      ),
                    ),
                    bonusWallets.map((wallet) =>
                      h(
                        'div',
                        { style: rowStyle, key: `bonus-${wallet.currency}` },
                        h('span', { style: { opacity: 0.75 } }, '赠送余额'),
                        h('span', null, formatWallet(wallet)),
                      ),
                    ),
                    wallets.length === 0 ? h('div', { style: mutedStyle }, '没有可显示的余额。') : null,
                    h('div', { style: { ...mutedStyle, marginTop: 6 } }, `来源：${data.source === 'api-key' ? 'DEEPSEEK_API_KEY' : 'DeepSeek 账号'}`),
                    h('div', { style: mutedStyle }, `更新：${formatTime(data.updatedAt)}`),
                  )
                : h(
                    React.Fragment,
                    null,
                    h('div', null, data === null ? '正在读取…' : data.message ?? '余额不可用。'),
                    h(
                      'div',
                      { style: { ...mutedStyle, marginTop: 6 } },
                      '请在「设置 → 账号」登录 DeepSeek，或配置 DEEPSEEK_API_KEY。',
                    ),
                  ),
              h(
                'div',
                { style: { ...mutedStyle, marginTop: 8, textAlign: 'right' } },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => setOpen(false),
                    style: {
                      border: 'none',
                      background: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      font: 'inherit',
                      fontSize: 11,
                      padding: 0,
                    },
                  },
                  '关闭',
                ),
              ),
            )
          : null,
      );
    }

    /** Required service: the UI slot registry. */
    const inject = ['slots'];

    /**
     * Contribute the badge beside Settings at the sidebar foot.
     * @param {import('@deepseek-ai/cordis').Context} ctx
     */
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'balance-lite', order: 40 },
          BalanceBadge,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
