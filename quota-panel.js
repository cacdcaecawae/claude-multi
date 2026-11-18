'use strict';
// 代理额度: the quotas of the subscription accounts behind a proxy, read through a source ({ read, refresh(target) }:
// claude-multi.js's quotaSource). A read-only boundary: credentials, provider identifiers and raw errors never reach the
// page.
const { createHash } = require('crypto');
const text = (v, n = 120) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, n) : '';
const stamp = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const masked = (v) => {
  const s = text(v), at = s.lastIndexOf('@');
  return !s ? '' : at > 0 ? `${s.slice(0, 1)}***@${s.slice(at + 1)}` : `${s.slice(0, 1)}***`;
};
function normalize(rows) {
  if (!Array.isArray(rows)) throw Error('invalid response');
  const targets = new Map(), accounts = [];
  for (const q of rows.slice(0, 200)) {
    if (!q || typeof q.provider !== 'string' || !q.provider || (q.user != null && typeof q.user !== 'string')) continue;
    const user = q.user || '', id = createHash('sha256').update(JSON.stringify([q.provider, user])).digest('hex').slice(0, 24);
    if (targets.has(id)) continue;
    targets.set(id, { provider: q.provider, user });
    const readAt = stamp(q.readAt), asOf = stamp(q.asOf);
    const observedAt = asOf || readAt; // asOf explicitly dates a last-known reading after a failed/deferred query
    accounts.push({ id, name: text(q.name) || '订阅账号', user: masked(user), plan: text(q.plan, 60), observedAt,
      error: q.error || q.pluginError ? '账号额度暂时读不到；请在代理管理页检查登录状态。' : '', deferred: q.readDeferred === true, cached: !!asOf,
      windows: (Array.isArray(q.windows) ? q.windows : []).slice(0, 30).map((w) => {
        w = w && typeof w === 'object' ? w : {};
        const pct = !w.text && !w.unlimited && typeof w.used === 'number' && Number.isFinite(w.used) && w.used >= 0 ? w.used : null;
        // A relative reset belongs to the source reading, not the time our page happened to fetch it.
        const relative = observedAt && typeof w.resetSecs === 'number' && Number.isFinite(w.resetSecs) && w.resetSecs >= 0 && w.resetSecs < 31536000
          ? new Date(Date.parse(observedAt) + w.resetSecs * 1000).toISOString() : null;
        return { name: text(w.name, 80) || '额度', used: pct, unlimited: w.unlimited === true,
          display: text(w.display, 160), text: w.text === true, resetsAt: stamp(w.resetsAt) || relative };
      }) });
  }
  return { accounts, targets };
}
function createQuotaPanel({ source, configured = () => true, clock = Date.now, ttl = 60000, cooldown = 30000 }) {
  let accounts = [], targets = new Map(), fetchedAt = null, checkedAt = -Infinity, manualAt = -Infinity;
  let pending = null, reading = false, error = '';
  const view = () => ({ configured: !!configured(), accounts: accounts.map((a) => ({ ...a,
    stale: !!error || !!a.error || a.cached || !a.observedAt || clock() - Date.parse(a.observedAt) > 15 * 60000 })), fetchedAt,
    refreshing: !!pending || reading, error, retryAt: Number.isFinite(manualAt) ? manualAt + cooldown : 0 });
  function run(target, force = false) {
    checkedAt = clock();
    pending = (async () => {
      try {
        const adapter = await Promise.resolve().then(source);
        const result = force ? await adapter.refresh(target) : await adapter.read();
        const normalized = normalize(result.quotas);
        accounts = normalized.accounts; targets = normalized.targets;
        reading = result.reading === true; error = ''; fetchedAt = new Date(clock()).toISOString();
      } catch (e) {
        reading = false;
        error = e?.code === 'QUOTA_AUTH' ? '代理管理认证失效，请在本机检查连接配置。'
          : '暂时连不上代理额度服务。';
      } finally { pending = null; }
      return view();
    })();
    return pending;
  }
  return {
    async get() {
      if (!configured()) return { ...view(), accounts: [], error: '尚未配置额度来源。', refreshing: false };
      if (pending) return pending;
      return clock() - checkedAt >= (reading ? 2000 : ttl) ? run() : view();
    },
    async refresh(id) {
      if (!configured()) return this.get();
      if (id !== undefined && (typeof id !== 'string' || !targets.has(id))) throw Error('没有这个额度账号，请先重新打开额度面板。');
      if (pending) await pending;
      if (id !== undefined && !targets.has(id)) throw Error('这个额度账号已移除，请重新打开额度面板。');
      if (clock() < manualAt + cooldown) return { ...view(), limited: true };
      manualAt = clock();
      return run(id === undefined ? null : targets.get(id), true);
    }
  };
}
module.exports = { createQuotaPanel, normalize };
