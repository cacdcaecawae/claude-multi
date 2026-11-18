// 代理额度 in real Chromium: this repo's web.html (no /ext.js) against an isolated fake API. Never opens a live account or
// starts a Claude process. node quota-panel.browser.test.js (QUOTA_SCREENSHOTS=<dir> for pictures; BROWSER_EXE: another browser)
'use strict';
const assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const { normalize } = require('./quota-panel');
const CM = __dirname;
const browser = process.env.BROWSER_EXE || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
if (!browser) throw Error('Set BROWSER_EXE');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-quota-test-'));
const state = { me: 'isolated test', butlerOn: true, quota: true, sessions: [], notes: [], gpt: [], oai: false, tickets: [], waits: [],
  usage: { accounts: [{ label: 'test', windows: [], runway: 2 }], rec: 0, open: true, projects: [] } };
const accounts = normalize([
  { provider: 'claude', user: 'alice@example.com', name: 'Claude Code', plan: 'max', readAt: new Date().toISOString(), windows: [
    { name: '5 hours', used: 44, resetsAt: new Date(Date.now() + 2 * 3600000).toISOString() },
    { name: '7 days', used: 87, resetsAt: new Date(Date.now() + 86400000).toISOString() },
    { name: '7 days · Fable', used: 97 }] },
  { provider: 'test', user: 'bob@example.com', name: '<img src=x onerror=alert(1)>', plan: 'A very long subscription plan name that must wrap without overflow', readAt: '2026-01-01T00:00:00Z', windows: [
    { name: 'Unknown limit' }, { name: 'Unlimited', unlimited: true }, { name: 'Credits', text: true, display: '<script>alert(1)</script>' }] }
]).accounts.map((a, i) => ({ ...a, stale: i === 1 }));
let data = { configured: true, accounts, fetchedAt: new Date().toISOString(), refreshing: false, error: '', retryAt: 0 };
let count = 0, broken = false; const refreshes = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const json = (d, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname.startsWith('/api/local-quota')) {
    count++;
    if (broken) return json({ err: 'offline' }, 503);
    if (req.method === 'POST') {
      let b = ''; req.on('data', (v) => (b += v));
      return req.on('end', () => { refreshes.push(JSON.parse(b)); data.retryAt = Date.now() + 30000; json(data); });
    }
    return json(data);
  }
  if (u.pathname.startsWith('/api/')) return json(u.pathname === '/api/state' ? state : u.pathname === '/api/asks' ? [] : {});
  if (u.pathname === '/ext.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(''); } // no extension
  const rel = u.pathname === '/' ? 'web.html' : u.pathname.startsWith('/lib/') ? 'node_modules/' + u.pathname.slice(5) : u.pathname.slice(1);
  const file = path.resolve(CM, rel);
  if (!file.startsWith(CM + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.setHeader('content-type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
let proc, socket, seq = 0; const pending = new Map(), errors = [];
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq, t = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (e) => { clearTimeout(t); reject(e); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(expression) { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(50); } throw Error('Timed out: ' + expression); }
async function screenshot(name) {
  if (!process.env.QUOTA_SCREENSHOTS) return;
  fs.mkdirSync(process.env.QUOTA_SCREENSHOTS, { recursive: true });
  const r = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.env.QUOTA_SCREENSHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
}
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  proc = spawn(browser, ['--headless=new', '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const ws = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Error('Browser start timeout')), 15000); let log = '';
    proc.on('error', (e) => { clearTimeout(t); reject(e); });
    proc.stderr.on('data', (d) => { log += d; const m = log.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
  });
  const targets = await (await fetch(new URL(ws).origin.replace('ws:', 'http:') + '/json/list')).json();
  socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.addEventListener('open', r); socket.addEventListener('error', j); });
  socket.addEventListener('message', (e) => {
    const m = JSON.parse(e.data), p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await call('Runtime.enable'); await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('cm-look','dark');` });
  await call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
  await until("typeof state!=='undefined' && !!state");
  // 代理额度 in the bar before 设置, only while the service has a source for it; nothing read before it's opened
  assert.equal(await evaluate("[...document.querySelectorAll('#act [data-side]')].map(b=>b.dataset.side).join()"), 'chats,usage,tokens,proxy');
  assert.equal(await evaluate("document.querySelector('#gear').previousElementSibling.dataset.side"), 'proxy');
  assert.equal(await evaluate("document.querySelector('[data-side=proxy]').hidden"), false);
  assert.equal(await evaluate("state.quota=false;drawSide();const h=document.querySelector('[data-side=proxy]').hidden;state.quota=true;drawSide();h"), true);
  assert.equal(count, 0);
  console.log('代理额度 in the bar, hidden with no source ok');
  await evaluate("document.querySelector('[data-side=proxy]').click()"); await until('!!proxyQuota.data && !proxyQuota.busy');
  assert.equal(count, 1);
  assert.equal(await evaluate("document.querySelectorAll('.proxyQuota .card').length"), 2);
  assert.equal(await evaluate("document.querySelectorAll('.proxyQuota [role=meter]').length"), 3);
  assert.equal(await evaluate("!!document.querySelector('.proxyQuota img, .proxyQuota script')"), false);
  assert.equal(await evaluate("document.querySelector('.proxyQuota').textContent.includes('a***@example.com')"), true);
  assert.equal(await evaluate("document.querySelector('.proxyQuota').textContent.includes('alice@example.com')"), false);
  assert.equal(await evaluate("document.querySelector('.proxyQuota').textContent.includes('暂无读数')"), true);
  assert.equal(await evaluate("document.querySelector('.proxyQuota').textContent.includes('缓存参考')"), true);
  assert.equal(await evaluate("(() => { const b=document.querySelector('.proxyQuota [data-qrefresh]'); b.focus(); const key=b.dataset.i; proxyQuota.data.accounts[0].plan='max 20x'; drawSide(); return document.activeElement.dataset.i===key; })()"), true);
  await screenshot('quota-dark-desktop');
  await evaluate("localStorage.setItem('cm-look','light');look()"); await screenshot('quota-light-desktop');
  console.log('cards, arbitrary windows, masking, escaping, dark/light ok');

  await evaluate("document.querySelector('.proxyQuota [data-qrefresh]').click()"); await until('!proxyQuota.busy');
  assert.deepEqual(refreshes, [{ id: accounts[0].id }]);
  assert.equal(await evaluate("Array.from(document.querySelectorAll('[data-qrefresh]')).every(x=>x.disabled)"), true);
  data.retryAt = 0; await evaluate('proxyQuota.data.retryAt=0;renderProxyQuota()');
  await evaluate("document.querySelector('#sideActs [data-qrefresh]').click()"); await until('!proxyQuota.busy');
  assert.deepEqual(refreshes[1], {});
  broken = true; await evaluate('readProxyQuota()');
  assert.equal(await evaluate("document.querySelectorAll('.proxyQuota .card').length"), 2);
  assert.equal(await evaluate("document.querySelector('.proxyQuota .state.warn')!==null"), true);
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.proxyQuota .qTime')).every(x=>x.textContent.includes('缓存参考'))"), true);
  await screenshot('quota-offline');
  broken = false; data.retryAt = 0; await evaluate('readProxyQuota()');
  assert.equal(await evaluate('proxyQuota.error'), '');
  console.log('single/all refresh, cooldown, stale-on-error and recovery ok');

  await evaluate("document.querySelector('[data-side=chats]').click()");
  const before = count; await evaluate('proxyQuota.at=0;watchProxyQuota();readProxyQuota()'); await wait(100);
  assert.equal(count, before); assert.equal(await evaluate('proxyQuota.timer'), null);
  await evaluate("document.querySelector('[data-side=proxy]').click()"); await until('!proxyQuota.busy && !!proxyQuota.timer');
  await evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});dispatchEvent(new Event('visibilitychange'))");
  const hidden = count; await evaluate('readProxyQuota()'); await wait(100);
  assert.equal(count, hidden); assert.equal(await evaluate('proxyQuota.timer'), null);
  await evaluate("delete document.visibilityState;dispatchEvent(new Event('visibilitychange'))");
  console.log('no quota polling when hidden or on another tab ok');

  await call('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await wait(150); await evaluate('drawSide()');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=375'), true);
  assert.equal(await evaluate("[...document.querySelectorAll('.proxyQuota .card')].every(e=>e.scrollWidth<=e.clientWidth)"), true);
  assert.equal(await evaluate("document.querySelector('[data-side=proxy]').getBoundingClientRect().width>=44"), true);
  await screenshot('quota-light-mobile');
  await evaluate("localStorage.setItem('cm-look','dark');look()"); await screenshot('quota-dark-mobile');
  await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true }); await wait(100);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=320'), true);
  assert.equal(await evaluate("[...document.querySelectorAll('.proxyQuota .card')].every(e=>e.scrollWidth<=e.clientWidth)"), true);
  console.log('375px and 320px mobile layout ok');

  data = { ...data, accounts: [], error: '' }; await evaluate('readProxyQuota()');
  assert.equal(await evaluate("document.querySelectorAll('.proxyQuota .card').length"), 0);
  assert.equal(await evaluate("document.querySelector('.proxyQuota').textContent.includes('尚无可显示')"), true);
  data = { ...data, configured: false, error: '尚未配置额度来源。' }; await evaluate('readProxyQuota()');
  assert.equal(await evaluate("document.querySelector('.proxyQuota').textContent.includes('尚未配置')"), true);
  assert.deepEqual(errors, []);
  console.log('empty/configuration states and no browser exceptions ok');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (socket?.readyState === WebSocket.OPEN) { await call('Browser.close').catch(() => {}); socket.close(); }
  if (proc && proc.exitCode === null) { proc.kill(); await new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); }); }
  for (const p of pending.values()) p.reject(Error('Browser closed')); pending.clear();
  server.closeAllConnections(); server.close();
  const target = path.resolve(profile);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('cm-quota-test-')) throw Error('Unexpected test profile path');
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
