// node web.test.js: real Chromium layout and keyboard checks, with a temporary profile and fake API only.
const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const { spawn } = require('child_process');
const browser = process.env.BROWSER_EXE || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((f) => fs.existsSync(f));
if (!browser) throw Error('Set BROWSER_EXE to a Chromium browser executable');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-browser-test-'));
const state = { me: 'isolated test', sessions: [{ id: 'A', title: 'Test conversation', acct: 0, cwd: 'C:/test', at: Date.now(), pid: 123 }],
  notes: [], gpt: [], tickets: [], waits: [], usage: { accounts: [{ label: 'test', windows: [], runway: 2 }], rec: 0, open: true, projects: [] } };
const long = 'Full answer '.repeat(2500) + 'END_MARKER';
let historyId = 'A';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/term') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: size\ndata: {"w":100,"h":30,"kind":"pty"}\n\n');
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    const data = url.pathname === '/api/state' ? state : url.pathname === '/api/asks' ? []
      : url.pathname === '/api/tokens' ? { accounts: [], days: [] }
      : url.pathname === '/api/open' ? { key: 'fixture', pid: 123, kind: 'pty' }
      : url.pathname === '/api/history' ? { id: historyId, start: 0, end: 1, items: [{ role: 'claude', text: long }] } : {};
    res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(data));
  }
  const relative = url.pathname === '/' ? 'web.html' : url.pathname.startsWith('/lib/') ? 'node_modules/' + url.pathname.slice(5) : url.pathname.slice(1);
  const file = path.resolve(__dirname, relative);
  if (!file.startsWith(__dirname + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.setHeader('content-type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
let proc, socket, id = 0;
const pending = new Map(), errors = [];
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const n = ++id, timeout = setTimeout(() => { pending.delete(n); reject(Error('CDP timeout: ' + method)); }, 15000);
    pending.set(n, { resolve: (r) => { clearTimeout(timeout); resolve(r); }, reject: (e) => { clearTimeout(timeout); reject(e); } });
    socket.send(JSON.stringify({ id: n, method, params }));
  });
}
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const press = async (key, shift = false) => {
  const windowsVirtualKeyCode = { Tab: 9, Enter: 13, Escape: 27 }[key];
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode, modifiers: shift ? 8 : 0 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode });
};
(async () => {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  proc = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const ws = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Browser startup timeout')), 15000); let log = '';
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.stderr.on('data', (d) => { log += d; const m = log.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  const origin = new URL(ws).origin.replace('ws:', 'http:');
  const targets = await (await fetch(origin + '/json/list')).json();
  socket = new WebSocket(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  socket.addEventListener('message', (event) => {
    const m = JSON.parse(event.data), p = pending.get(m.id);
    if (p) { pending.delete(m.id); if (m.error) p.reject(Error(m.error.message)); else p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await call('Runtime.enable'); await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(navigator,'clipboard',{value:{writeText:async t=>{window.copied=t;}}});` });
  await call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
  for (let i = 0; i < 100 && !(await evaluate("typeof state!=='undefined' && !!state")); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await evaluate('!!state'), true);
  await evaluate("document.querySelector('[data-open=\"A\"]').focus()"); await press('Enter');
  for (let i = 0; i < 100 && !(await evaluate("!!document.querySelector('.hm[data-raw]')")); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await evaluate("document.querySelector('.hm[data-raw]').dataset.raw.endsWith('END_MARKER')"), true);
  await evaluate("document.querySelector('.hm[data-raw] [data-copy]').click()");
  assert.equal(await evaluate('window.copied'), long);
  assert.equal(await evaluate("!!document.querySelector('.hm.long [data-more]')"), true);
  await evaluate("document.querySelector('.hm.long [data-more]').click()");
  assert.equal(await evaluate("document.querySelector('.hm.long').classList.contains('open')"), true);
  console.log('browser history, long answer and copy ok');

  await evaluate("document.querySelector('.send textarea').value='draft A';document.querySelector('.send textarea').dispatchEvent(new Event('input'));localStorage.setItem('cm-draft:B','draft B')");
  historyId = 'B';
  for (let i = 0; i < 60 && !(await evaluate("allConvs()[0].id==='B'")); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await evaluate("document.querySelector('.send textarea').value"), 'draft B');
  assert.equal(await evaluate("localStorage.getItem('cm-draft:A')"), 'draft A');
  historyId = 'A';
  for (let i = 0; i < 60 && !(await evaluate("allConvs()[0].id==='A'")); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await evaluate("document.querySelector('.send textarea').value"), 'draft A');
  const quick = await evaluate(`(async()=>{
    const old=bConv,i=document.querySelector('#deskAdd input'),form=document.querySelector('#deskAdd');
    try {
      bConv={started:true,ended:false,say:async()=>false}; i.value='keep task';
      await form.onsubmit({preventDefault(){}}); const refused=i.value;
      let done; bConv.say=()=>new Promise(r=>done=r);
      const sending=form.onsubmit({preventDefault(){}}); i.value='next task'; done(true); await sending;
      return [refused,i.value];
    } finally {bConv=old;}
  })()`);
  assert.deepEqual(quick, ['keep task', 'next task']);
  console.log('browser session drafts and quick form ok');

  // The settings dialog cycles focus, makes the background inert, and returns focus to its opener on Escape.
  await evaluate("document.querySelector('#gear').focus(); document.querySelector('#gear').click()");
  assert.equal(await evaluate("document.querySelector('#sheet').contains(document.activeElement)"), true);
  assert.equal(await evaluate("document.querySelector('#app').inert"), true);
  await evaluate("window.testControls=[...document.querySelectorAll('#sheetIn button, #sheetIn input, #sheetIn [tabindex]')].filter(x=>!x.disabled&&x.tabIndex>=0&&x.getClientRects().length);testControls.at(-1).focus()");
  await press('Tab'); assert.equal(await evaluate('document.activeElement===testControls[0]'), true);
  await press('Tab', true); assert.equal(await evaluate('document.activeElement===testControls.at(-1)'), true);
  await press('Escape'); assert.equal(await evaluate("document.activeElement.id"), 'gear');
  assert.equal(await evaluate("document.querySelector('#app').inert"), false);
  // A dialog with no controls still owns the focus and can be closed with Escape.
  await evaluate("document.querySelector('#sheetIn').innerHTML='<p>Message</p>';document.querySelector('#sheet').classList.add('on')");
  await press('Tab'); assert.equal(await evaluate('document.activeElement.id'), 'sheetIn'); await press('Escape');
  console.log('browser modal focus, Tab, Shift+Tab and Escape ok');

  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("sideOn=false;drawSide();localStorage.setItem('cm-look','light');look()");
  await new Promise((r) => setTimeout(r, 150));
  for (const selector of ['.tab .x', '.crumbs [data-act=swap]', '.crumbs [data-act=end]', '.go', '.bar .pic', '.hm.claude > .cpy']) {
    const r = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return [r.width,r.height]})()`);
    assert.ok(r[0] >= 44 && r[1] >= 44, selector + ': ' + r);
  }
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  // Optionally keep a screenshot outside the repository for visual review.
  if (process.env.CM_TEST_SCREENSHOT) fs.writeFileSync(process.env.CM_TEST_SCREENSHOT, Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  assert.deepEqual(errors, []);
  console.log('browser mobile targets, light theme and page width ok');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (socket?.readyState === WebSocket.OPEN) { await call('Browser.close').catch(() => {}); socket.close(); }
  if (proc && proc.exitCode === null) { proc.kill(); await new Promise((resolve) => { proc.once('exit', resolve); setTimeout(resolve, 3000); }); }
  for (const p of pending.values()) p.reject(Error('Browser closed')); pending.clear();
  server.closeAllConnections(); server.close();
  const cleanup = path.resolve(profile);
  if (path.dirname(cleanup) !== path.resolve(os.tmpdir()) || !path.basename(cleanup).startsWith('cm-browser-test-')) throw Error('Unexpected test profile path');
  fs.rmSync(cleanup, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
