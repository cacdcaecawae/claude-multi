// node --test delta.test.js: delta.js send as a process, in front of a receiving end made of delta.js's own parts (rebuild,
// keep) and a fake gateway that keeps what it was sent and streams its answer in pieces. Nothing here leaves 127.0.0.1.
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), http = require('http'), net = require('net'), path = require('path'), { spawn } = require('child_process');
const { sha, common, cache, keep, rebuild, read, pass, relay } = require('./delta');

const free = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const up = async (port) => { for (let i = 0; i < 100; i++) { if (await new Promise((ok) => net.connect(port, '127.0.0.1').on('connect', function () { this.destroy(); ok(true); }).on('error', () => ok(false)))) return; await new Promise((r) => setTimeout(r, 50)); } throw Error(`nothing on ${port}`); };
const run = (...a) => spawn(process.execPath, [path.join(__dirname, 'delta.js'), ...a.map(String)], { stdio: ['ignore', 'ignore', 'inherit'] });
const stop = (p) => new Promise((ok) => { if (p.exitCode !== null || p.signalCode !== null) return ok(); p.on('exit', ok); p.kill(); });

// the gateway: every request kept; /v1/messages answered as SSE, a piece now and one 300 ms later; key k-bad: 401
const got = []; let aborted = 0;
const gw = http.createServer((req, res) => read(req, (body) => {
  got.push({ method: req.method, url: req.url, headers: req.headers, body });
  res.on('close', () => { if (!res.writableFinished) aborted++; });
  if (req.headers['x-api-key'] === 'k-bad') { res.writeHead(401); return res.end('{}'); }
  if (req.url.includes('hang')) return setTimeout(() => res.end(), 20000).unref(); // got it, says nothing yet
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-from': 'gw' });
  res.write('event: one\n\n');
  setTimeout(() => res.end('event: two\n\n'), req.url.includes('slow') ? 5000 : 300);
}));
// its receiving end, under /gw: rebuilds, keeps what the gateway took, says so on every answer (lost: a plain pass-on)
let kept = cache(64 << 20), lost = false; const hosts = [];
const recvAt = (req, res) => req.headers['x-delta-ping'] ? (res.writeHead(204, { 'x-delta-ok': '1' }), res.end()) : read(req, (b) => {
  hosts.push(req.headers.host);
  const r = lost ? { body: b } : rebuild(kept, req.headers, b);
  if (!r) { res.writeHead(409, { 'x-delta-miss': '1', 'x-delta-ok': '1' }); return res.end(); }
  const u = http.request({ host: '127.0.0.1', port: P.gw, method: req.method, path: req.url.replace(/^\/gw/, ''), headers: { ...pass(req.headers), 'content-length': r.body.length } });
  relay(u, res, (a) => { if (lost) return; if (r.key && a.statusCode < 300) keep(kept, r.key, r.body, r.d); res.setHeader('x-delta-ok', '1'); });
  u.on('error', () => res.destroy());
  u.end(r.body);
});
const recv = http.createServer(recvAt);
// a conversation's body as Claude Code lays it out: model, messages (growing), then a big fixed system and tools
const tail = { system: 'S'.repeat(60000), tools: Array.from({ length: 40 }, (_, i) => ({ name: `t${i}`, d: 'x'.repeat(1000) })), stream: true };
const convo = (who, turns) => Buffer.from(JSON.stringify({ model: 'm', messages: Array.from({ length: turns }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${who} turn ${i} ` + `${who}${i}`.repeat(4000) })), ...tail }));
const post = (port, p, body, { signal, key = 'k1' } = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', body, signal, headers: { 'content-type': 'application/json', 'x-api-key': key } });

let P, send, byId, dir;
test.before(async () => {
  P = { gw: await free(), recv: await free(), send: await free(), byId: await free() };
  await new Promise((ok) => gw.listen(P.gw, '127.0.0.1', ok)); await new Promise((ok) => recv.listen(P.recv, '127.0.0.1', ok));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify({ profiles: [
    { id: 'acct-1', api: { join: 'j1', baseURL: `http://127.0.0.1:${P.recv}/gw/` } }, { id: 'acct-2', api: { baseURL: `http://127.0.0.1:${P.recv}/gw` } },
    { id: 'acct-3', api: { join: 'j3', baseURL: `http://127.0.0.1:${P.gw}` } }] })); // acct-2 not 申请接入's; acct-3 a gateway with no receiving end
  send = run('send', '--port', P.send, '--to', `http://127.0.0.1:${P.recv}/gw`);
  byId = run('send', '--port', P.byId, '--profiles', path.join(dir, 'profiles.json'));
  await up(P.send); await up(P.byId);
});
test.after(async () => { await stop(send); await stop(byId); gw.close(); recv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const stats = async (port = P.send) => (await fetch(`http://127.0.0.1:${port}/_delta`)).json();

test('common: from the start and from the end, never past the limit', () => {
  const a = Buffer.from('abcdefXYZ'), b = Buffer.from('abcdQQXYZ');
  assert.equal(common(a, b), 4); assert.equal(common(a, b, true), 3); assert.equal(common(a, a, true, 5), 5);
  const big = Buffer.alloc(300000, 7), big2 = Buffer.from(big); big2[200001] = 8;
  assert.equal(common(big, big2), 200001); assert.equal(common(big, big2, true), 300000 - 200002);
});

test('rebuild: nothing it can\'t make exactly (no such base, a wrong sha256, more start and end than the base has)', () => {
  const k = cache(1 << 20), a = Buffer.from('a'.repeat(5000)), h = (o) => ({ 'x-delta-base': sha(a), ...o });
  k.put(sha(a), a);
  const b = Buffer.concat([a.subarray(0, 4000), Buffer.from('NEW'), a.subarray(4000)]);
  assert.ok(rebuild(k, h({ 'x-delta-prefix': 4000, 'x-delta-suffix': 1000, 'x-delta-sha': sha(b) }), Buffer.from('NEW')).body.equals(b));
  assert.equal(rebuild(k, h({ 'x-delta-prefix': 4000, 'x-delta-suffix': 1000, 'x-delta-sha': 'f'.repeat(64) }), Buffer.from('NEW')), null);
  assert.equal(rebuild(k, h({ 'x-delta-prefix': 5000, 'x-delta-suffix': 1, 'x-delta-sha': sha(a) }), Buffer.alloc(0)), null);
  assert.equal(rebuild(k, { 'x-delta-base': 'e'.repeat(64), 'x-delta-prefix': 0, 'x-delta-suffix': 0, 'x-delta-sha': sha(a) }, a), null);
  assert.ok(rebuild(k, { 'x-delta-sha': sha(b) }, b).body.equals(b)); // whole, its sha256 checked too
});

test('two conversations interleaved: whole until the gateway says it rebuilds, then each turn\'s middle; one body each kept', async () => {
  const bodies = [convo('A', 1), convo('B', 1), convo('A', 3), convo('B', 3), convo('A', 5)];
  for (const b of bodies) {
    const r = await post(P.send, '/v1/messages?beta=true', b);
    assert.equal(r.headers.get('x-from'), 'gw'); assert.equal(r.headers.get('x-delta-ok'), null); assert.equal(await r.text(), 'event: one\n\nevent: two\n\n');
  }
  const mine = got.slice(-5);
  mine.forEach((g, i) => { assert.ok(g.body.equals(bodies[i]), `body ${i}`); assert.equal(g.url, '/v1/messages?beta=true'); assert.equal(g.headers['x-api-key'], 'k1'); });
  assert.deepEqual([...new Set(hosts)], [`127.0.0.1:${P.recv}`]); // the gateway's own host, not this side's
  const s = await stats();
  assert.deepEqual(s.last.map((x) => x.via), ['whole', 'delta', 'delta', 'delta', 'delta']); // B's first shares A's model and tail
  for (const x of s.last.slice(2)) assert.ok(x.sent < 20000 && x.bytes > 100000, JSON.stringify(x)); // two new turns of 8 KB each
  assert.equal(s.kept.n, 2); // A1 and A3 gone, each replaced by its next turn; B1 stayed after B's first used it as a base
});

test('a fork off a conversation (a subagent: its history, then turns of its own) leaves the conversation\'s body kept', async () => {
  const f3 = convo('F', 3), j = JSON.parse(f3), f5 = convo('F', 5);
  const fork = Buffer.from(JSON.stringify({ ...j, messages: [...j.messages.slice(0, 2), { role: 'user', content: 'fork ' + 'Z'.repeat(8000) }] }));
  for (const b of [f3, fork, f5]) await (await post(P.send, '/v1/messages', b)).text();
  got.slice(-3).forEach((g, i) => assert.ok(g.body.equals([f3, fork, f5][i]), `body ${i}`));
  const last = (await stats()).last.slice(-3);
  assert.deepEqual(last.map((x) => x.via), ['delta', 'delta', 'delta']);
  assert.ok(last[2].sent < 20000, JSON.stringify(last[2])); // F's two new turns against F3, not three against the fork
});

test('one the gateway turned away (401) is kept on neither side', async () => {
  const n = (await stats()).kept.n, r = await post(P.send, '/v1/messages', convo('X', 3), { key: 'k-bad' });
  assert.equal(r.status, 401); await r.text();
  assert.equal((await stats()).kept.n, n);
  assert.ok(!kept.entries().some(([k]) => k === sha(convo('X', 3))));
});

test('other requests pass through as they are', async () => {
  const r = await fetch(`http://127.0.0.1:${P.send}/v1/models?limit=5`, { headers: { 'x-api-key': 'k2' } });
  assert.equal(r.status, 200); await r.text();
  assert.deepEqual([got.at(-1).method, got.at(-1).url, got.at(-1).headers['x-api-key']], ['GET', '/v1/models?limit=5', 'k2']);
  const c = Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(50000) }] }));
  await (await post(P.send, '/v1/messages/count_tokens?beta=true', c)).text();
  assert.ok(got.at(-1).body.equals(c)); assert.equal(got.at(-1).headers['x-delta-sha'], undefined);
});

