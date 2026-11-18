// node --test quota-panel.test.js (no accounts, network, keys or live service needed)
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { normalize, createQuotaPanel } = require('./quota-panel');
const AT = Date.parse('2026-11-16T12:00:00Z');
const row = (overrides = {}) => ({ provider: 'claude', name: 'Claude Code', user: 'alice@example.com', plan: 'max',
  readAt: new Date(AT).toISOString(), windows: [{ name: '5 hours', used: 10, resetsAt: '2026-11-16T15:00:00Z' }], ...overrides });
function fixture() {
  let now = AT, rows = [row()], reading = false, fail = null, reads = 0, refreshes = [], hold = null, enabled = true;
  const source = { read: async () => { reads++; if (hold) await hold; if (fail) throw fail; return { quotas: rows, reading }; },
    refresh: async (target) => { refreshes.push(target); if (hold) await hold; if (fail) throw fail; return { quotas: rows, reading }; } };
  const panel = createQuotaPanel({ source: () => source, clock: () => now, configured: () => enabled });
  return { panel, source, get reads() { return reads; }, refreshes, tick: (t) => (now += t), rows: (v) => (rows = v),
    reading: (v) => (reading = v), fail: (v) => (fail = v), hold: (v) => (hold = v), enabled: (v) => (enabled = v) };
}
test('only quota fields leave the boundary; identity is stable, masked, deduplicated', () => {
  const a = normalize([row({ token: 'SECRET', key: 'SECRET', cookie: 'SECRET' }), row(), row({ user: 'bob@example.com' })]);
  assert.equal(a.accounts.length, 2);
  assert.equal(a.accounts[0].user, 'a***@example.com');
  assert.deepEqual(a.targets.get(a.accounts[0].id), { provider: 'claude', user: 'alice@example.com' });
  const serialized = JSON.stringify(a.accounts);
  assert.ok(!serialized.includes('SECRET') && !serialized.includes('alice@example.com') && !serialized.includes('provider'));
  assert.equal(a.accounts[0].id, normalize([row({ plan: 'pro' })]).accounts[0].id);
});
test('missing, negative, non-finite, text and unlimited values are not zero-percent usage', () => {
  const windows = [undefined, null, -1, NaN, Infinity, '20', 0, 101].map((used) => ({ name: 'custom', used }));
  windows.push({ used: 0, text: true, display: 'Balance unavailable' }, { used: 0, unlimited: true }, null);
  const w = normalize([row({ windows })]).accounts[0].windows;
  assert.deepEqual(w.map((x) => x.used), [null, null, null, null, null, null, 0, 101, null, null, null]);
  assert.equal(w[8].display, 'Balance unavailable'); assert.equal(w[9].unlimited, true);
});
test('source time, not fetch/last-served time, dates cache and relative resets', () => {
  const a = normalize([row({ asOf: '2026-11-16T10:00:00Z', lastServedAt: '2026-11-16T13:00:00Z', windows: [{ resetSecs: 3600 }] })]).accounts[0];
  assert.equal(a.observedAt, '2026-11-16T10:00:00.000Z'); assert.equal(a.cached, true);
  assert.equal(a.windows[0].resetsAt, '2026-11-16T11:00:00.000Z');
  const b = normalize([row({ readAt: 'bad date', windows: [{ resetSecs: 3600 }] })]).accounts[0];
  assert.equal(b.observedAt, null); assert.equal(b.windows[0].resetsAt, null);
});
test('malformed response rejected, raw upstream errors and secrets removed', () => {
  assert.throws(() => normalize({ err: 'TOKEN' }));
  const a = normalize([null, {}, row({ error: 'https://host/?k=SECRET', pluginError: { token: 'SECRET' } })]);
  assert.equal(a.accounts.length, 1); assert.ok(a.accounts[0].error);
  assert.ok(!JSON.stringify(a.accounts).includes('SECRET'));
});
test('ordinary GETs share a cached source read for a minute', async () => {
  const f = fixture(); assert.equal(f.reads, 0);
  const a = await f.panel.get(); await f.panel.get(); assert.equal(f.reads, 1); assert.equal(a.accounts[0].stale, false);
  f.tick(60001); const b = await f.panel.get(); assert.equal(f.reads, 2);
  assert.notEqual(b.fetchedAt, a.fetchedAt); assert.equal(b.accounts[0].observedAt, a.accounts[0].observedAt);
  f.tick(900001); assert.equal((await f.panel.get()).accounts[0].stale, true);
});
test('parallel GETs are single-flight', async () => {
  const f = fixture(); let release; f.hold(new Promise((r) => (release = r)));
  const p = [f.panel.get(), f.panel.get(), f.panel.get()]; await new Promise(setImmediate);
  assert.equal(f.reads, 1); release(); const all = await Promise.all(p); assert.deepEqual(all[0], all[2]);
});
test('one refresh target validated server-side, global cooldown applies across browsers/accounts', async () => {
  const f = fixture(), a = await f.panel.get();
  await assert.rejects(f.panel.refresh('http://arbitrary/'), /没有这个/);
  await assert.rejects(f.panel.refresh({ provider: 'claude' }), /没有这个/);
  const r = await f.panel.refresh(a.accounts[0].id); assert.equal(r.error, '');
  assert.deepEqual(f.refreshes, [{ provider: 'claude', user: 'alice@example.com' }]);
  assert.equal((await f.panel.refresh()).limited, true); assert.equal(f.refreshes.length, 1);
  f.tick(30000); await f.panel.refresh(); assert.equal(f.refreshes[1], null);
});
test('parallel explicit refreshes do not multiply queries', async () => {
  const f = fixture(); await f.panel.get(); let release; f.hold(new Promise((r) => (release = r)));
  const p = [f.panel.refresh(), f.panel.refresh()]; await new Promise(setImmediate);
  assert.equal(f.refreshes.length, 1); release(); const all = await Promise.all(p); assert.equal(all[1].limited, true);
});
test('upstream reading permits bounded fast GETs, never turns them into explicit refresh', async () => {
  const f = fixture(); f.reading(true); assert.equal((await f.panel.get()).refreshing, true);
  f.tick(1999); await f.panel.get(); assert.equal(f.reads, 1);
  f.tick(1); await f.panel.get(); assert.equal(f.reads, 2); assert.equal(f.refreshes.length, 0);
  f.reading(false); f.tick(2000); assert.equal((await f.panel.get()).refreshing, false);
});
test('offline keeps previous quota with old source time and stale marker; recovery clears error', async () => {
  const f = fixture(), a = await f.panel.get(); f.tick(60000); f.fail(Error('SECRET_TOKEN'));
  const b = await f.panel.get(); assert.ok(b.error); assert.equal(b.accounts[0].stale, true);
  assert.equal(b.fetchedAt, a.fetchedAt); assert.equal(b.accounts[0].windows[0].used, 10); assert.ok(!JSON.stringify(b).includes('SECRET_TOKEN'));
  f.fail(null); f.tick(60000); assert.equal((await f.panel.get()).error, '');
});
test('authentication error is sanitized; source throw can recover (not stuck on a resolved flight)', async () => {
  let fail = true, now = AT;
  const panel = createQuotaPanel({ clock: () => now, source: () => { if (fail) throw Object.assign(Error('SECRET'), { code: 'QUOTA_AUTH' }); return { read: async () => ({ quotas: [] }) }; } });
  assert.match((await panel.get()).error, /认证/); fail = false; now += 60000;
  assert.equal((await panel.get()).error, '');
});
test('removed account cannot be refreshed; disabled source is never called or exposed', async () => {
  const f = fixture(), a = await f.panel.get(); f.rows([]); f.tick(60000); assert.deepEqual((await f.panel.get()).accounts, []);
  await assert.rejects(f.panel.refresh(a.accounts[0].id), /没有这个/);
  const before = f.reads; f.enabled(false);
  assert.equal((await f.panel.get()).configured, false); await f.panel.refresh(); assert.equal(f.reads, before);
});
