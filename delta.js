'use strict';
// Claude Code's requests to a gateway, sent as what changed. Every /v1/messages request carries its whole conversation
// (megabytes) while a turn adds kilobytes, and the body is model, messages, system, tools…: the next request shares all
// of it but the new turn, in the middle.
//   send, beside Claude Code (its base URL points here): keeps each conversation's last body and sends the next one as
//     its middle against it, with the whole body's sha256. A gateway's receiving end (one whose answers carry
//     x-delta-ok) rebuilds it from the same body it kept, checks the sha256 and hands it on. Until a gateway's answer
//     says so, and after a delta gets an answer without it, its requests go whole, as Claude Code sent them.
//     409 x-delta-miss (the receiving end hasn't that body; it answers before the gateway sees anything): that body
//     dropped here, this request whole. A request that breaks on its way is never sent again: the gateway may have it
//     already, and a second would run the model twice. It gets a 502, and Claude Code retries as on any dropped line.
//   node delta.js send [--port 7789] (--to https://gateway/path | --profiles profiles.json) [--cache 512]   GET /_delta
//   --profiles: claude-multi's 申请接入 accounts, each its base URL http://127.0.0.1:7789/j/<its id>, sent to the gateway
//   it joined (api.baseURL); nowhere else. The receiving end's parts are here too (rebuild, keep); its server is the
//   gateway's own.
const http = require('http'), https = require('https'), crypto = require('crypto'), fs = require('fs');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
// 127.0.0.1:port, the last process's port waited for; can't: exit, so whatever runs this starts it again
function serve(srv, port, what) {
  let tries = 0;
  srv.on('error', (e) => {
    if (e.code !== 'EADDRINUSE' || ++tries > 15) { console.error(`${new Date().toISOString()} ${what}: ${e.message}`); process.exit(1); }
    setTimeout(() => srv.listen(port, '127.0.0.1'), 1000);
  });
  srv.listen(port, '127.0.0.1', () => console.error(`${new Date().toISOString()} ${what}`));
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'host'];
// headers as they came, but hop-by-hop ones, the host and ours; content-length too for a request (its body is rebuilt)
const pass = (h, body = true) => Object.fromEntries(Object.entries(h).filter(([k]) => !HOP.includes(k) && !k.startsWith('x-delta-') && (!body || k !== 'content-length')));

// bodies by sha256, the least recently used dropped past max bytes
function cache(max) {
  const m = new Map(); let size = 0;
  return {
    get(k) { const v = m.get(k); if (v) { m.delete(k); m.set(k, v); } return v; },
    put(k, v) { if (m.has(k)) return; m.set(k, v); size += v.length; for (const [o, b] of m) { if (size <= max) break; m.delete(o); size -= b.length; } },
    delete(k) { const v = m.get(k); if (v) { m.delete(k); size -= v.length; } },
    entries: () => [...m],
    shown: () => ({ n: m.size, mb: Math.round(size / 2 ** 20) }),
  };
}
// What both ends keep of a request the gateway took (a 2xx), in the same order: its body, and the base it was built
// from, d, refreshed, or dropped when this body goes on from it: the base's own middle, which this body left out, small
// next to their shared start. That is a conversation's next turn. Another conversation shares only the model and the
// tail (system, tools): its base stays; so does one a fork (a subagent) went on from.
function keep(kept, key, body, d) {
  const b = d && kept.get(d.base);
  if (b && d.base !== key && b.length - d.prefix - d.suffix <= Math.min(64 << 10, d.prefix >> 3)) kept.delete(d.base);
  kept.put(key, body);
}

// how many bytes a and b share from the start (tail: from the end), up to limit: native compares in shrinking steps
function common(a, b, tail = false, limit = Math.min(a.length, b.length)) {
  let n = 0;
  for (let step = 65536; step >= 1; step >>= 4)
    while (n + step <= limit && (tail ? a.compare(b, b.length - n - step, b.length - n, a.length - n - step, a.length - n)
      : a.compare(b, n, n + step, n, n + step)) === 0) n += step;
  return n;
}
// the kept body that shares the most with body: { base, prefix, suffix }
function closest(kept, body) {
  let best = null;
  for (const [base, b] of kept.entries()) {
    const prefix = common(b, body), suffix = common(b, body, true, Math.min(b.length, body.length) - prefix);
    if (!best || prefix + suffix > best.prefix + best.suffix) best = { base, prefix, suffix };
  }
  return best;
}
// The receiving end: a request's body as send had it, from the base it names (kept here) and the middle it carries, its
// sha256 checked; { body, key, d } for keep once the gateway took it. null: it can't be (no such base, or not that
// sha256), and the gateway must not see it: answer 409 x-delta-miss.
function rebuild(kept, h, body) {
  const key = h['x-delta-sha'], base = h['x-delta-base'];
  const d = base ? { base, prefix: Number(h['x-delta-prefix']), suffix: Number(h['x-delta-suffix']) } : null;
  if (d) {
    const b = kept.get(base), { prefix: p, suffix: s } = d;
    body = b && p >= 0 && s >= 0 && p + s <= b.length ? Buffer.concat([b.subarray(0, p), body, b.subarray(b.length - s)]) : null;
  }
  if ((key || base) && (!body || sha(body) !== key)) return null;
  return { body, key, d };
}