test('the answer streams: its first piece arrives before the gateway has sent the last', async () => {
  const t0 = Date.now(), r = await post(P.send, '/v1/messages', convo('C', 1)), rd = r.body.getReader();
  assert.equal(Buffer.from((await rd.read()).value).toString(), 'event: one\n\n'); assert.ok(Date.now() - t0 < 250, `${Date.now() - t0} ms`);
  while (!(await rd.read()).done);
});

test('stopping on this side stops the gateway\'s answer', async () => {
  const before = aborted, ac = new AbortController(), r = await post(P.send, '/v1/messages?slow', convo('D', 1), { signal: ac.signal });
  const rd = r.body.getReader(); await rd.read(); ac.abort();
  for (let i = 0; i < 40 && aborted === before; i++) await new Promise((x) => setTimeout(x, 50));
  assert.equal(aborted, before + 1);
});

test('the receiving end restarted (it keeps nothing): that conversation whole once, then deltas again', async () => {
  kept = cache(64 << 20);
  const b = convo('A', 7), b2 = convo('A', 9);
  await (await post(P.send, '/v1/messages', b)).text(); await (await post(P.send, '/v1/messages', b2)).text();
  assert.ok(got.at(-2).body.equals(b)); assert.ok(got.at(-1).body.equals(b2));
  const s = await stats();
  assert.equal(s.misses, 1); assert.deepEqual(s.last.slice(-2).map((x) => x.via), ['whole', 'delta']);
});

