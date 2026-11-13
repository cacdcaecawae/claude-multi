// node web.test.js: real Chromium layout and keyboard checks, with a temporary profile and fake API only.
const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const { spawn } = require('child_process');
const browser = process.env.BROWSER_EXE || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((f) => fs.existsSync(f));
if (!browser) throw Error('Set BROWSER_EXE to a Chromium browser executable');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-browser-test-'));
const state = { me: 'isolated test', butlerOn: true, sessions: [{ id: 'A', title: 'Test conversation', acct: 0, cwd: 'C:/test', at: Date.now(), pid: 123 }],
  notes: [], gpt: [], oai: true, tickets: [], waits: [], usage: { accounts: [{ label: 'test', windows: [], runway: 2 }], rec: 0, open: true, projects: [] } };
const long = 'Full answer '.repeat(2500) + 'END_MARKER';
let historyId = 'A', oai = { items: [], busy: false }, oaiSent = null; // a GPT 聊天 one as the service has it, and the message it got
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/project') { // 项目, kept as the service keeps them
    let b = ''; req.on('data', (d) => (b += d));
    return req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(require('./claude-multi').projectOp(state.projects ??= [], JSON.parse(b)))); });
  }
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
    // Claude Code's copies (OSC 52): one in the output sent again on connecting, one live after it
    const osc = (t) => `event: data\ndata: ${JSON.stringify(`x\x1b]52;c;${Buffer.from(t).toString('base64')}\x07y`)}\n\n`;
    res.write(osc('旧的复制'));
    setTimeout(() => res.write(osc('终端里复制的中文')), 300);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    const data = url.pathname === '/api/state' ? state : url.pathname === '/api/asks' ? []
      : url.pathname === '/api/tokens' ? tokens
      : url.pathname === '/api/open' ? { key: 'fixture', pid: 123, kind: 'pty' }
      : url.pathname === '/api/machines' ? [{ id: 'here', name: 'PC', cpu: 50, cpuClaude: 20, mem: 8 * 2 ** 30, memClaude: 2 * 2 ** 30, memAll: 16 * 2 ** 30, n: 3 }]
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
// the PC's day, not this computer's: 用量's 今天 is its last one
const z = { i: 0, o: 0, cw: 0, cr: 0, usd: 0, n: 0 }, tokens = { accounts: [{ label: 'a', total: 7, usd: 0 }], total: 7, usd: 0, today: '2000-01-02',
  days: [{ d: '2000-01-02', ...z, i: 7, n: 1, by: [{ ...z, i: 7, n: 1 }] }] };
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
  // a mouse and keyboard, as the page's FINE wants: on a touch screen, or with no desktop (over SSH), it'd be taken for a phone
  proc = spawn(browser, ['--headless=new', '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
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
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(navigator,'clipboard',{value:{writeText:async t=>{window.copied=t;(window.copies||=[]).push(t);}}});` });
  await call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
  for (let i = 0; i < 100 && !(await evaluate("typeof state!=='undefined' && !!state")); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await evaluate('!!state'), true);
  await evaluate("document.querySelector('[data-open=\"A\"]').focus()"); await press('Enter');
  for (let i = 0; i < 100 && !(await evaluate("!!document.querySelector('.hm[data-raw]')")); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await evaluate("document.querySelector('.hm[data-raw]').dataset.raw.endsWith('END_MARKER')"), true);
  for (let i = 0; i < 40 && !(await evaluate("(window.copies||[]).includes('终端里复制的中文')")); i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await evaluate('window.copies'), ['终端里复制的中文']); // the live copy, not the one sent again
  console.log('browser terminal copy (OSC 52) ok');
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

  // 额度's CPU and memory, this computer's under 推荐账号: Claude Code's part of each meter, then the rest in use
  await evaluate("document.querySelector('#act [data-side=usage]').click()");
  for (let i = 0; i < 100 && (await evaluate("document.querySelector('[data-machine=here] b')?.textContent")) !== '50%'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-machine=here] .meter.two > i')].map((i) => i.style.width)"), ['20%', '30%', '12.5%', '37.5%']);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-machine=here] .win')].map((r) => r.textContent)"), ['CPU50%Claude 20%', '内存50%Claude 2.0 GB']);
  await evaluate("document.querySelector('#act [data-side=chats]').click()");
  console.log('browser CPU and memory in 额度 ok');
  // a waiting one's marks (the list's dot, a tab's ×, 提示's !) keep their size: the question card's class is ask too
  assert.deepEqual(await evaluate("(() => { const d = document.createElement('div'); d.style.display = 'flex'; d.innerHTML = '<i class=\"nd ask\"></i><button class=\"x ask\"></button><i class=\"dot ask\"></i>'; document.body.append(d); const r = [...d.children].map((e) => [e.offsetWidth, getComputedStyle(e).paddingTop]); d.remove(); return [r[0][0], r[1][0], r[2][1]]; })()"), [8, 20, '0px']);
  console.log('browser waiting marks ok');

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
  // a note that came while its conversation was already shown: read in the pane you're in, this window in front only
  await evaluate("state.notes=[{id:'A',kind:'done',at:5,by:'you'}]; document.hasFocus=()=>false; readShown({active:{id:'A'}})");
  assert.equal(await evaluate('state.notes.length'), 1);
  await evaluate("document.hasFocus=()=>true; readShown({active:{id:'B'}})");
  assert.equal(await evaluate('state.notes.length'), 1);
  await evaluate("readShown({active:{id:'A'}})");
  assert.equal(await evaluate('state.notes.length'), 0);
  await evaluate('delete document.hasFocus');
  // the 管家's own answer to you, its pane out of sight: a red dot on its icon and a notice; to a [系统通知], nothing
  const bdot = () => evaluate("[document.querySelector('#act .logo').classList.contains('new'), document.querySelector('#toast').style.display === 'block' ? document.querySelector('#toast').textContent : '']");
  await evaluate("state.butler='C:/b'; state.sessions.push({id:'M',title:'x',acct:0,cwd:'C:/b',at:1,pid:5}); state.notes=[{id:'M',kind:'done',at:3,by:'notice'}]; newNotes()");
  assert.deepEqual(await bdot(), [false, '']);
  await evaluate("state.notes=[{id:'M',kind:'done',at:4,by:'you'}]; newNotes()");
  assert.deepEqual(await bdot(), [true, '管家答完了，进入管家看']);
  await evaluate("readNote('M')");
  assert.equal((await bdot())[0], false);
  await evaluate("state.sessions.pop(); state.butler=null; document.querySelector('#toast').style.display='none'");
  // switched off in 设置: its spark gone, out of its mode, and not gone into again
  assert.deepEqual(await evaluate("(()=>{setButler(true);const r=[butler];state.butlerOn=false;butlerShown();r.push(butler,getComputedStyle(document.querySelector('#act .logo')).display);setButler(true);r.push(butler);state.butlerOn=true;butlerShown();return r})()"), [true, false, 'none', false]);
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
  // 用量 on the PC's day (its today the last one), not this computer's
  await evaluate("document.querySelector('#act [data-side=tokens]').click()");
  const tile = "[...document.querySelectorAll('.tile')].find((e) => e.querySelector('.k').textContent === '今天')?.querySelector('.v').textContent";
  for (let i = 0; i < 100 && !(await evaluate(tile)); i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([await evaluate(tile), await evaluate("document.querySelector('.ticks span').textContent")], ['7', '12/20']);
  // each account in its own color, today's too (a whole bar in the accent hid whose it was), the same as its ring below
  assert.deepEqual(await evaluate("(() => { const i = document.querySelector('.bars > div:last-child i'); return [i.style.background, i.title, document.querySelector('.cardHead .ac').style.getPropertyValue('--c')]; })()"),
    ['var(--s1)', '1/2 账号 1 7 · $0', 'var(--s1)']);
  assert.deepEqual(errors, []);
  console.log('browser mobile targets, light theme, page width and 用量 on the PC\'s day ok');
  // 新对话 on the Mac mini: its own folder there (no folder here) unless one is picked; back to an account here, a folder here
  // (and a second Mac, a MacBook's account: offered beside it, its own folder there)
  assert.equal(await evaluate(`(() => { state.macs = [{ id: 'mac', label: 'Mac mini', dir: '~/Desktop/mine', host: 'mini' },
      { id: 'la-a1', label: 'Mac a1', dir: '~/work', host: 'mymac', icon: 'rainbow' }]; state.usage.projects = ['F:/proj'];
    const on = () => document.querySelector('#sheetIn [data-d].on')?.dataset.d ?? 'none', text = () => document.querySelector('#sheetIn').textContent;
    newSheet(); const a = on(); document.querySelector('#sheetIn [data-a="mac"]').click(); const b = on();
    const said = text().includes('直接在 Mac mini 上的 ~/Desktop/mine 里运行');
    document.querySelector('#sheetIn [data-a="la-a1"]').click(); const la = on() + '/' + text().includes('直接在 Mac a1 上的 ~/work 里运行');
    document.querySelector('#sheetIn [data-a="1"]').click(); const c = on(); sheetOff(); state.usage.projects = [];
    return [a, b, said, la, c].join(' | '); })()`), 'F:/proj |  | true | /true | F:/proj');
  console.log('browser 新对话 Mac mini in mine, and a second Mac ok');
  // 用量: each Mac's records (listed last) under its name and its mark (Apple's; the old rainbow one for the MacBook), not as one more 账号 n
  assert.equal(await evaluate(`(() => {
    tokens = { accounts: [{ label: 'a@x', total: 1, usd: 0 }, { label: 'Mac mini', total: 1, usd: 0, mac: 'mac' }, { label: 'Mac a1', total: 1, usd: 0, mac: 'la-a1' }], days: [], total: 3, usd: 0, today: '2000-01-02' }; renderTokens();
    const h = [...document.querySelectorAll('#view .cardHead')];
    return h.map((x) => x.querySelector('b').textContent + (x.querySelector('.mk svg linearGradient stop[stop-color="#61BB46"]') ? '+rainbow' : x.querySelector('.mk svg') ? '+apple' : '')).join(' | '); })()`),
    '账号 1 | Mac mini+apple | Mac a1+rainbow');
  console.log('browser 用量 Mac mini and a MacBook ok');
  // 换账号继续 on a Mac's: off in the list's menu, saying whose account it runs on; asked for anyway, a note, no card
  assert.equal(await evaluate(`(() => { const id = '0f1e2d3c-4b5a-4968-8776-000000000001';
    state.sessions.push({ id, title: 'on Mac', cwd: '/Users/me/work', acct: -1, mac: 'la-a1', at: Date.now(), pid: null });
    rowMenu(id, 10, 10); const b = [...document.querySelectorAll('[data-m="swap"]')].pop(), said = [b.disabled, b.textContent].join(' / ');
    $('#cmenu').hidden = true; sheetOff(); swapFrom(state.sessions.at(-1)); const sheet = document.querySelector('#sheet').classList.contains('on');
    state.sessions.pop(); return said + ' / ' + sheet; })()`), 'true / 换账号继续…用的是 Mac a1 的账号，换不了 / false');
  console.log('browser 换账号 off for a Mac one ok');
  // a conversation's ⋯: 新对话 opens another tab beside it, in its folder on its account (a Mac's: on that Mac, its folder
  // here); its 换账号继续 off on a Mac; no 新对话 in the 管家's folder (the newest there is the 管家)
  assert.equal(await evaluate(`(async () => {
    const g = focusG, last = () => [...document.querySelectorAll('[data-m]')], pick = (k) => last().filter((b) => b.dataset.m === k).pop(), out = [];
    const tab = (body, title) => { const c = makeConv(body, title); addConv(g, c); return c; };
    const menu = (c) => { c.el.querySelector('[data-act="more"]').click(); return ['fresh', 'swap', 'end'].map((k) => pick(k).disabled ? 'off' : 'on').join(','); };
    const a = tab({ id: 'A' }, 'Test conversation'); await new Promise((ok) => setTimeout(ok, 300));
    out.push(menu(a)); pick('fresh').click(); const n = g.active; out.push([n !== a, n.dir(), n.acct, n.mac, n.title].join(','));
    state.sessions.push({ id: 'M', title: 'on Mac', cwd: 'F:/proj', macCwd: '/Users/me/work/proj', acct: -1, mac: 'la-a1', at: Date.now(), pid: null });
    const m = tab({ id: 'M' }, 'on Mac'); out.push(menu(m), pick('swap').textContent); pick('fresh').click(); const mn = g.active; out.push([mn.mac, mn.dir()].join(','));
    state.butler = 'C:/test'; out.push(menu(a)); delete state.butler; sheetOff(); $('#cmenu').hidden = true;
    for (const c of [a, n, m, mn]) closeConv(c); state.sessions.pop();
    return out.join(' | '); })()`),
    'on,on,on | true,C:/test,1,,test | on,off,off | 换账号继续…用的是 Mac a1 的账号，换不了 | la-a1,F:/proj | off,on,on');
  console.log('browser a conversation\'s ⋯ (新对话, 换账号, 结束) ok');
  // 项目: the grid lists yours (a conversation from any folder; one no longer listed skipped); its ＋ offers those not in it
  // and adds the one picked; a row's menu there takes one out; ⋯'s 新对话 from one in a 项目 joins it
  assert.equal(await evaluate(`(async () => {
    const out = [], wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), pick = (k) => [...document.querySelectorAll('[data-m]')].filter((b) => b.dataset.m === k).pop();
    await projPost({ op: 'new', name: '论文' }); await projPost({ op: 'add', id: 1, conv: ['A', 'gone-1'] }); await load();
    menuAt = 0; side = 'chats'; listMode = 'dirs'; renderChats(); document.querySelector('#sideActs [data-proj]').click();
    out.push([listMode, document.querySelector('#sideActs [data-proj]').classList.contains('on'), !!document.querySelector('#view [data-newp]'),
      [...document.querySelectorAll('#view [data-sec="p:1"] [data-open]')].map((r) => r.dataset.open).join()].join(','));
    state.sessions.push({ id: 'C', title: 'other folder', cwd: 'F:/other', acct: 0, at: Date.now(), pid: null });
    findSheet(projOf(1)); out.push([...document.querySelectorAll('#findList [data-open]')].map((r) => r.dataset.open).join());
    document.querySelector('#findList [data-open="C"]').click(); await wait(400); sheetOff(); out.push(projOf(1).ids.join());
    menuAt = 0; rowMenu('A', 10, 10, '1'); pick('out').click(); await wait(400); out.push(projOf(1).ids.join()); $('#cmenu').hidden = true; sheetOff();
    const c = makeConv({ id: 'C' }, 'other folder'); addConv(focusG, c); c.fresh(); const n = focusG.active; out.push(n.joins.join());
    closeConv(n); closeConv(c); await projPost({ op: 'drop', id: 1 }); listMode = 'dirs'; await load();
    return out.join(' | '); })()`), 'proj,true,true,A | C | A,gone-1,C | gone-1,C | 1');
  console.log('browser 项目 ok');
  // a file in a message of yours: a card opening it (its saved name found in the record's text, a Mac's path too), its
  // kind from its ending; the bubble's text as before (停止 compares it); one on its way: a card, no link yet
  assert.equal(await evaluate(`(() => { const raw = '看看这个\\n附件：/Users/me/work/.uploads/20261113T081500-a1b2c3-全文-中文-v16.pdf';
    const m = { role: 'user', text: shownText(raw), files: filesOf(raw) }, d = document.createElement('div'); d.innerHTML = userHtml(m, '');
    const a = d.querySelector('a.att'), p = document.createElement('div'); p.innerHTML = userBody('附件：x.docx', [], true);
    return [a.className, a.dataset.ext, a.getAttribute('href'), d.textContent.replace(/\\s+/g, ''), !!p.querySelector('span.att.doc'), !p.querySelector('a')].join(' | '); })()`),
    'att pdf | PDF | /api/file?n=20261113T081500-a1b2c3-%E5%85%A8%E6%96%87-%E4%B8%AD%E6%96%87-v16.pdf | 看看这个附件：全文-中文-v16.pdf | true | true');
  console.log('browser 附件 cards ok');
  // a picture clicked: big in the middle of the page (no new tab), Esc puts it away; Ctrl+click left to the browser
  assert.equal(await evaluate(`(() => { const src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', a = document.createElement('a');
    a.className = 'hm img'; a.href = src; a.target = '_blank'; a.innerHTML = '<img alt="">'; document.body.append(a);
    let ctrlLeft = null; a.addEventListener('click', (e) => { if (e.ctrlKey) { ctrlLeft = !e.defaultPrevented; e.preventDefault(); } });
    a.querySelector('img').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const z = document.querySelector('#zoom'), up = !z.hidden && z.querySelector('img').getAttribute('src') === src && document.activeElement === z;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); const gone = z.hidden;
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })); const stayed = z.hidden;
    a.remove(); return [up, gone, stayed, ctrlLeft].join(' | '); })()`), 'true | true | true | true');
  console.log('browser picture shown big ok');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (socket?.readyState === WebSocket.OPEN) { await call('Browser.close').catch(() => {}); socket.close(); }
  if (proc && proc.exitCode === null) { proc.kill(); await new Promise((resolve) => { proc.once('exit', resolve); setTimeout(resolve, 3000); }); }
  for (const p of pending.values()) p.reject(Error('Browser closed')); pending.clear();
  server.closeAllConnections(); server.close();
  const cleanup = path.resolve(profile);
  if (path.dirname(cleanup) !== path.resolve(os.tmpdir()) || !path.basename(cleanup).startsWith('cm-browser-test-')) throw Error('Unexpected test profile path');
  fs.rmSync(cleanup, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