function read(req, done) {
  const parts = [];
  req.on('data', (d) => parts.push(d)).on('end', () => done(Buffer.concat(parts.splice(0)))); // pieces let go: req lives as long as its answer
}
// req's answer from upstream piped into res as it comes (SSE); either side going away ends the other
function relay(up, res, onAnswer) {
  up.on('response', (r) => {
    if (onAnswer?.(r) === false) return;
    res.writeHead(r.statusCode, pass(r.headers, false));
    r.pipe(res);
    r.on('error', () => res.destroy());
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
}

function send() {
  const port = Number(arg('--port', 7789)), fixed = arg('--to')?.replace(/\/+$/, ''), profiles = arg('--profiles');
  const kept = cache(Number(arg('--cache', 512)) * 2 ** 20);
  // the gateway and the path after it: --to's, else the 申请接入 account's /j/<id> names (read each time: one just made)
  const gateway = (url) => {
    if (fixed) return [fixed, url];
    const m = /^\/j\/([\w.-]+)(\/[^]*)?$/.exec(url);
    try { const p = m && JSON.parse(fs.readFileSync(profiles, 'utf8')).profiles.find((x) => x.id === m[1] && x.api?.join); return p ? [p.api.baseURL.replace(/\/+$/, ''), m[2] ?? ''] : []; }
    catch { return []; }
  };
  const can = new Map(); // gateway → its receiving end answers: deltas to it
  const agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };
  // sent: request bodies only, every try's (a missed delta's too); failed: requests that broke on their way (502)
  const stats = { since: new Date().toISOString(), requests: 0, bytes: 0, sent: 0, misses: 0, failed: 0, last: [] };
  const srv = http.createServer((req, res) => {
    if (req.url === '/_delta') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ...stats, kept: kept.shown(), to: Object.fromEntries(can) }, null, 1)); }
    const [to, rest] = gateway(req.url);
    if (!to) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('delta.js: no such account'); }
    read(req, (body) => {
      const key = req.method === 'POST' && /\/v1\/messages$/.test(rest.split('?')[0]) && body.length > 0 && sha(body), t0 = Date.now();
      let spent = 0;
      const go = (whole) => {
        const url = new URL(to + rest), headers = pass(req.headers);
        let data = body, d = null;
        if (key) {
          headers['x-delta-sha'] = key; // kept there as it is, and a delta's base from then on
          d = whole || !can.get(to) ? null : closest(kept, body);
          if (d && d.prefix + d.suffix >= 1024) {
            Object.assign(headers, { 'x-delta-base': d.base, 'x-delta-prefix': d.prefix, 'x-delta-suffix': d.suffix });
            data = body.subarray(d.prefix, body.length - d.suffix);
          } else d = null;
        }
        headers['content-length'] = data.length;
        const up = (url.protocol === 'https:' ? https : http).request(url, { method: req.method, headers, agent: agents[url.protocol] });
        relay(up, res, (r) => {
          if (key) { spent += data.length; stats.sent += data.length; }
          if (d && r.statusCode === 409 && r.headers['x-delta-miss']) { // that body isn't there: it only, this one whole
            r.resume(); kept.delete(d.base); stats.misses++; go(true); return false;
          }
          const ok = r.headers['x-delta-ok'] === '1';
          if (ok) can.set(to, true); else if (d) can.set(to, false); // its receiving end gone: whole from the next one
          if (!key) return;
          if (ok && r.statusCode < 300) keep(kept, key, body, d); // kept there too
          stats.requests++; stats.bytes += body.length;
          stats.last = [...stats.last.slice(-19), { at: new Date(t0).toISOString(), bytes: body.length, sent: spent, via: d ? 'delta' : 'whole', status: r.statusCode, ms: Date.now() - t0 }];
        });
        up.on('error', (e) => {
          if (res.destroyed) return; // Claude Code went away: relay stopped this on purpose
          stats.failed++;
          console.error(`${new Date().toISOString()} ${url.host}: ${e.message}`);
          if (res.headersSent) return res.destroy();
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`delta.js: ${e.message}`);
        });
        up.end(data);
      };
      go(false);
    });
  });
  serve(srv, port, `delta.js send on ${port}${fixed ? `, to ${fixed}` : ''}`);
}

if (require.main === module) {
  // a stray error in one request never takes the way to the gateway down with it
  process.on('uncaughtException', (e) => console.error(`${new Date().toISOString()} ${e.stack}`));
  process.on('disconnect', () => process.exit()); // started by claude-multi's web service (fork): gone with it
  if (process.argv[2] === 'send') send();
  else console.error('node delta.js send [--port 7789] (--to https://gateway/path | --profiles profiles.json) [--cache 512]');
}
module.exports = { sha, common, closest, cache, keep, rebuild, read, pass, relay, serve };
