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
  notes: [], gpt: [], oai: true, tickets: [], waits: [], usage: { accounts: [{ label: 'test', windows: [], runway: 2 }], rec: 0, open: true, projects: [] } };
const long = 'Full answer '.repeat(2500) + 'END_MARKER';
let historyId = 'A', oai = { items: [], busy: false }, oaiSent = null; // a GPT 聊天 one as the service has it, and the message it got
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/oai/send') {
    let b = ''; req.on('data', (d) => (b += d));
    return req.on('end', () => {
      oaiSent = JSON.parse(b);
      oai = { items: [{ role: 'user', text: oaiSent.text, at: Date.now() }], busy: true, since: Date.now(), opts: { mode: oaiSent.mode, effort: oaiSent.effort } };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'oai-1' }));
    });
  }
  if (url.pathname === '/api/term') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: size\ndata: {"w":100,"h":30,"kind":"pty"}\n\n');
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    const data = url.pathname === '/api/state' ? state : url.pathname === '/api/asks' ? []
      : url.pathname === '/api/tokens' ? { accounts: [], days: [] }
      : url.pathname === '/api/open' ? { key: 'fixture', pid: 123, kind: 'pty' }
      : url.pathname === '/api/history' ? { id: historyId, start: 0, end: 1, items: [{ role: 'claude', text: long }] }
      : url.pathname === '/api/oai' ? { ...oai, title: 'Pro 你好' } : {};
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

  // the 管家's 操作台: a running conversation that answered a turn you set going, not looked at, says 答完了 with a red
  // dot (counted apart from 空闲) till it's opened (its note read); answering the 管家's own turn, it stays 空闲. One of
  // yours answering while you look at another (in 管家 mode the list is out of sight) says so in a notice
  const desk = () => evaluate("[...document.querySelectorAll('#deskRun .counts span')].map(s=>s.textContent.trim()).join(' ') + ' | ' + [...document.querySelectorAll('#deskRun .item .pill')].map(p=>p.textContent).join(' ') + (document.querySelector('#deskRun .nd.red') ? ' •' : '')");
  await evaluate("state.notes=[{id:'A',kind:'done',at:1,by:'butler'}]; butler=true; drawDesk()");
  assert.equal(await desk(), '0等你 0在回复 0答完了 1空闲 | 空闲');
  await evaluate("state.notes=[{id:'A',kind:'done',at:2,by:'you'}]; drawDesk(); notesSeen=new Set(); newNotes()");
  assert.equal(await desk(), '0等你 0在回复 1答完了 0空闲 | 答完了 •');
  assert.match(await evaluate("document.querySelector('#toast').textContent"), /^「Test conversation」答完了，在右边「对话」里点开看$/);
  await evaluate("readNote('A')");
  assert.equal(await desk(), '0等你 0在回复 0答完了 1空闲 | 空闲');
  await evaluate("butler=false; document.querySelector('#toast').style.display='none'");
  // the 管家's own answer to you, its pane out of sight: a red dot on its icon and a notice; to a [系统通知], nothing
  const bdot = () => evaluate("[document.querySelector('#act .logo').classList.contains('new'), document.querySelector('#toast').style.display === 'block' ? document.querySelector('#toast').textContent : '']");
  await evaluate("state.butler='C:/b'; state.sessions.push({id:'M',title:'x',acct:0,cwd:'C:/b',at:1,pid:5}); state.notes=[{id:'M',kind:'done',at:3,by:'notice'}]; newNotes()");
  assert.deepEqual(await bdot(), [false, '']);
  await evaluate("state.notes=[{id:'M',kind:'done',at:4,by:'you'}]; newNotes()");
  assert.deepEqual(await bdot(), [true, '管家答完了，进入管家看']);
  await evaluate("readNote('M')");
  assert.equal((await bdot())[0], false);
  await evaluate("state.sessions.pop(); state.butler=null; document.querySelector('#toast').style.display='none'");
  console.log('browser 管家 desk 答完了 ok');

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

  // GPT 聊天: 新对话's GPT with only a key (no Codex account): neither account nor folder. Pro and the most effort
  // picked on the button by the box, a message sent with them, 正在思考 (and 停止) while OpenAI answers, then the answer
  // under OpenAI's mark with how long it took
  const until = async (expr) => { for (let i = 0; i < 100 && !(await evaluate(expr)); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(await evaluate(expr), expr); };
  await evaluate("document.querySelector('[data-new]').click()");
  await evaluate("document.querySelector('[data-g=\"1\"]').click()");
  assert.deepEqual(await evaluate("[!!document.querySelector('#dirIn'), !!document.querySelector('[data-chat]')]"), [false, false]);
  await evaluate("document.querySelector('#start').click()");
  assert.equal(await evaluate("document.querySelector('.pane.on .bset').textContent"), '普通 · 中');
  await evaluate("document.querySelector('.pane.on .bset').click()");
  await evaluate("document.querySelector('.pane.on .bPop [data-om=\"pro\"]').click()");
  await evaluate("const r=document.querySelector('.pane.on .bPop input');r.value=4;r.dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("document.querySelector('.pane.on .bset').textContent"), 'Pro · 最高');
  await evaluate("const t=document.querySelector('.pane.on .send textarea');t.value='Pro 你好';t.dispatchEvent(new Event('input'));document.querySelector('.pane.on .go').click()");
  await until("document.querySelector('.pane.on .live .busy')?.textContent.includes('正在思考（Pro · 最高）')");
  assert.deepEqual(oaiSent, { id: null, text: 'Pro 你好', paths: [], mode: 'pro', effort: 'max' });
  assert.deepEqual(await evaluate("[focusG.active.id, document.querySelector('.pane.on .go').dataset.m, document.querySelector('.pane.on .hm.user').textContent, localStorage.getItem('cm-oai')]"),
    ['oai-1', 'stop', 'Pro 你好', '{"mode":"pro","effort":"max"}']);
  oai = { ...oai, items: [...oai.items, { role: 'claude', text: '你好，我是 **Pro**', at: Date.now() }, { role: 'done', text: '65000' }], busy: false };
  await until("document.querySelector('.pane.on .hm.claude')?.textContent.includes('我是 Pro')");
  assert.deepEqual(await evaluate("[!!document.querySelector('.pane.on .who .gm'), document.querySelector('.pane.on .who .took').textContent, document.querySelector('.pane.on .live').innerHTML, document.querySelector('.pane.on .go').dataset.m]"),
    [true, '✓ 回复完成 · 用时 1 分 5 秒', '', 'send']);
  await evaluate('closeConv(focusG.active)');
  console.log('browser GPT chat ok');

  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("sideOn=false;drawSide();localStorage.setItem('cm-look','light');look()");
  await new Promise((r) => setTimeout(r, 150));
  // small to the eye (drawn 44 px, they hung off code blocks and stood tall over the conversation), a finger's size to the
  // touch: a point just past the edge still lands on the button
  for (const [selector, past] of [['.hm.claude > .cpy', 7], ['.pane.on .seg button', 4]]) {
    const r = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return [r.height,document.elementFromPoint(r.left+r.width/2,r.top-${past})===e]})()`);
    assert.ok(r[0] <= 36 && r[1], selector + ': ' + r);
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