test('one body the receiving end lacks costs that conversation one whole body; the others go on as deltas', async () => {
  const b5 = convo('B', 5), a11 = convo('A', 11); // it has A's last body now, not B's
  await (await post(P.send, '/v1/messages', b5)).text(); await (await post(P.send, '/v1/messages', a11)).text();
  assert.ok(got.at(-2).body.equals(b5)); assert.ok(got.at(-1).body.equals(a11));
  const s = await stats(), [b, a] = s.last.slice(-2);
  assert.equal(s.misses, 2); assert.deepEqual([b.via, a.via], ['whole', 'delta']);
  assert.ok(a.sent < 30000, JSON.stringify(a)); // its two new turns (8 and 12 KB): A's base still kept here, not all 11
});

test('broken on its way after the gateway got it: a 502, and the gateway got it once, never twice', async () => {
  const b = convo('H', 3), n = () => got.filter((g) => g.body.equals(b)).length;
  const pending = post(P.send, '/v1/messages?hang', b);
  for (let i = 0; i < 60 && !n(); i++) await new Promise((x) => setTimeout(x, 50));
  assert.equal(n(), 1);
  recv.closeAllConnections(); // the way back breaks before any answer
  const r = await pending;
  assert.equal(r.status, 502); await r.text();
  await new Promise((x) => setTimeout(x, 500));
  assert.equal(n(), 1); assert.equal((await stats()).failed, 1);
});

