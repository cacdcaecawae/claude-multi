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
let termBusy = false, opens = 0; // a stream whose screen shows Claude at work (its end never sent); the terminals opened
let termGem = '', gemRes = null; // one whose screen shows agy's (these rows), and its stream, to show more on it later
const inputs = []; // what was typed into the terminals (/api/input), in order
const openBodies = []; // what each open asked for
let histHang = false, hung = null; // the next history read never answered (a phone's request left hanging); that one
let histFeed = null; // set: what the record brought since the last read (each read takes it), else the long answer every time
let histQueue = null; // set: what the record says waits in Claude's queue, with every read
const histReads = []; // when each history read came
const histUrls = []; // what each asked (the last 50)
// 新对话's 浏览: each folder's folders and files (a path: its own), and the places at the top ('')
const dirs = { '': { path: '', up: null, dirs: ['C:/Users/ly', 'C:/Users/ly/Desktop', 'D:/'], files: [] },
  'D:/': { path: 'D:/', up: '', dirs: ['D:/work', 'D:/.cache'], files: ['a.civa'] }, 'D:/work': { path: 'D:/work', up: 'D:/', dirs: [], files: [] } };
let oaiHold = null; // a promise: GPT 聊天's send answered only once it settles
const cmdAsks = []; // whose commands / asked for, in turn
const CMDS = [{ name: 'usage', desc: 'Show usage', hint: '' }, { name: 'usage-credits', desc: 'Credits', hint: '' }, { name: 'clear', desc: 'Start anew', hint: '[name]' }, { name: 'status', desc: 'Status', hint: '' }];
dirs['D:\\figs'] = { path: 'D:\\figs', up: 'D:\\', dirs: ['D:\\figs\\old'], files: ['图7.pptx', 'a.png', 'x.exe'] };
dirs['C:/test'] = { path: 'C:/test', up: 'C:/', dirs: ['C:/test/sub'], files: ['a.png', 'b.md'] }; // conversation A's folder
dirs['C:/test/sub'] = { path: 'C:/test/sub', up: 'C:/test', dirs: [], files: ['c.txt'] };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/input') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { inputs.push(JSON.parse(b).data); } catch {} }); }
  if (url.pathname === '/api/open') { opens++; let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { openBodies.push(JSON.parse(b)); } catch {} }); }
  if (url.pathname === '/api/history') { histReads.push(Date.now()); histUrls.push(url.search); if (histUrls.length > 50) histUrls.shift(); }
  if (url.pathname === '/api/history' && histHang) { histHang = false; hung = res; return; } // left open, never answered
  if (url.pathname.startsWith('/api/peek') && /missing/.test(url.searchParams.get('path'))) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('没有这个文件：' + url.searchParams.get('path')); }
  if (url.pathname.startsWith('/api/peek') && /oldsvc/.test(url.searchParams.get('path'))) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"err":"没有这个地址"}'); } // a service before 预览
  if (url.pathname.startsWith('/api/peek') && !url.searchParams.has('warm')) return setTimeout(() => { res.setHeader('content-type', 'text/plain'); res.end('the file'); }, 1500); // (an Office one's PDF takes a while)
  if (url.pathname === '/api/project') { // 项目, kept as the service keeps them
    let b = ''; req.on('data', (d) => (b += d));
    return req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(require('./claude-multi').projectOp(state.projects ??= [], JSON.parse(b)))); });
  }
  if (url.pathname === '/api/oai/send') {
    let b = ''; req.on('data', (d) => (b += d));
    return req.on('end', () => (oaiHold ?? Promise.resolve()).then(() => { // oaiHold: one still on its way
      oaiSent = JSON.parse(b);
      oai = { items: [{ role: 'user', text: oaiSent.text, at: Date.now() }], busy: true, since: Date.now(), opts: { mode: oaiSent.mode, effort: oaiSent.effort } };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'oai-1' }));
    }));
  }
  if (url.pathname === '/api/term') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: size\ndata: {"w":100,"h":30,"kind":"pty"}\n\n');
    // Claude Code's copies (OSC 52): one in the output sent again on connecting, one live after it
    const osc = (t) => `event: data\ndata: ${JSON.stringify(`x\x1b]52;c;${Buffer.from(t).toString('base64')}\x07y`)}\n\n`;
    res.write(osc('旧的复制'));
    if (termBusy) res.write(`event: data\ndata: ${JSON.stringify('\r\n✻ Thinking… (3s · esc to interrupt)\r\n')}\n\n`);
    if (termGem) { gemRes = res; res.write(`event: data\ndata: ${JSON.stringify(termGem)}\n\n`); }
    setTimeout(() => res.write(osc('终端里复制的中文')), 300);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    const data = url.pathname === '/api/state' ? state : url.pathname === '/api/asks' ? []
      : url.pathname === '/api/tokens' ? tokens
      : url.pathname === '/api/open' ? { key: 'fixture', pid: 123, kind: 'pty' }
      : url.pathname === '/api/machines' ? [{ id: 'here', name: 'PC', cpu: 50, cpuClaude: 20, mem: 8 * 2 ** 30, memClaude: 2 * 2 ** 30, memAll: 16 * 2 ** 30, n: 3 }]
      : url.pathname === '/api/history' ? { id: historyId, start: 0, end: 1, items: histFeed ? histFeed.splice(0) : [{ role: 'claude', text: long }], ...(histQueue && { queue: histQueue }) }
      : url.pathname === '/api/oai' ? { ...oai, title: 'Pro 你好' }
      : url.pathname === '/api/commands' ? (cmdAsks.push(url.searchParams.get('id') ?? url.searchParams.get('dir') ?? url.searchParams.get('mac')), url.searchParams.get('id') === 'M' ? { commands: [{ name: 'clear', desc: 'Start anew', hint: '[name]', also: ['reset'], builtin: true }, { name: 'maintain-formal-verification-skill', desc: 'a Mac skill', hint: '', also: [], builtin: false }] } : { commands: CMDS })
      : url.pathname.startsWith('/api/peek') ? { type: /\.exe$/.test(url.searchParams.get('path')) ? 'application/octet-stream' : /\.pptx$/.test(url.searchParams.get('path')) ? 'application/pdf' : 'image/png' }
      : url.pathname === '/api/dirs' ? dirs[url.searchParams.get('path')] ?? { err: '打不开' } : {};
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
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-machine=here] .win')].map((r) => r.textContent)"), ['CPU50%Claude 20%', '内存50%3 个 · 2.0 GB']);
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
  // (first which of them, in the middle: Claude, and GPT by the key; Gemini with no account can't be picked)
  assert.deepEqual(await evaluate("[document.querySelector('#sheet').classList.contains('mid'), ...[...document.querySelectorAll('#sheetIn [data-k]')].map((b) => `${b.dataset.k}:${b.disabled}:${b.textContent}`)]"),
    [true, 'claude:false:Claude', 'gpt:false:GPT', 'gem:true:Gemini没有账号']);
  await evaluate("document.querySelector('[data-k=\"gpt\"]').click()");
  assert.deepEqual(await evaluate("[!!document.querySelector('#dirIn'), !!document.querySelector('[data-chat]'), document.querySelector('#sheet').classList.contains('mid')]"), [false, false, false]);
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
  // a GPT 聊天 message on its way stays in the draft (a phone's page dropped meanwhile gets it back); gone once through
  let release; oaiHold = new Promise((ok) => (release = ok));
  await evaluate("window.oc = makeOai('oai-1', 'Pro 你好'); addConv(focusG, oc)");
  await until("!!document.querySelector('.pane.on.oai textarea') && document.querySelector('.pane.on.oai .go').dataset.m === 'send'");
  await evaluate("(() => { const t = document.querySelector('.pane.on.oai textarea'); t.value = '留着这句'; t.dispatchEvent(new Event('input')); document.querySelector('.pane.on.oai .go').click(); })()");
  await until("document.querySelector('.pane.on.oai textarea').value === ''");
  assert.equal(await evaluate("localStorage.getItem('cm-draft:oai-1')"), '留着这句');
  release(); oaiHold = null;
  await until("localStorage.getItem('cm-draft:oai-1') === null");
  await evaluate('closeConv(oc)'); oai = { items: [], busy: false };
  // a table's cell with math in it: the formula, not its stand-in
  assert.equal(await evaluate("(() => { const h = md('| 算法 | 复杂度 |\\n|---|---|\\n| 快排 | $O(n \\\\log n)$ |'); return [h.includes('|0|'), /<td>[^|]*katex/.test(h)].join(); })()"), 'false,true');
  // a reply's code block in its language's colors, by the fence's word (py, m: MATLAB; none or an unknown one: as it is), its
  // words as they are for 复制; one still coming in colored too. As VS Code: if/import apart, a call (print() and a bare name
  // marked (&lt; left be), in MATLAB a name( a variable
  assert.equal(await evaluate("(() => { const k = (s) => { const d = document.createElement('div'); d.innerHTML = md(s); return [...d.querySelectorAll('pre')].map((p) => p.textContent + ':' + [...new Set([...p.querySelectorAll('span')].map((x) => x.className))].join('+')).join(' / ') + (d.querySelector('b') ? ' b' : ''); }; return [k('```python\\nimport os\\n```'), k('```\\nimport os\\n```'), k('a\\n```m\\nx = 1; % c\\n```\\n**b**'), k('```js\\nlet a'), k('```constructor\\nx\\n```'), k('```py\\nif a < b: print(f(x))\\n```'), k('```m\\ny(i) = 1;\\n```')].join(' | '); })()"),
    'import os:hljs-keyword flow+hl-var | import os: | x = 1; % c:hl-var+hljs-number+hljs-comment b | let a:hljs-keyword+hl-var | x:'
    + ' | if a < b: print(f(x)):hljs-keyword flow+hl-var+hljs-built_in hl-call+hl-call | y(i) = 1;:hl-var+hljs-built_in+hljs-number');
  // an API account (本地代理, no quota to read): its ring full and saying so, 按用量计费 where an account's hours would be (not
  // 已用满), and a conversation on it not offered another account
  assert.equal(await evaluate(`(async () => {
    const keep = JSON.stringify(state.usage), u = state.usage;
    u.accounts = [{ label: 'a@x', windows: [], runway: 0.5 }, { label: '本地代理', api: true, err: null, runway: null, windows: [] }, { label: 'b@x', windows: [], runway: 3 }]; u.rec = 2; u.open = true;
    const r = ac(2), out = [r.includes('--p:100') && !r.includes(' nq'), /本地代理：API，按用量计费/.test(r), acctOpts().map((o) => o.sub).join(','), await pickAcct({ acct: 1 })];
    state.usage = JSON.parse(keep); return out.join(' | '); })()`), 'true | true | 可用 0.5h,按用量计费,可用 3h | 2');
  console.log('browser GPT draft kept while sending, math in a table ok');
  // 设置 as your avatar: your name's first character (none: the gear); the name in 设置
  state.user = '刘洋'; await evaluate('load()');
  assert.deepEqual(await evaluate("[document.querySelector('#gear .av')?.textContent, document.querySelector('#gear').title]"), ['刘', '刘洋 · 设置']);
  await evaluate("document.querySelector('#gear').click()");
  assert.equal(await evaluate("document.querySelector('#meIn').value"), '刘洋');
  await evaluate('sheetOff()'); delete state.user; await evaluate('load()');
  assert.equal(await evaluate("!!document.querySelector('#gear svg') && !document.querySelector('#gear .av')"), true);
  console.log('browser avatar ok');

  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("sideOn=false;drawSide();localStorage.setItem('cm-look','light');look()");
  await new Promise((r) => setTimeout(r, 150));
  // small to the eye (drawn 44 px, they hung off code blocks and stood tall over the conversation), a finger's size to the
  // touch: a point just past the edge still lands on the button (brought into view first: where the history is scrolled
  // to isn't what's checked, and the first message's button was sometimes above it)
  for (const [selector, past] of [['.hm.claude > .cpy', 7], ['.pane.on .seg button', 4]]) {
    const r = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return [r.height,document.elementFromPoint(r.left+r.width/2,r.top-${past})===e]})()`);
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
  assert.equal(await evaluate("document.querySelector('.bars > div:last-child').title"), '1/2 7 · $0'); // the day's own, on hovering it
  assert.deepEqual(errors, []);
  console.log('browser mobile targets, light theme, page width and 用量 on the PC\'s day ok');
  // 新对话 on the Mac mini: its own folder there (no folder here) unless one is picked; back to an account here, a folder here
  // (and a second Mac, a MacBook's account: offered beside it, its own folder there)
  assert.equal(await evaluate(`(() => { state.macs = [{ id: 'mac', label: 'Mac mini', dir: '~/Desktop/mine', host: 'mini' },
      { id: 'la-a1', label: 'Mac a1', dir: '~/work', host: 'mymac', icon: 'rainbow' }]; state.usage.projects = ['F:/proj'];
    const on = () => document.querySelector('#sheetIn [data-d].on')?.dataset.d ?? 'none', text = () => document.querySelector('#sheetIn').textContent;
    newSheet('claude'); const a = on(); document.querySelector('#sheetIn [data-a="mac"]').click(); const b = on();
    const said = text().includes('直接在 Mac mini 上的 ~/Desktop/mine 里运行');
    document.querySelector('#sheetIn [data-a="la-a1"]').click(); const la = on() + '/' + text().includes('直接在 Mac a1 上的 ~/work 里运行');
    document.querySelector('#sheetIn [data-a="1"]').click(); const c = on(); sheetOff(); state.usage.projects = [];
    return [a, b, said, la, c].join(' | '); })()`), 'F:/proj |  | true | /true | F:/proj');
  console.log('browser 新对话 Mac mini in mine, and a second Mac ok');
  // 新对话's 浏览: a window (wider than a sheet). A folder typed that isn't there: it opens on 此电脑 (the places: home,
  // 桌面, the drives), nothing to 选择 yet; a click goes into a folder (its folders, then its files dimmed, not
  // clickable); one empty said so; ↑ back up; a path typed with Enter: gone to, one not there said so; 选择: back to
  // 新对话 with it; 浏览 again opens there; 取消 and Esc: back, the folder as it was (here with / for \, the page doesn't mind)
  {
    const names = () => evaluate("[...document.querySelectorAll('.pkList .pkRow')].map((b) => (b.tagName === 'BUTTON' ? '' : '-') + b.textContent).join(' | ')");
    const pkPath = () => evaluate("document.querySelector('#pkPath').value");
    const into = (p) => evaluate(`document.querySelector('.pkList [data-in="${p}"]').click()`);
    await evaluate("{ newSheet('claude'); const i = document.querySelector('#dirIn'); i.value = 'Z:/nope'; i.dispatchEvent(new Event('input')); document.querySelector('#browse').click() }");
    await until("!!document.querySelector('.pkList')");
    assert.deepEqual([await names(), await pkPath(), await evaluate("document.querySelector('#pkOk').disabled"), await evaluate("document.querySelector('#sheet').classList.contains('wide')")],
      ['ly | 桌面 | D:', '', true, true]);
    assert.equal(await evaluate("[...document.querySelectorAll('.pkSide .pkRow')].map((b) => b.textContent).join(' | ')"), 'ly | 桌面 | D:');
    await into('D:/'); await until("document.querySelector('#pkPath').value === 'D:/'");
    assert.deepEqual([await names(), await evaluate("document.querySelector('.pkSide .pkRow.on')?.textContent")], ['work | .cache | -a.civa', 'D:']);
    await into('D:/work'); await until("document.querySelector('#pkPath').value === 'D:/work'");
    assert.equal(await evaluate("document.querySelector('.pkList').textContent.trim()"), '这里是空的');
    await evaluate("document.querySelector('[data-pkup]').click()"); await until("document.querySelector('#pkPath').value === 'D:/'");
    await evaluate("{ const p = document.querySelector('#pkPath'); p.value = 'D:/work'; p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) }");
    await until("document.querySelector('.pkList').textContent.trim() === '这里是空的'"); // its listing in (the box says D:/work at once: typed)
    await evaluate("{ const p = document.querySelector('#pkPath'); p.value = 'Z:/nope'; p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) }");
    await until("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('打不开'))");
    assert.equal(await evaluate("document.querySelector('.pkSide .pkRow.on') ? 'on' : 'none'"), 'none'); // still in D:/work
    await evaluate("document.querySelector('#pkOk').click()");
    assert.deepEqual([await evaluate("document.querySelector('#dirIn').value"), await evaluate("!!document.querySelector('.pkList')"), await evaluate("document.querySelector('#sheet').classList.contains('wide')")], ['D:/work', false, false]);
    await evaluate("document.querySelector('#browse').click()"); await until("document.querySelector('#pkPath')?.value === 'D:/work'");
    await evaluate("document.querySelector('[data-pkup]').click()"); await until("document.querySelector('#pkPath').value === 'D:/'");
    await evaluate("document.querySelector('#pkNo').click()");
    assert.equal(await evaluate("document.querySelector('#dirIn').value"), 'D:/work');
    await evaluate("document.querySelector('#browse').click()"); await until("!!document.querySelector('.pkList')");
    await evaluate("document.querySelector('[data-pkx]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    assert.deepEqual([await evaluate("document.querySelector('#sheet').classList.contains('on')"), await evaluate("document.querySelector('#dirIn')?.value")], [true, 'D:/work']);
    await evaluate('sheetOff()');
    console.log('browser 新对话 folder window ok');
  }
  // 用量: each Mac's records (listed last) under its name and its mark (Apple's; the old rainbow one for the MacBook), not as one more 账号 n
  assert.equal(await evaluate(`(() => {
    tokens = { accounts: [{ label: 'a@x', total: 1, usd: 0 }, { label: 'Mac mini', total: 1, usd: 0, mac: 'mac' }, { label: 'Mac a1', total: 1, usd: 0, mac: 'la-a1' }, { label: 'g@x', total: 1, usd: 0, gem: 1 }], days: [], total: 4, usd: 0, today: '2000-01-02' }; renderTokens();
    const h = [...document.querySelectorAll('#view .cardHead')];
    return h.map((x) => x.querySelector('b').textContent + (x.querySelector('.mk svg linearGradient stop[stop-color="#61BB46"]') ? '+rainbow' : x.querySelector('.mk svg') ? '+apple' : x.querySelector('.ac')?.textContent === 'A1' ? '+A1' : '')).join(' | '); })()`),
    '账号 1 | Mac mini+apple | Mac a1+rainbow | Gemini A1+A1');
  console.log('browser 用量 Mac mini, a MacBook and a Gemini account ok');
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
    // one looked at in 管家 mode (in no group of tabs): none; a Mac's in no folder here: in the Mac's own, said so
    const p = makeConv({ id: 'A' }, 'peeked'); paneMenu(p, p.el.querySelector('[data-act="more"]')); out.push(pick('fresh').textContent); p.close();
    state.sessions.at(-1).cwd = '/Users/me/work'; out.push(menu(m).split(',')[0] + pick('fresh').textContent); sheetOff(); $('#cmenu').hidden = true;
    for (const c of [a, n, m, mn]) closeConv(c); state.sessions.pop();
    return out.join(' | '); })()`),
    'on,on,on | true,C:/test,1,,test | on,off,off | 换账号继续…用的是 Mac a1 的账号，换不了 | la-a1,F:/proj | off,on,on'
    + ' | 新对话在管家里看的对话：回到对话列表再开 | on新对话在 Mac a1 的工作文件夹里');
  console.log('browser a conversation\'s ⋯ (新对话, 换账号, 结束) ok');
  // 项目: the grid lists yours (a conversation from any folder; one no longer listed skipped); its ＋ offers those not in it
  // and adds the one picked; a row's menu there takes one out; ⋯'s 新对话 from one in a 项目 joins it
  assert.equal(await evaluate(`(async () => {
    const out = [], wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), pick = (k) => [...document.querySelectorAll('[data-m]')].filter((b) => b.dataset.m === k).pop();
    await projPost({ op: 'new', name: '论文' }); await projPost({ op: 'add', id: 1, conv: ['A', 'gone-1'] }); await load();
    menuAt = 0; side = 'chats'; listMode = 'dirs'; renderChats(); document.querySelector('#sideActs [data-proj]').click();
    out.push([listMode, document.querySelector('#sideActs [data-proj]').classList.contains('on'), !!document.querySelector('#view [data-newp]'), $('#sideTitle').textContent,
      document.querySelector('#view [data-sec="p:1"]').classList.contains('proj'), [...document.querySelectorAll('#view [data-sec="p:1"] [data-open]')].map((r) => r.dataset.open).join()].join(','));
    state.sessions.push({ id: 'C', title: 'other folder', cwd: 'F:/other', acct: 0, at: Date.now(), pid: null });
    findSheet(projOf(1)); out.push([...document.querySelectorAll('#findList [data-open]')].map((r) => r.dataset.open).join());
    document.querySelector('#findList [data-open="C"]').click(); await wait(400); sheetOff(); out.push(projOf(1).ids.join());
    menuAt = 0; rowMenu('A', 10, 10, '1'); pick('out').click(); await wait(400); out.push(projOf(1).ids.join()); $('#cmenu').hidden = true; sheetOff();
    const c = makeConv({ id: 'C' }, 'other folder'); addConv(focusG, c); c.fresh('claude'); const n = focusG.active; out.push(n.joins.join());
    closeConv(n); closeConv(c); await projPost({ op: 'drop', id: 1 }); listMode = 'dirs'; await load(); out.push($('#sideTitle').textContent);
    return out.join(' | '); })()`), 'proj,true,true,项目,true,A | C | A,gone-1,C | gone-1,C | 1 | 对话');
  console.log('browser 项目 ok');
  // a file in a message of yours: a card opening it (its saved name found in the record's text, a Mac's path too), its
  // kind from its ending; the bubble's text as before (停止 compares it); one on its way: a card, no link yet
  assert.equal(await evaluate(`(() => { const raw = '看看这个\\n附件：/Users/me/work/.uploads/20261113T081500-a1b2c3-全文-中文-v16.pdf';
    const m = { role: 'user', text: shownText(raw), files: filesOf(raw) }, d = document.createElement('div'); d.innerHTML = userHtml(m, '');
    const a = d.querySelector('a.att'), p = document.createElement('div'); p.innerHTML = userBody('附件：x.docx', [], true);
    return [a.className, a.dataset.ext, a.getAttribute('href'), d.textContent.replace(/\\s+/g, ''), !!p.querySelector('span.att.doc'), !p.querySelector('a')].join(' | '); })()`),
    'att pdf | PDF | /api/file?n=20261113T081500-a1b2c3-%E5%85%A8%E6%96%87-%E4%B8%AD%E6%96%87-v16.pdf | 看看这个附件：全文-中文-v16.pdf | true | true');
  console.log('browser 附件 cards ok');
  // a command (a skill, a plugin's, /model): a tag at the start of your bubble, what's after it your words (more lines too);
  // the bubble's text as before (停止 compares it); a path isn't one
  assert.equal(await evaluate(`(() => { const d = document.createElement('div');
    d.innerHTML = userHtml({ role: 'user', text: '/ponytail:review 看看\\n第二行' }, '') + userHtml({ role: 'user', text: '/model opus' }, '') + userHtml({ role: 'user', text: '/Users/me 不是' }, '');
    return [...d.children].map((b) => (b.querySelector('.slashTag')?.textContent ?? '-') + ':' + b.textContent.replace(/\\s+/g, '')).join(' | '); })()`),
    '/ponytail:review:/ponytail:review看看第二行 | /model:/modelopus | -:/Users/me不是');
  console.log('browser command tags ok');
  // a picture waiting in the box: just the picture, not a message's card with its kind's square
  assert.equal(await evaluate(`(() => { const d = document.createElement('div'); d.className = 'send';
    d.innerHTML = '<div class="atts"><div class="att"><img alt=""></div></div>'; document.body.append(d);
    const b = getComputedStyle(d.querySelector('.att'), '::before').content; d.remove(); return b; })()`), 'none');
  console.log('browser box attachments without a card ok');
  // a picture uploads as its type; any other file as it is, with its name (and, for a Mac's conversation, which Mac)
  assert.equal(await evaluate(`(async () => { const real = window.fetch, got = [];
    window.fetch = async (u, o) => { got.push([o.headers['content-type'], o.headers['x-name'] ?? '', o.headers['x-mac'] ?? ''].join(' ')); return new Response('{"path":"p"}'); };
    try { await upload(new Blob(['x'], { type: 'image/png' })); await sendFile(new File(['x'], '论文 v1.pdf'), 'la-a1'); } finally { window.fetch = real; }
    return got.join(' | '); })()`), 'image/png   | application/octet-stream %E8%AE%BA%E6%96%87%20v1.pdf la-a1');
  console.log('browser uploads ok');
  // a stream that fell behind (the end of an answer never came): its screen says answering, the service has had it
  // idle 20 s: opened again once, the screen rebuilt, answering no more
  termBusy = true;
  await evaluate("window.hc = makeConv({ id: 'A' }, 'Test conversation'); addConv(focusG, hc)");
  await until("hc.live === 'busy'");
  termBusy = false; const before = opens;
  assert.equal(await evaluate(`(async () => { const real = Date.now; hc.sync();
    try { Date.now = () => real() + 21000; hc.sync(); } finally { Date.now = real; }
    for (let i = 0; i < 60 && hc.live === 'busy'; i++) await new Promise((ok) => setTimeout(ok, 100));
    return hc.live; })()`), '');
  assert.equal(opens - before, 1);
  await evaluate('closeConv(hc)');
  console.log('browser a stream behind reopened ok');
  // a history read left hanging (a phone's network): given up, the next read goes, the 对话 view isn't frozen
  histHang = true;
  assert.equal(await evaluate(`(async () => { const real = AbortSignal.timeout; AbortSignal.timeout = () => real.call(AbortSignal, 300); // its 15 s, short here
    try {
      const c = makeConv({ id: '${historyId}' }, 'hang'); addConv(focusG, c);
      for (let i = 0; i < 60 && !c.el.querySelector('.hm.claude'); i++) await new Promise((ok) => setTimeout(ok, 100));
      const shown = !!c.el.querySelector('.hm.claude'); closeConv(c); return shown;
    } finally { AbortSignal.timeout = real; } })()`), true);
  assert.equal(histHang, false); // the hanging read did come
  hung?.destroy(); hung = null; // (not left for the next test's reads)
  console.log('browser a hanging history read given up ok');
  // the screen done before the record brings the answer (a Mac's comes a second or two later): the record read every
  // ~0.3 s till it's in (the 1 s reads alone would make it wait), then back to every second
  termBusy = true; histFeed = [];
  await evaluate("window.hw = makeConv({ id: 'A' }, 'Test conversation'); addConv(focusG, hw)");
  await until("hw.live === 'busy'");
  termBusy = false; // its stream opened again (as a page back from the background), the screen done
  const reads = () => histReads.filter((t) => t > Date.now() - 1500).length;
  await evaluate("(() => { const real = Date.now; hw.sync(); try { Date.now = () => real() + 21000; hw.sync(); } finally { Date.now = real; } })()");
  await new Promise((ok) => setTimeout(ok, 1500));
  assert.ok(reads() >= 4, `record read ${reads()} times in 1.5 s while the answer was awaited`);
  histFeed.push({ role: 'claude', text: '回答到了' });
  await until("!!hw.el.querySelector('.hm.claude')?.textContent.includes('回答到了')");
  await new Promise((ok) => setTimeout(ok, 500)); // (a quick read already on its way may still come)
  const t0 = Date.now(); await new Promise((ok) => setTimeout(ok, 1500));
  const after = histReads.filter((t) => t >= t0).length;
  assert.ok(after <= 2, `record still read ${after} times in 1.5 s once the answer was in`);
  await evaluate('closeConv(hw)'); histFeed = null;
  console.log('browser an answer fetched at once once its screen is done ok');
  // 改动: the files a turn changed on a card under its answer, each once with its lines added and taken out, named from
  // the folder they share, a click opening 预览; more read on, it stays last; your next message closes it, the next turn
  // gets its own
  histFeed = [{ role: 'user', text: '改两个文件', at: 1 }, { role: 'tool', text: 'Edit  C:\\p\\src\\a.js' }, { role: 'edit', text: 'C:\\p\\src\\a.js', add: 2, del: 1 }];
  await evaluate("window.he = makeConv({ id: 'A' }, 'Test conversation'); addConv(focusG, he)");
  await until("!!he.el.querySelector('.hm.chg')");
  assert.deepEqual(await evaluate("[...he.el.querySelectorAll('.hm.chg > div')].map((e) => e.textContent)"), ['改了 1 个文件+2−1', 'a.js+2−1']);
  histFeed.push({ role: 'edit', text: 'C:\\p\\README.md', add: 3, del: 0 }, { role: 'edit', text: 'C:\\p\\src\\a.js', add: 1, del: 0 }, { role: 'claude', text: '改好了' });
  await until("he.el.querySelector('.hm.chg .ch').textContent.includes('2 个文件')");
  assert.deepEqual(await evaluate("[...he.el.querySelectorAll('.hm.chg > div')].map((e) => e.textContent)"), ['改了 2 个文件+6−1', 'src\\a.js+3−1', 'README.md+3']);
  assert.deepEqual(await evaluate("[he.el.querySelector('.hNew').lastElementChild.matches('.chg'), he.el.querySelector('.hm.chg .cf a.peek').dataset.peek, he.el.querySelectorAll('details.tools').length]"),
    [true, 'C:\\p\\src\\a.js', 1]);
  histFeed.push({ role: 'user', text: '再改一个' }, { role: 'tool', text: 'Write  C:\\p\\b.js' }, { role: 'edit', text: 'C:\\p\\b.js', add: 1, del: 0 });
  await until("he.el.querySelectorAll('.hm.chg').length === 2");
  assert.deepEqual(await evaluate(`[...he.el.querySelectorAll('.hNew > *')].map((e) => e.matches('.chg') ? 'chg:' + e.querySelector('.ch').textContent : e.matches('.hm.user') ? 'user' : '').filter(Boolean)`),
    ['user', 'chg:改了 2 个文件+6−1', 'user', 'chg:改了 1 个文件+1']);
  await evaluate('closeConv(he)'); histFeed = null;
  console.log('browser 改动 card ok');
  // 排队中: what the record says waits in Claude's queue: one sent from here marked so, one from its window shown too, in
  // the order sent; taken in, they go (the record's messages in their place)
  termBusy = true; histFeed = []; histQueue = [{ text: '电脑上排的', at: Date.now() - 5000 }];
  await evaluate("window.hq = makeConv({ id: 'A' }, 'Test conversation'); addConv(focusG, hq)");
  await until("hq.live === 'busy' && !!hq.el.querySelector('.live .hm.user.pending')");
  await evaluate("(() => { const t = hq.el.querySelector('.send textarea'); t.value = '网页上发的'; t.dispatchEvent(new Event('input')); hq.el.querySelector('.go').click(); })()");
  const live = "[...hq.el.querySelectorAll('.live .hm.user.pending')].map((e) => e.textContent)";
  await until(`${live}.length === 2`);
  assert.deepEqual(await evaluate(live), ['排队中电脑上排的', '网页上发的']); // (its own: not in the queue yet)
  histQueue = [...histQueue, { text: '网页上发的', at: Date.now() }];
  await until(`${live}.join() === '排队中电脑上排的,排队中网页上发的'`);
  histQueue = []; histFeed.push({ role: 'user', text: '电脑上排的' }, { role: 'user', text: '网页上发的' });
  await until(`${live}.length === 0`);
  assert.equal(await evaluate("hq.el.querySelectorAll('.hNew .hm.user').length"), 2);
  termBusy = false; await evaluate('closeConv(hq)'); histFeed = null; histQueue = null;
  console.log('browser 排队中 ok');
  // 对话's ticks down its left: one a message of yours, the one you're reading marked (at the end: the last); the mouse on
  // one, it and its answer's start in the card; a click scrolls there; in 终端, none
  histFeed = [1, 2, 3, 4].flatMap((i) => [{ role: 'user', text: `第${i}问` }, { role: 'claude', text: `回答${i}。` + '很长的一段话。\n\n'.repeat(40) }]);
  await evaluate("window.hn = makeConv({ id: 'A' }, 'Test conversation'); addConv(focusG, hn)");
  const navOn = "[...hn.el.querySelectorAll('.nav .navT')].findIndex((t) => t.matches('.on'))";
  await until(`hn.el.querySelectorAll('.nav .navT').length === 4 && ${navOn} === 3`);
  // the words start right of the ticks: a line's first letter under the mouse is the reply's (the ticks once took it, and
  // a selection begun there began elsewhere); only the ticks take the mouse, not the strip above and below them
  assert.deepEqual(await evaluate(`(() => { const r = [...hn.el.querySelectorAll('.hm.claude')].pop().getBoundingClientRect(), y = hn.el.querySelector('.msgs').getBoundingClientRect().bottom - 30;
    const nav = hn.el.querySelector('.nav').getBoundingClientRect(), t = hn.el.querySelector('.nav .navT').getBoundingClientRect();
    return [nav.right < r.left, !!document.elementFromPoint(r.left + 1, y)?.closest('.hm.claude'), !document.elementFromPoint(nav.left + 10, t.top - 10)?.closest('.nav')]; })()`), [true, true, true]);
  // every line on whole screen pixels, all as thick (a line on part of one is drawn fainter over two)
  assert.ok(await evaluate(`[...hn.el.querySelectorAll('.nav .navT')].every((e) => { const y = (e.getBoundingClientRect().top + parseFloat(e.style.getPropertyValue('--o'))) * devicePixelRatio;
    return Math.abs(y - Math.round(y)) < 0.02 && e.style.getPropertyValue('--t') === hn.el.querySelector('.nav .navT').style.getPropertyValue('--t'); })`));
  // the mouse on the second: it longest, those around it less and less; off the ticks, back as they were
  const widths = "[...hn.el.querySelectorAll('.nav .navT')].map((e) => e.style.getPropertyValue('--w')).join()";
  const card = await evaluate(`(() => { const t = hn.el.querySelectorAll('.nav .navT')[1]; t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return [t.title || t.dataset.tip, ${widths}, (t.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })), ${widths})]; })()`);
  assert.deepEqual(card.slice(1), ['15px,20px,15px,12px', ',,,']);
  assert.ok(card[0].startsWith('第2问\n回答2。很长的一段话。') && card[0].endsWith('…') && card[0].length < 150, card[0]);
  await evaluate("hn.el.querySelectorAll('.nav .navT')[1].click()"); // (the first: at the list's top, no scrolling it higher)
  await until(`${navOn} === 1 && (() => { const u = hn.el.querySelectorAll('.hm.user')[1].getBoundingClientRect().top - hn.el.querySelector('.msgs').getBoundingClientRect().top; return u > 4 && u < 20; })()`);
  await evaluate("hn.el.querySelector('[data-v=term]').click()");
  await until("getComputedStyle(hn.el.querySelector('.nav')).display === 'none'");
  await evaluate('closeConv(hn)'); histFeed = null;
  console.log('browser 对话 ticks ok');
  // Gemini: its kind in the list's filter and in 新对话; a Gemini conversation under its A1 ring and star, opened in its
  // terminal (no 对话 view), the service asked for it as a Gemini one on its own account; a new one, on the account
  // picked, takes its id once the list has it by its terminal's key, its account in the status bar
  const opened = async () => { for (let i = 0; i < 100 && !openBodies.length; i++) await new Promise((r) => setTimeout(r, 50)); return openBodies.shift(); };
  openBodies.length = 0;
  await evaluate("state.gemini = [{ label: 'g@example.com', on: true }]; state.sessions.push({ id: 'GEM1', gem: true, title: 'Gemini 对话', acct: 0, cwd: 'C:/test', at: Date.now(), pid: null }); listKind = 'all'; renderChats()");
  assert.deepEqual(await evaluate(`(() => { const r = document.querySelector('#view [data-open="GEM1"]');
    return [r.querySelector('.ac').textContent, r.querySelector('.mk').dataset.tip ?? r.querySelector('.mk').title, [...document.querySelectorAll('.kinds button')].map((b) => (b.querySelector('svg') ? 'mark:' : '') + (b.getAttribute('aria-label') ?? b.textContent)).join()]; })()`), ['A1', 'Gemini', '全部,mark:Claude,mark:Gemini']);
  await evaluate("document.querySelector('[data-kind=\"gem\"]').click()");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#view [data-open]')].map((r) => r.dataset.open)"), ['GEM1']);
  await evaluate("document.querySelector('[data-kind=\"all\"]').click()");
  historyId = 'GEM1'; histFeed = [{ role: 'user', text: 'hi\n附件：C:\\Users\\me\\.claude-multi\\uploads\\20261121T010203-abcdef-猫.png', at: 1 }, { role: 'claude', text: 'Hi! How can I help you today?' }];
  termGem = '\r\n> 你是什么模型\r\n⣟  Generating...\r\n────────\r\n';
  await evaluate("document.querySelector('#view [data-open=\"GEM1\"]').click()"); // (one not running: started, as a Claude one)
  const rb = await opened();
  assert.deepEqual([rb.id, rb.acct, rb.gem], ['GEM1', 1, true]);
  // 对话 first, as a Claude one's, its record asked for as a Gemini one's, its replies headed Gemini
  await until("focusG.active.el.querySelector('.who')");
  assert.deepEqual(await evaluate("[focusG.active.id, !!focusG.active.el.querySelector('.seg'), focusG.active.el.querySelector('.seg .on').dataset.v, focusG.active.el.querySelector('.who').textContent]"), ['GEM1', true, 'hist', 'Gemini']);
  assert.ok(histUrls.some((u) => /[?&]gem=1/.test(u) && /id=GEM1/.test(u)), histUrls.join(' '));
  // a picture it was sent (as a file: 附件：its path): itself in the bubble, small, its name under it
  assert.deepEqual(await evaluate("(() => { const a = focusG.active.el.querySelector('.hm.user a.att.pic'); return a && [a.querySelector('img').getAttribute('src'), a.textContent]; })()"),
    [`/api/file?n=${encodeURIComponent('20261121T010203-abcdef-猫.png')}`, '附件：猫.png']);
  // agy at work on its screen: 正在回复 at once (the list's word comes seconds later), its tab turning too
  await until("focusG.active.live === 'busy'");
  assert.match(await evaluate("focusG.active.el.querySelector('.live .busy')?.textContent"), /^Gemini 正在回复 · \d+s$/); // how long: since the page saw it start (agy's screen says none)
  // what waits in its queue (as agy 1.5 shows it): 排队中; its thought summary (▸ too) isn't one
  const gemShow = (rows) => gemRes.write(`event: data\ndata: ${JSON.stringify('\x1b[2J\x1b[H' + rows.join('\r\n'))}\n\n`), R = '─'.repeat(60);
  gemShow([R, '> 你是什么模型', '▸ Thought for 5s, 203 tokens', '⣟  Generating...', '▸ 再写一首，关于冬天 (alt+m to send immediately)', R, '>', R]);
  await until("[...focusG.active.el.querySelectorAll('.live .hm.user.pending')].some((e) => /排队中/.test(e.textContent) && /再写一首，关于冬天/.test(e.textContent))");
  assert.equal(await evaluate("focusG.active.el.querySelectorAll('.live .hm.user.pending').length"), 1);
  // a question (Run this command?, as agy 1.5 asks it): in 对话 with its options; one picked: the arrow keys to it, Enter
  gemShow([R, '> 删掉 junk.txt', '● Ran (Remove-Item .\\junk.txt) (ctrl+o to expand)', 'Command', R, 'Requesting permission for:', '   Remove-Item .\\junk.txt', 'Run this command?',
    '> 1. Yes, run command', "  2. Yes, and always allow in this conversation for commands that start with 'Remove-Item'", '  3. Yes, and always allow (Persist to settings.json)', '  4. No, cancel',
    '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', 'Gemini 账号 A1']);
  await until("focusG.active.el.querySelector('.live .ask [data-pick]')");
  assert.deepEqual(await evaluate("[focusG.active.live, focusG.active.el.querySelectorAll('.live .ask [data-pick]').length, /Run this command\\?/.test(focusG.active.el.querySelector('.live .ask').textContent)]"), ['ask', 4, true]);
  inputs.length = 0;
  await evaluate("focusG.active.el.querySelector('.live .ask [data-pick=\"4\"]').click()");
  for (let i = 0; i < 60 && inputs.length < 4; i++) await new Promise((r) => setTimeout(r, 50)); // (the keys on their way)
  assert.deepEqual(inputs, ['\x1b[B', '\x1b[B', '\x1b[B', '\r']);
  // its own question (as agy 1.5 asks it): 「Write-in...」 picked, opened with Enter; its box open, 对话 says to write the
  // answer below (no 正在回复), and what's sent is the answer: pasted, then Enter
  gemShow([R, '? 你最喜欢哪种颜色？', 'Question', R, 'Question 1/1: 你最喜欢哪种颜色？', '> 1. 红', '  2. 绿', '  3. 蓝', '  4. Write-in...', '  ↑/↓ Navigate · enter Select · esc Skip', 'Gemini 账号 A1']);
  await until("focusG.active.el.querySelectorAll('.live .ask [data-pick]').length === 4");
  inputs.length = 0;
  await evaluate("focusG.active.el.querySelector('.live .ask [data-pick=\"4\"]').click()");
  for (let i = 0; i < 60 && inputs.length < 4; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(inputs, ['\x1b[B', '\x1b[B', '\x1b[B', '\r']);
  gemShow([R, 'Question 1/1: 你最喜欢哪种颜色？', '  1. 红', '  2. 绿', '  3. 蓝', '> 4. Write-in...', '  Your answer:', '  enter Submit · esc Back', 'Gemini 账号 A1']);
  await until("/写你的回答/.test(focusG.active.el.querySelector('.live')?.textContent ?? '')");
  assert.deepEqual(await evaluate("[focusG.active.live, !!focusG.active.el.querySelector('.live .busy')]"), ['', false]);
  inputs.length = 0;
  await evaluate("{ const c = focusG.active, t = c.el.querySelector('.send textarea'); t.value = '紫色'; t.dispatchEvent(new Event('input')); c.el.querySelector('.go').click(); }");
  for (let i = 0; i < 60 && inputs.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(inputs.slice(0, 2), ['\x1b[200~紫色\x1b[201~', '\r']);
  assert.equal(await evaluate("!!focusG.active.el.querySelector('.live .hm.user.pending')"), false); // an answer, not a message waiting for the record
  // 换账号继续 on another Gemini account (its quota on the card): the service asked to end it here and go on there
  openBodies.length = 0;
  await evaluate("state.gemini = [{ label: 'g1@example.com', on: true }, { label: 'g2@example.com', on: false, windows: [{ k: 'five_hour', pct: 30, reset: '1小时' }] }]; focusG.active.acct = 1; focusG.active.swap()");
  await until("document.querySelector('#sheetIn [data-a=\"2\"]')");
  assert.match(await evaluate("document.querySelector('#sheetIn [data-a=\"2\"]').textContent"), /A2 · g2@example\.com\s*额度用了 30%/);
  await evaluate("document.querySelector('#sheetIn [data-a=\"2\"]').click(); document.querySelector('#swapGo').click()");
  const sw = await opened();
  assert.deepEqual([sw?.id, sw?.gem, sw?.swap, sw?.acct], ['GEM1', true, true, 2]);
  await until("/已换到 Gemini 账号 A2/.test(document.querySelector('#toast').textContent)");
  await evaluate("Object.assign(state.sessions.find((x) => x.id === 'GEM1'), { acct: 1, pid: 123 }); focusG.active.sync()"); // the list: running here, on A2 now (the one on)
  await until('focusG.active.acct === 2');
  await evaluate("state.gemini = [{ label: 'g@example.com', on: true }]; Object.assign(state.sessions.find((x) => x.id === 'GEM1'), { acct: 0, pid: null })");
  historyId = 'A'; histFeed = null; termGem = ''; gemRes = null;
  await evaluate('closeConv(focusG.active)');
  assert.ok(openBodies.every((b) => b.live && b.gem), JSON.stringify(openBodies)); // any more: reconnects to it, never a second agy
  openBodies.length = 0;
  // a folder's ＋ asks which first too (GPT there: a Codex account only, the key isn't one); Gemini picked: started at
  // once in that folder, on the account on
  await evaluate("menuAt = 0; listMode = 'dirs'; renderChats(); document.querySelector('#view [data-newin=\"C:/test\"]').click()");
  assert.deepEqual(await evaluate("[document.querySelector('#sheetIn .stitle').textContent, ...[...document.querySelectorAll('#sheetIn [data-k]')].map((b) => `${b.dataset.k}:${b.disabled}`)]"),
    ['在「test」开新对话', 'claude:false', 'gpt:true', 'gem:false']);
  await evaluate("document.querySelector('#sheetIn [data-k=\"gem\"]').click()");
  const fb = await opened();
  assert.deepEqual([fb.dir, fb.acct, fb.gem, await evaluate("document.querySelector('#sheet').classList.contains('on')")], ['C:/test', 1, true, false]);
  await evaluate('closeConv(focusG.active)');
  openBodies.length = 0;
  await evaluate("document.querySelector('[data-new]').click()");
  await evaluate("document.querySelector('[data-k=\"gem\"]').click()");
  assert.equal(await evaluate("[...document.querySelectorAll('#sheetIn [data-a]')].map((b) => b.textContent).join()"), 'A1 · g@example.com');
  await evaluate("{ const i = document.querySelector('#dirIn'); i.value = 'C:/test'; i.dispatchEvent(new Event('input')); document.querySelector('#start').click(); }");
  const nb = await opened();
  assert.deepEqual([nb.dir, nb.acct, nb.gem, nb.id], ['C:/test', 1, true, undefined]);
  await until("focusG.active?.where() === 'pty'");
  await evaluate("state.sessions.push({ id: 'GEM2', gem: true, key: 'fixture', title: '新的', acct: 0, cwd: 'C:/test', at: Date.now(), pid: 123, where: 'web' }); focusG.active.sync(); drawHere()");
  assert.deepEqual(await evaluate("[focusG.active.id, document.querySelector('#here').textContent.includes('Gemini 账号 A1')]"), ['GEM2', true]);
  await evaluate("closeConv(focusG.active); state.sessions = state.sessions.filter((x) => !x.gem); state.gemini = []; renderChats()");
  console.log('browser Gemini ok');
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
  // / in a conversation's box: its commands, asked for once; those beginning with what's typed first, then those with it
  // inside; ↓ and Tab take one (its name and a space); Enter takes the one chosen, not sent; Esc leaves the list; a GPT
  // one's box: none
  assert.equal(await evaluate(`(async () => {
    const c = makeConv({ id: 'A' }, 'Test conversation'); addConv(focusG, c);
    const box = c.el.querySelector('.send textarea'), list = c.el.querySelector('.slash'), wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const type = async (v) => { box.value = v; box.dispatchEvent(new Event('input')); await wait(200); };
    const key = (k) => box.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const names = () => list.hidden ? 'hidden' : [...list.querySelectorAll('b')].map((b) => b.textContent).join(' ');
    const out = [];
    box.focus(); await type('/us'); out.push(names());
    key('ArrowDown'); key('Tab'); out.push(JSON.stringify(box.value), names());
    await type('/cle'); key('Enter'); out.push(JSON.stringify(box.value));
    await type('/s'); key('Escape'); out.push(names());
    box.blur(); await type('/pon'); out.push(names()); // a draft put back, the box not typed in: no list
    closeConv(c);
    return out.join(' | '); })()`), '/usage /usage-credits /status | "/usage-credits " | hidden | "/clear " | hidden | hidden');
  // a Mac's: what Claude Code lists on that Mac, its skills too (a command found by another name: /reset is /clear), a line
  // while it's read there (the first time a few seconds); a GPT one's: a line saying why, not asked for
  historyId = 'M';
  assert.equal(await evaluate(`(async () => {
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), out = [];
    const m = makeConv({ id: 'M', mac: 'la-a1' }, 'Mac'); addConv(focusG, m); await wait(300);
    const mb = m.el.querySelector('.send textarea'); mb.focus(); mb.value = '/re'; mb.dispatchEvent(new Event('input')); out.push(m.el.querySelector('.slash').textContent); await wait(200);
    out.push(m.el.querySelector('.slash').textContent); mb.value = '/ma'; mb.dispatchEvent(new Event('input')); out.push(m.el.querySelector('.slash').textContent); closeConv(m);
    const g = makeConv({ id: 'G', gpt: true }, 'GPT'); addConv(focusG, g);
    const gb = g.el.querySelector('.send textarea'); gb.focus(); gb.value = '/'; gb.dispatchEvent(new Event('input')); await wait(200);
    out.push(g.el.querySelector('.slash').hidden ? 'hidden' : g.el.querySelector('.slash').textContent); closeConv(g);
    return out.join(' | '); })()`), '正在从 Mac 读命令和技能…（第一次要几秒） | /clear[name]Start anew | /maintain-formal-verification-skilla Mac skill | GPT（Codex）对话的命令这里列不出，可以直接打完整的命令');
  historyId = 'A';
  // A asked once (its list kept), the Mac's asked, the GPT one's not. (Not M's count: a tab left open by the tests before
  // takes M's record too, as the stand-in service gives every record that id, and may ask for itself)
  assert.ok(cmdAsks.filter((x) => x === 'A').length === 1 && cmdAsks.includes('M') && !cmdAsks.includes('G'), JSON.stringify(cmdAsks));
  console.log('browser / commands ok');
  // 预览: a path of this PC in a reply's code is a link (its name; other code isn't); it opens in a pane beside the
  // conversation, a tab each: a folder lists its folders and files, a file of it opens in a tab of its own (an Office one
  // says it's being made a PDF), the tabs before kept as they were; ← one up in the tab; one not there or a service before
  // 预览 say so, one the browser can't show offers its download; × closes a tab, the last one the pane; Esc leaves it
  assert.equal(await evaluate(`(async () => {
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), d = document.createElement('div'); d.className = 'hm claude';
    d.innerHTML = md('看 \\\`D:\\\\figs\\\` 和 \\\`npm i\\\`'); document.body.append(d);
    const out = [d.querySelectorAll('a.peek').length, d.querySelector('a.peek').textContent, d.querySelector('code').textContent];
    d.querySelector('a.peek').click(); await wait(300);
    const pv = document.querySelector('#peek'), on = () => pv.querySelector('.pvBody:not([hidden])');
    const rows = () => [...on().querySelectorAll('.pvRow span')].map((s) => s.textContent).join(','), tabs = () => [...pv.querySelectorAll('.pvTab span')].map((s) => s.textContent).join(',');
    const open = async (n) => { [...on().querySelectorAll('.pvRow')].find((r) => r.textContent === n).click(); await wait(300); };
    out.push(!pv.hidden && !document.querySelector('#pvSash').hidden, tabs(), rows());
    await open('图7.pptx'); out.push(tabs(), on().querySelector('.pvWait')?.textContent ?? 'loaded', decodeURIComponent(on().querySelector('iframe').getAttribute('src')));
    const deck = on(); pv.querySelector('[data-pvt="0"]').click(); await wait(100); out.push(rows(), deck.isConnected && !!deck.querySelector('iframe'));
    pv.querySelector('[data-pvt="1"]').click(); pv.querySelector('[data-pv=up]').click(); await wait(300); out.push(tabs(), rows());
    pv.querySelector('[data-pvt="0"]').click(); await open('x.exe'); out.push(!!on().querySelector('.pvWait a[download]'));
    preview('D:\\\\figs\\\\a.png'); await wait(300); out.push(on().querySelector('.pvMedia')?.tagName); // a picture in the pane itself, fitted to it
    preview('D:\\\\figs\\\\missing.png'); await wait(300); out.push(on().querySelector('.pvWait').textContent);
    preview('D:\\\\figs\\\\oldsvc.png'); await wait(300); out.push(on().querySelector('.pvWait').textContent);
    pv.querySelector('.pvTab.on .x').click(); out.push(tabs());
    // Esc: a phone's pane (it covers the page) closes, a computer's stays (there Esc stops Claude); ✕ closes them all
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); out.push(pv.hidden === NARROW.matches);
    if (!pv.hidden) pv.querySelector('[data-pv=close]').click(); out.push(pv.hidden, document.querySelector('#pvSash').hidden, tabs() || 'none');
    d.remove(); return out.join(' | '); })()`),
    '1 | figs | npm i | true | figs | old,图7.pptx,a.png,x.exe | figs,图7.pptx | 正在用 PowerPoint 转成 PDF…（第一次要几秒） | /api/peek/图7.pptx?path=D:\\figs\\图7.pptx'
    + ' | old,图7.pptx,a.png,x.exe | true | figs,figs | old,图7.pptx,a.png,x.exe | true | IMG | 没有这个文件：D:\\figs\\missing.png | 预览要等网页服务重启后才能用'
    + ' | figs,figs,x.exe,a.png,missing.png | true | true | true | none');
  console.log('browser 预览 ok');
  // 提示: the page's own card, never the browser's: over a hinted thing inside another, neither keeps its title while the
  // mouse is there (the browser would show the outer one), the card says the inner's; a click takes the card away and
  // the titles stay aside till the mouse leaves; drawn anew under the mouse while the card waits, it comes all the same
  assert.equal(await evaluate(`(async () => {
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), d = document.createElement('div');
    d.title = '外面'; d.innerHTML = '<span title="里面">x</span>'; d.style.cssText = 'position:fixed;left:300px;top:300px;padding:20px'; document.body.append(d);
    const tip = document.querySelector('#tip'), ev = (t, el, rel) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, relatedTarget: rel ?? null, clientX: 320, clientY: 320 }));
    const titled = () => [d, d.firstChild].filter((e) => e.hasAttribute('title')).length, card = () => tip.classList.contains('show') && tip.textContent, out = [];
    ev('mouseover', d.firstChild); await wait(600); out.push(card(), titled());
    ev('mousedown', d.firstChild); out.push(card(), titled());
    ev('mouseout', d.firstChild, document.body); out.push(titled());
    ev('mouseover', d.firstChild); await wait(200); d.innerHTML = '<span title="里面">x</span>'; ev('mouseover', d.firstChild); await wait(400); out.push(card());
    ev('mouseout', d.firstChild, document.body); out.push(titled()); d.remove();
    return out.join(' | '); })()`), '里面 | 0 | false | 0 | 2 | 里面 | 2');
  console.log('browser hints ok');

  // --- a computer's window again (the phone's above), and a real mouse: a button hidden by its style takes no click
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 200));
  const click = async ([x, y]) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 }); };
  const at = (sel) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const pvTabs = () => evaluate("[...document.querySelectorAll('#peek .pvTab span')].map((s) => s.textContent).join(',') + (document.querySelector('#peek').classList.contains('min') ? ' min' : '')");
  // 预览's tabs: each its own × to a mouse (the shown one's, another's on hover), a middle click too; 收起: a strip of their
  // marks (the sash gone), a mark's × on hover closing it there, a mark clicked or a path opened bringing the pane back
  await evaluate("preview('D:\\\\figs'); preview('D:\\\\figs\\\\a.png')"); await new Promise((r) => setTimeout(r, 300));
  await click(await at('#peek .pvTab.on .x')); assert.equal(await pvTabs(), 'figs');
  await evaluate("preview('D:\\\\figs\\\\a.png')"); await click(await at('#peek [data-pvt="0"] .x')); assert.equal(await pvTabs(), 'a.png');
  await evaluate("preview('D:\\\\figs')"); await click(await at('#peek [data-pv=min]'));
  assert.equal(await evaluate("[document.querySelector('#peek').offsetWidth < 60, document.querySelector('#pvSash').hidden].join()"), 'true,true');
  assert.equal(await pvTabs(), 'a.png,figs min');
  await click(await at('#peek [data-pvt="0"] .x')); assert.equal(await pvTabs(), 'figs min');
  await click(await at('#peek [data-pvt="0"]')); assert.equal(await pvTabs(), 'figs');
  await click(await at('#peek [data-pv=min]')); await evaluate("preview('D:\\\\figs\\\\a.png')"); assert.equal(await pvTabs(), 'figs,a.png');
  await evaluate("document.querySelector('#peek [data-pvt=\"0\"]').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))"); assert.equal(await pvTabs(), 'a.png');
  await click(await at('#peek [data-pv=close]')); assert.equal(await evaluate("document.querySelector('#peek').hidden"), true);
  console.log('browser 预览 tabs closed one by one, 收起 ok');
  // 收起这一栏: a column a strip of its tabs' marks, its conversation asleep (not among those looked at: the mock's record names any one A, so by which), the focus on the
  // other; kept over a reload; its mark clicked opens it at that one (its terminal sized again); the last open column
  // closed, the strip opens
  assert.equal(await evaluate(`(async () => {
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), out = [];
    for (const c of allConvs()) closeConv(c);
    const a = makeConv({ id: 'A' }, 'A'); addConv(focusG, a); const g1 = focusG; split(g1); const g2 = focusG, b = makeConv({ id: 'B' }, 'B'); addConv(g2, b); await wait(100);
    const btn = (g) => g.el.querySelector('.fold'), real = window.fetch; let rs = 0;
    window.fetch = (u, o) => { if (String(u).includes('/api/resize')) rs++; return real(u, o); };
    a.el.querySelector('[data-v=term]').click(); await wait(500);
    out.push(groups.length, btn(g1).hidden, btn(g2).hidden);
    rs = 0; btn(g1).click(); await wait(400);
    out.push(g1.min, g1.el.offsetWidth < 60, a.el.classList.contains('on'), shownConvs().map((c) => (c === a ? 'a' : c === b ? 'b' : '?')).join(), focusG === g2, btn(g2).hidden, btn(g1).title,
      JSON.parse(localStorage.getItem('cm-layout')).groups.map((x) => !!x.min).join());
    // its terminal not sized from here meanwhile; the strip: a spinner while it answers (by the list: it's asleep), a dot
    // when it answered or asks, left unread (the mouse in the strip reads nothing)
    const sA = state.sessions.find((x) => x.id === a.id); sA.busy = true; drawTabs(g1); out.push(rs, !!g1.strip.querySelector('.spin')); sA.busy = false;
    state.notes = [{ id: a.id, kind: 'ask', at: 1, by: 'you' }]; drawTabs(g1); const x = g1.strip.querySelector('.x');
    out.push(x.className, getComputedStyle(x).visibility, getComputedStyle(x, '::after').display); readShown(g1); out.push(state.notes.length); state.notes = []; drawTabs(g1);
    g1.strip.querySelector('[data-i="0"]').click(); await wait(400);
    out.push(g1.min, a.el.classList.contains('on'), shownConvs().map((c) => (c === a ? 'a' : c === b ? 'b' : '?')).join(), focusG === g1, rs > 0);
    a.el.querySelector('[data-v=hist]').click(); window.fetch = real;
    btn(g1).click(); closeConv(b); await wait(100);
    out.push(groups.length, g1.min, a.el.classList.contains('on'));
    closeConv(a); return out.join(' | '); })()`),
    '2 | false | false | true | true | false | b | true | true | 展开这一栏 | true,false | 0 | true | x ask | visible | block | 1 | false | true | a,b | true | true | 1 | false | true');
  console.log('browser 收起这一栏 ok');
  // a conversation's folder: a button (no account, nor where it runs); the mouse on it, what's in it (a folder gone into,
  // ← back; a file opened in 预览), gone when the mouse leaves; clicked, the folder in 预览. A Mac's own folder: its name
  const move = async ([x, y]) => { await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }); };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const popRows = "(() => { const p = document.querySelector('.dirPop'); return p.hidden ? 'hidden' : [...p.querySelectorAll('.pvRow span')].map((s) => s.textContent).join(','); })()";
  const rowAt = (n) => evaluate(`(() => { const r = [...document.querySelectorAll('.dirPop .pvRow')].find((x) => x.textContent === ${JSON.stringify(n)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  assert.equal(await evaluate("(async () => { window.fa = makeConv({ id: 'A' }, 'A'); addConv(focusG, fa); await new Promise((ok) => setTimeout(ok, 200)); return fa.el.querySelector('.path').textContent; })()"), 'test');
  await move(await at('.pane.on button.dirBtn')); await pause(450);
  assert.equal(await evaluate(popRows), 'sub,a.png,b.md'); assert.equal(await evaluate("document.querySelector('.dpHead').textContent"), 'C:/test');
  await click(await rowAt('sub')); await pause(150); assert.equal(await evaluate(popRows), 'c.txt');
  await click(await at('.dirPop [data-dpup]')); await pause(150); assert.equal(await evaluate(popRows), 'sub,a.png,b.md');
  await click(await rowAt('a.png')); await pause(150); assert.equal(await evaluate(popRows), 'hidden'); assert.equal(await pvTabs(), 'a.png');
  await move(await at('.pane.on button.dirBtn')); await pause(450); assert.equal(await evaluate(popRows), 'sub,a.png,b.md');
  await move(await at('.pane.on .msgs')); await pause(450); assert.equal(await evaluate(popRows), 'hidden');
  await click(await at('.pane.on button.dirBtn')); await pause(300); assert.equal(await evaluate(popRows), 'hidden'); assert.equal(await pvTabs(), 'a.png,test');
  assert.equal(await evaluate(`(() => { document.querySelector('#peek [data-pv=close]').click(); closeConv(fa);
    const m = makeConv({ dir: '/Users/me/x', acct: 1 }, 'm'); m.sync(); const s = m.el.querySelector('.dirBtn'), r = [s.tagName, s.title, s.textContent].join(' | '); m.close(); return r; })()`), 'SPAN | /Users/me/x | x');
  console.log('browser folder button ok');
  // 右键 a path (a computer's): Codex's menu; 在电脑上打开 asks the service and says its words (one before it: restart it),
  // 下载 the file itself, the path and a text file's words copied; a folder's menu (a link's, 预览's tab) its own
  assert.equal(await evaluate(`(async () => {
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), out = [], real = window.fetch, shell = [], d = document.createElement('div'); d.className = 'hm claude';
    window.fetch = async (u, o) => { u = String(u);
      if (u === '/api/shell') { shell.push(JSON.parse(o.body).how); return shell.length === 1 ? new Response('{"said":"run.bat 是程序或脚本"}') : new Response('{"err":"没有这个地址"}', { status: 404 }); }
      if (u.includes('x.md') && u.includes('warm=1')) return new Response('{"type":"text/plain; charset=utf-8"}');
      if (u.includes('x.md')) return new Response('第一行\\n第二行');
      return real(u, o); };
    d.innerHTML = peekLink('D:\\\\a\\\\x.md') + peekLink('D:\\\\a'); document.body.append(d);
    const [f, fo] = d.querySelectorAll('a.peek'), menu = document.querySelector('#cmenu'), toastNow = () => document.querySelector('#toast').textContent;
    const ctx = (el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    const items = () => [...menu.querySelectorAll('button')].map((b) => b.dataset.m).join(), pick = async (k) => { menu.querySelector('[data-m=' + k + ']').click(); await wait(80); };
    out.push(+getComputedStyle(menu).zIndex > +getComputedStyle(document.querySelector('.dirPop')).zIndex); // (opened on the folder button's rows: over them)
    out.push(ctx(f), menu.hidden, items(), !!menu.querySelector('.msep'), !!menu.querySelector('[data-m=open] small'));
    await pick('open'); out.push(toastNow());
    ctx(f); await pick('reveal'); out.push(shell.join(), toastNow());
    ctx(f); await pick('copy'); out.push(window.copied);
    ctx(f); await pick('text'); out.push(window.copied);
    const ac = HTMLAnchorElement.prototype.click; let dl = null; HTMLAnchorElement.prototype.click = function () { dl = [decodeURIComponent(this.getAttribute('href')), this.download]; };
    ctx(f); await pick('dl'); HTMLAnchorElement.prototype.click = ac; out.push(...dl);
    ctx(fo); out.push(items()); menu.hidden = true;
    window.fetch = real; preview('D:\\\\figs'); await wait(300); ctx(document.querySelector('#peek [data-pvt="0"]')); out.push(items()); menu.hidden = true;
    document.querySelector('#peek [data-pv=close]').click(); d.remove(); return out.join(' | '); })()`),
    'true | false | false | pv,open,with,reveal,dl,copy,text | true | false | run.bat 是程序或脚本 | open,reveal | 这一项要等网页服务重启后才能用 | D:\\a\\x.md | 第一行\n第二行'
    + ' | /api/peek/x.md?path=D:\\a\\x.md&raw=1 | x.md | pv,open,copy | pv,open,copy');
  console.log('browser 右键 a path ok');
  // a text file in 预览: numbered lines in its language's colors (a string over two lines colored on both), not wrapped
  // till 换行; MATLAB's .m, in GBK too (右键's 复制文件内容 as well), PowerShell's UTF-16; a Markdown one as a reply shows
  // it, 源码 as written; 复制 the whole file
  assert.equal(await evaluate(`(async () => {
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), out = [], real = window.fetch, enc = (s) => new TextEncoder().encode(s);
    const files = { 'a.py': enc('import os\\n# 注释\\ns = """多\\n行"""\\n'), 'g.m': new Uint8Array([37, 32, 0xd6, 0xd0, 0xce, 0xc4, 10, 120, 32, 61, 32, 49, 59]), 'r.md': enc('# 标题\\n\\n正文\\n'), 'u.ps1': new Uint8Array([0xff, 0xfe, ...[...'Get-Date'].flatMap((c) => [c.charCodeAt(0), 0])]) };
    window.fetch = async (u, o) => { u = String(u); const f = /\\/api\\/peek\\/([^?]+)/.exec(u)?.[1];
      if (!files[f]) return real(u, o);
      return u.includes('warm=1') ? new Response('{"type":"text/plain; charset=utf-8"}') : new Response(files[f]); };
    const body = () => document.querySelector('#peek .pvBody:not([hidden])'), btn = (k) => document.querySelector('#peek [data-pv=' + k + ']');
    const shown = () => ['copy', 'src', 'wrap'].filter((k) => !btn(k).hidden).join('+'), code = () => body().querySelector('.pvCode');
    preview('C:\\\\code\\\\a.py'); await wait(300);
    const ls = body().querySelectorAll('.pvCode .l');
    out.push(ls.length, !!ls[0].querySelector('.hljs-keyword'), ls[1].querySelector('.hljs-comment')?.textContent, ls[2].querySelector('.hljs-string')?.textContent,
      ls[3].querySelector('.hljs-string')?.textContent, code().classList.contains('wrap'), getComputedStyle(ls[0]).whiteSpace, shown());
    btn('wrap').click(); out.push(code().classList.contains('wrap'), btn('wrap').classList.contains('on'), getComputedStyle(ls[0]).whiteSpace);
    btn('copy').click(); await wait(50); out.push(window.copied === new TextDecoder().decode(files['a.py']));
    preview('C:\\\\code\\\\g.m'); await wait(300); out.push(body().querySelector('.hljs-comment')?.textContent, body().querySelectorAll('.l').length);
    await fileAct('text', { p: 'C:\\\\code\\\\g.m' }); out.push(JSON.stringify(window.copied));
    preview('C:\\\\code\\\\u.ps1'); await wait(300); out.push(body().textContent);
    preview('C:\\\\code\\\\r.md'); await wait(300); out.push(body().querySelector('.pvMd b.h')?.textContent, shown());
    btn('src').click(); out.push(body().querySelectorAll('.pvCode .l').length, btn('src').classList.contains('on'), shown());
    window.fetch = real; btn('close').click(); return out.join(' | '); })()`),
    '4 | true | # 注释 | """多 | 行""" | false | pre | copy+wrap | true | true | pre-wrap | true | % 中文 | 2 | "% 中文\\nx = 1;" | Get-Date | 标题 | copy+src | 3 | true | copy+src+wrap');
  console.log('browser 预览 code ok');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (socket?.readyState === WebSocket.OPEN) { await call('Browser.close').catch(() => {}); socket.close(); }
  if (proc && proc.exitCode === null) { proc.kill(); await new Promise((resolve) => { proc.once('exit', resolve); setTimeout(resolve, 3000); }); }
  for (const p of pending.values()) p.reject(Error('Browser closed')); pending.clear();
  server.closeAllConnections(); server.close();
  const cleanup = path.resolve(profile);
  if (path.dirname(cleanup) !== path.resolve(os.tmpdir()) || !path.basename(cleanup).startsWith('cm-browser-test-')) throw Error('Unexpected test profile path');
  fs.rmSync(cleanup, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