test('a gateway that stopped rebuilding (its answer without x-delta-ok): whole from the next request on', async () => {
  lost = true;
  await (await post(P.send, '/v1/messages', convo('A', 13))).text(); // a delta, passed on as it came: the gateway's 400 in life
  const b = convo('A', 15);
  await (await post(P.send, '/v1/messages', b)).text();
  assert.ok(got.at(-1).body.equals(b));
  assert.deepEqual((await stats()).last.slice(-2).map((x) => x.via), ['delta', 'whole']);
  lost = false;
});

test('--profiles: a 申请接入 account\'s /j/<id> goes to its gateway; any other path nowhere', async () => {
  const b = convo('J', 1), r = await post(P.byId, '/j/acct-1/v1/messages', b);
  assert.equal(r.status, 200); await r.text(); assert.ok(got.at(-1).body.equals(b)); assert.equal(got.at(-1).url, '/v1/messages');
  for (const p of ['/j/acct-2/v1/messages', '/j/nobody/v1/messages', `/http://127.0.0.1:${P.gw}/v1/messages`, '/v1/messages']) {
    const n = got.length, x = await post(P.byId, p, b);
    assert.equal(x.status, 404, p); await x.text(); assert.equal(got.length, n, p);
  }
  // a gateway with no receiving end: every request whole, nothing kept
  const c1 = convo('K', 1), c3 = convo('K', 3);
  for (const c of [c1, c3]) { const x = await post(P.byId, '/j/acct-3/v1/messages', c); assert.equal(x.status, 200); await x.text(); assert.ok(got.at(-1).body.equals(c)); }
  const s = await stats(P.byId);
  assert.deepEqual(s.last.slice(-2).map((x) => x.via), ['whole', 'whole']); assert.equal(s.kept.n, 1); // acct-1's, not acct-3's
});

test('--plain: while --to\'s receiving end answers no ping, whole by --plain\'s way; back once it does; a failure switches at once', async () => {
  const dead = await free(), port = await free(), wait = async (f) => { for (let i = 0; i < 60 && !(await f()); i++) await new Promise((r) => setTimeout(r, 100)); };
  const fb = run('send', '--port', port, '--to', `http://127.0.0.1:${dead}/gw`, '--plain', `http://127.0.0.1:${P.gw}`), s = () => stats(port);
  try {
    await up(port); await wait(async () => (await s()).up === false);
    assert.equal((await s()).up, false);
    const b = convo('P', 1), r = await post(port, '/v1/messages', b);
    assert.equal(r.status, 200); await r.text(); assert.ok(got.at(-1).body.equals(b));
    assert.ok(!Object.keys(got.at(-1).headers).some((k) => k.startsWith('x-delta')), 'the plain way gets no delta header');
    // its receiving end comes up: pinged within 2 s; whole once (nothing kept from the plain way), then the middle
    const back = http.createServer(recvAt).listen(dead, '127.0.0.1');
    await wait(async () => (await s()).up === true);
    for (const c of [convo('P', 3), convo('P', 5)]) { await (await post(port, '/v1/messages', c)).text(); assert.ok(got.at(-1).body.equals(c)); }
    assert.deepEqual((await s()).last.slice(-2).map((x) => x.via), ['whole', 'delta']);
    // gone again: the request that finds it gone gets a 502 and goes nowhere else; the next goes the plain way
    back.close(); back.closeAllConnections();
    const p7 = convo('P', 7), x = await post(port, '/v1/messages', p7);
    assert.equal(x.status, 502); await x.text(); assert.ok(!got.some((g) => g.body.equals(p7)));
    const p9 = convo('P', 9), y = await post(port, '/v1/messages', p9);
    assert.equal(y.status, 200); await y.text(); assert.ok(got.at(-1).body.equals(p9));
  } finally { await stop(fb); }
});

test('forked, it tells its parent once it listens', async () => {
  const port = await free(), c = require('child_process').fork(path.join(__dirname, 'delta.js'), ['send', '--port', String(port), '--to', `http://127.0.0.1:${P.recv}/gw`], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try { assert.deepEqual(await new Promise((ok) => c.once('message', ok)), { listening: port }); } finally { c.kill(); }
});
