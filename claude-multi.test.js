// node claude-multi.test.js: the account pick on the cases it was designed around.
// In a home of its own (claude-multi's ROOT is read from it as the module loads): nothing here reads or writes your
// .claude-multi (its registry, its switch requests), whatever runs on it meanwhile
const TEST_HOME = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'cm-test-home-'));
process.env.USERPROFILE = process.env.HOME = TEST_HOME;
delete process.env.CLAUDE_CODE_PLUGIN_DIRS; // the Claude running these tests has the real plugin in it
require('fs').mkdirSync(require('path').join(TEST_HOME, '.claude-multi'));
require('fs').writeFileSync(require('path').join(TEST_HOME, '.claude-multi', 'profiles.json'),
  JSON.stringify({ active: null, profiles: [{ id: 'acct-test-001', label: 'me@example.com', configDir: require('path').join(TEST_HOME, 'acct') }] }));
process.on('exit', () => require('fs').rmSync(TEST_HOME, { recursive: true, force: true }));
const assert = require('assert');
const { pickOpen } = require('./claude-multi');
const at = (h) => (h == null ? null : new Date(Date.now() + h * 3.6e6).toISOString());
// acct(i, 5h used %, 5h resets in h, weekly used %, weekly resets in h)
const acct = (i, u5, h5, u7 = 30, h7 = 72) => ({ i, u: {
  five_hour: { utilization: u5, resets_at: at(h5) }, seven_day: { utilization: u7, resets_at: at(h7) } } });
const pick = (...a) => pickOpen(a).i;

assert.equal(pick(acct(0, 90, 1 / 6), acct(1, 30, 2)), 0);   // 10% left, fresh in 10 min (2.2h) beats 70% left for 2h (1.4h)
assert.equal(pick(acct(0, 90, 1 / 6), acct(1, 70, 2)), 0);   // ... and beats 30% left (0.6h)
assert.equal(pick(acct(0, 90, 1), acct(1, 30, 4)), 1);       // 10% left for 1h (0.2h) loses to 70% left for 4h (1.4h)
assert.equal(pick(acct(0, 0, null, 75, 120), acct(1, 0, null, 30, 24)), 1); // both fresh: spend the weekly that expires first
assert.equal(pick(acct(0, 0, null, 30, 120), acct(1, 75, 3, 30, 24)), 0);   // ... unless it only gives 0.5h of work
assert.equal(pick(acct(0, 0, null, 30, 120), acct(1, 0, null, 98, 24)), 0); // ... or its weekly is nearly gone (0.4h)
assert.equal(pick(acct(0, 95, 3), acct(1, 90, 3)), 1);        // nobody reaches MIN_RUN: longest runway
assert.equal(pick(acct(0, 75, 3.1), acct(1, 75, 1.1)), 1);    // same 0.5h runway: the one blocked for less time
console.log('ok');

// A Claude started from inside another one (island, hook) must not inherit its session markers: it would
// stop saving its transcript. Settings-style variables pass through.
const { childEnv } = require('./claude-multi');
process.env.CLAUDE_CODE_CHILD_SESSION = '1'; process.env.CLAUDE_PID = '123'; process.env.CLAUDE_CODE_GIT_BASH_PATH = 'x';
process.env.NO_COLOR = '1'; // what a Claude gives its tools: a Claude started from there would be black and white
const env = childEnv('D:/acct');
assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
assert.equal(env.CLAUDE_PID, undefined);
assert.equal(env.NO_COLOR, undefined);
assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, 'x');
assert.equal(env.CLAUDE_CONFIG_DIR, 'D:/acct');
const plug = require('path').join(require('os').homedir(), '.claude-multi', 'plugin');
assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, plug);              // our plugin, in every Claude we start
process.env.CLAUDE_CODE_PLUGIN_DIRS = `D:\\mine${require('path').delimiter}${plug}`;
assert.equal(childEnv('D:/acct').CLAUDE_CODE_PLUGIN_DIRS, process.env.CLAUDE_CODE_PLUGIN_DIRS); // yours kept, ours not twice
delete process.env.CLAUDE_CODE_PLUGIN_DIRS;
console.log('env ok');

// "Done" waits for the helpers: a teammate is busy from its spawn (and each SendMessage) until it goes idle,
// a background task until its task-notification.
const { helpersBusy } = require('./claude-multi');
const ts = new Date().toISOString();
const use = (id, name, input) => JSON.stringify({ timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, text) => JSON.stringify({ timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
const says = (text) => JSON.stringify({ timestamp: ts, message: { content: text } });
const spawn = [use('t1', 'Agent', { name: 'writer' }), res('t1', 'Spawned successfully. id x')];
const idle = says('Another Claude session sent a message: <teammate-message teammate_id="writer" color="blue">\n{"type":"idle_notification","from":"writer"}');
assert.equal(helpersBusy(spawn.join('\n')), true);                                        // writer working
assert.equal(helpersBusy([...spawn, idle].join('\n')), false);                            // writer idle: done
assert.equal(helpersBusy([...spawn, idle, use('t2', 'SendMessage', { to: 'writer' })].join('\n')), true); // woken again
const bg = [use('b1', 'Bash', { run_in_background: true }), res('b1', 'Command running in background with ID: q1.')];
assert.equal(helpersBusy(bg.join('\n')), true);
assert.equal(helpersBusy([...bg, says('<task-notification>\n<tool-use-id>b1</tool-use-id>\n<status>completed</status>')].join('\n')), false);
assert.equal(helpersBusy([use('a1', 'Agent', { description: 'x' }), res('a1', 'the subagent finished: here is its report')].join('\n')), false); // foreground agent
// stopped by Claude itself: no task-notification ever comes, its TaskStop result says so (as a ticket's worker did,
// stopping its preview server: no "done" note, and the ticket never saw its turn end)
const stop = (id, task) => [use(id, 'TaskStop', { task_id: task }), res(id, `{"message":"Successfully stopped task: ${task} (node \\"x.js\\")","task_id":"${task}"}`)];
const bg2 = [use('b2', 'Bash', { run_in_background: true }), res('b2', 'Command running in background with ID: boy8woozg. Output is being written to: x')];
assert.equal(helpersBusy([...bg, ...bg2, ...stop('s1', 'q1')].join('\n')), true); // one of two stopped
assert.equal(helpersBusy([...bg, ...bg2, ...stop('s1', 'q1'), ...stop('s2', 'boy8woozg')].join('\n')), false); // both
assert.equal(helpersBusy([...bg, ...stop('s3', 'other')].join('\n')), true); // another task's stop
console.log('helpers ok');
assert.equal(helpersBusy(spawn.join('\n'), Date.now() + 1000), false); // spawned before this Claude started: gone
console.log('resume ok');

// The status line: account bold in its color, model · effort, the conversation's folder, where it works now.
process.env.NO_COLOR = '1';
const fs = require('fs');
const { statusline } = require('./claude-multi');
const reg = JSON.parse(fs.readFileSync(require('path').join(require('os').homedir(), '.claude-multi', 'profiles.json'), 'utf8'));
process.env.CLAUDE_CONFIG_DIR = reg.profiles[0].configDir;
const home = require('os').homedir();
const line = statusline({ model: { display_name: 'Opus 5.5' }, effort: { level: 'xhigh' }, context_window: { used_percentage: 60 },
  workspace: { project_dir: home, current_dir: require('path').join(home, '.claude-multi') } });
assert.equal(line, `账号 1 ${reg.profiles[0].label}  │  Opus 5.5 · xhigh  │  ${home}  │  context 60%`); // launch folder, full path; shell's cwd ignored
assert.equal(statusline({ workspace: { project_dir: 'D:\\paper_fast', current_dir: 'D:\\paper_fast\\sub' } }), `账号 1 ${reg.profiles[0].label}  │  D:\\paper_fast`);
console.log('statusline ok');

// token counting: each reply once at its largest, appended lines picked up, a half-written line waits
const { tokenStats } = require('./claude-multi');
const tmp = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'cm-tok-'));
const A = require('path').join(tmp, 'a', 'p'), B = require('path').join(tmp, 'b', 'p');
fs.mkdirSync(A, { recursive: true }); fs.mkdirSync(B, { recursive: true });
const reply = (id, ts, i, o, cw, cr, model) => JSON.stringify({ message: { model, id, role: 'assistant', content: [{ type: 'text', text: 'hi "usage": 9' }],
  usage: { input_tokens: i, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: o, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cw } } },
  requestId: 'req_' + id, type: 'assistant', timestamp: ts }) + '\n';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const atH = (h) => new Date(2026, 8, 30, h).toISOString(); // local 2026-09-30
const fa = require('path').join(A, 's.jsonl');
fs.writeFileSync(fa, reply('msg_1', atH(10), 1, 2, 3, 4, 'claude-opus-5-5') + reply('msg_1', atH(10), 1, 2, 3, 4, 'claude-opus-5-5') + reply('msg_1', atH(10), 0, 0, 0, 0, 'claude-opus-5-5')
  + JSON.stringify({ type: 'user', message: { content: 'x' }, timestamp: atH(10) }) + '\n');
const roots = [{ label: 'a', dir: require('path').join(tmp, 'a') }, { label: 'b', dir: require('path').join(tmp, 'b') }];
const cacheF = require('path').join(tmp, 'cache.json');
let t = tokenStats(roots, cacheF);
assert.equal(t.total, 10);
const d0 = t.days[0]; assert.deepEqual([d0.d, d0.i, d0.o, d0.cw, d0.cr], ['2026-09-30', 1, 2, 3, 4]);
near(d0.usd, ((1 + 3 * 2) * 4 + 2 * 20 + 4 * 0.2) / 1e6); // Opus 5.5: $4 in, 1-h writes 2x, $20 out, $0.20 reads
assert.equal(d0.by[0].i + d0.by[0].o + d0.by[0].cw + d0.by[0].cr, 10); assert.equal(d0.by[1].usd, 0); // all account a
fs.appendFileSync(fa, reply('msg_2', new Date(2026, 9, 1, 9).toISOString(), 0, 5, 0, 5, 'claude-fable-5-1') + '{"type":"assistant","message":{"id":"msg_3"'); // + a half line
fs.copyFileSync(fa, require('path').join(B, 'copy.jsonl')); // a resume copied to account b: no double count
t = tokenStats(roots, cacheF);
assert.equal(t.total, 20); assert.deepEqual(t.days.map((d) => d.d), ['2026-09-30', '2026-10-01']);
assert.equal(t.accounts[0].total, 20); assert.equal(t.accounts[1].total, 0);
near(t.usd, 68.8e-6 + (5 * 50 + 5 * 0.25) / 1e6); near(t.accounts[0].usd, t.usd); // Fable 5.1: $50 out, $0.25 reads
fs.appendFileSync(fa, ',"usage":{"input_tokens":7},"x":1},"type":"assistant","timestamp":"' + atH(11) + '"}\n'); // the half line completes
assert.equal(tokenStats(roots, cacheF).total, 27);
fs.utimesSync(cacheF, 0, 0); assert.equal(tokenStats(roots, cacheF).total, 27); assert.equal(fs.statSync(cacheF).mtimeMs, 0); // nothing new: not written again
fs.rmSync(fa); // Claude Code's 30-day cleanup: the replies stay counted (the copy in b now carries msg_1/msg_2)
assert.equal(tokenStats(roots, cacheF).total, 27);
fs.rmSync(require('path').join(B, 'copy.jsonl'));
assert.equal(tokenStats(roots, cacheF).total, 27);
// a resume copies a record into the other account: its replies stay with the account that made them
const cacheC = require('path').join(tmp, 'c.json'), fb = require('path').join(B, 'orig.jsonl');
fs.writeFileSync(fb, reply('msg_5', atH(12), 0, 4, 0, 0, 'claude-opus-5-5'));
const until = Date.now() + 30; while (Date.now() < until); // a later birth time for the copy
fs.copyFileSync(fb, require('path').join(A, 'copy.jsonl')); // account a is listed first
t = tokenStats(roots, cacheC);
assert.equal(t.accounts[0].total, 0); assert.equal(t.accounts[1].total, 4);
// rewritten shorter (a compaction tool trimming it): what was counted stays counted
fs.writeFileSync(fb, reply('msg_6', atH(13), 0, 1, 0, 0, 'claude-opus-5'));
assert.equal(tokenStats(roots, cacheC).total, 5);
fs.rmSync(require('path').join(A, 'copy.jsonl')); fs.rmSync(fb);
// an older cache (replies without their time): a deleted file's replies keep counting
const old = require('path').join(tmp, 'old.json');
fs.writeFileSync(old, JSON.stringify({ v: 2, files: { [require('path').join(tmp, 'a', 'p', 'gone.jsonl')]: { size: 9, recs: [['msg_9:r', '2026-09-29', 1, 0, 0, 1, 0, 'claude-opus-5-5', 0]] } } }));
t = tokenStats(roots, old);
assert.equal(t.total, 2); near(t.usd, (1 + 1 * 2) * 4 / 1e6);
// switched to b and back to a: a's file is the older one and holds every reply, yet b's stay b's (by the switch log)
{
  const sid = '0cca25c9-be24-456d-a34c-fa807b945adb', log = require('path').join(tmp, 'events.jsonl');
  // kept under a folder named like another conversation: a record's own is the one under its project folder
  const base = require('path').join(tmp, '2e904423-c9c9-4af8-8828-4d59b90ef388'), A = require('path').join(base, 'a', 'p'), B = require('path').join(base, 'b', 'p');
  fs.mkdirSync(A, { recursive: true }); fs.mkdirSync(B, { recursive: true });
  const fA = require('path').join(A, `${sid}.jsonl`), fB = require('path').join(B, `${sid}.jsonl`);
  const r2 = [{ id: 'pa', label: 'a', dir: require('path').join(base, 'a') }, { id: 'pb', label: 'b', dir: require('path').join(base, 'b') }];
  fs.writeFileSync(fA, reply('msg_a', atH(9), 0, 1, 0, 0, 'claude-opus-5-5'));
  const later = Date.now() + 30; while (Date.now() < later); // the copy born later
  fs.copyFileSync(fA, fB); fs.appendFileSync(fB, reply('msg_b', atH(11), 0, 2, 0, 0, 'claude-opus-5-5'));
  fs.copyFileSync(fB, fA); fs.appendFileSync(fA, reply('msg_c', atH(13), 0, 4, 0, 0, 'claude-opus-5-5'));
  fs.writeFileSync(log, [[atH(10), 'pb'], [atH(12), 'pa']].map(([timestamp, p]) => JSON.stringify({ timestamp, event: 'session_copied', profile_id: p, session_id: sid })).join('\n') + '\n');
  t = tokenStats(r2, require('path').join(tmp, 'sw.json'), log);
  assert.deepEqual(t.accounts.map((a) => a.total), [5, 2]); // a: msg_a and msg_c; b: msg_b
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('tokens ok');

// From session 0 (ssh, a service) the Recycle Bin deletes for good: a delete there is refused, the file kept. (Run from
// the desktop, these aren't: they'd fill your Recycle Bin.)
const SESSION0 = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-Command', '[Diagnostics.Process]::GetCurrentProcess().SessionId'], { encoding: 'utf8' }).stdout?.trim() === '0';
if (SESSION0) {
  const { recycle } = require('./claude-multi'), f = require('path').join(TEST_HOME, 'rb.txt');
  fs.writeFileSync(f, 'x');
  const r = recycle([f]);
  assert.equal(r.status, 3); assert.ok(fs.existsSync(f)); assert.match(r.stderr, /回收站/);
  console.log('recycle ok');
}
// 换账号继续 moves the record and its side folder into the account going on with it: none left in the old one, whose
// replies stay its own
{
  const { copyTo } = require('./claude-multi'), path = require('path'), id = '3f1e2d3c-4b5a-4968-8776-655443322110';
  const reg = path.join(TEST_HOME, '.claude-multi', 'profiles.json'), was = fs.readFileSync(reg, 'utf8'), A = path.join(TEST_HOME, 'mv-a'), B = path.join(TEST_HOME, 'mv-b');
  fs.writeFileSync(reg, JSON.stringify({ active: null, profiles: [{ id: 'mv-a', label: 'a', configDir: A }, { id: 'mv-b', label: 'b', configDir: B }] }));
  const from = path.join(A, 'projects', 'p', `${id}.jsonl`), sub = path.join('p', id, 'subagents', 'agent-x.jsonl');
  fs.mkdirSync(path.dirname(path.join(A, 'projects', sub)), { recursive: true });
  fs.writeFileSync(from, reply('msg_mv', new Date(Date.now() - 6e4).toISOString(), 0, 3, 0, 0, 'claude-opus-5-5')); // before the switch (logged in whole seconds)
  fs.writeFileSync(path.join(A, 'projects', sub), '{}\n');
  const until = Date.now() + 30; while (Date.now() < until); // the copy born later
  copyTo({ id, file: from }, { id: 'mv-b', configDir: B });
  assert.ok(fs.existsSync(path.join(B, 'projects', 'p', `${id}.jsonl`)) && fs.existsSync(path.join(B, 'projects', sub)));
  assert.ok(!fs.existsSync(from) && !fs.existsSync(path.join(A, 'projects', 'p', id)));
  assert.deepEqual(tokenStats().accounts.map((a) => a.total), [3, 0]);
  fs.writeFileSync(reg, was);
  console.log('switch move ok');
}

// Notifications on the web page: the latest per conversation, gone once read anywhere or answered since.
{
  const { unreadNotes } = require('./claude-multi');
  const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'cm-note-')), T = Date.parse('2026-10-07T08:00:00Z');
  const conv = (said) => { const f = require('path').join(dir, `${said}.jsonl`); fs.writeFileSync(f, [
    { type: 'user', timestamp: new Date(T + said).toISOString(), message: { content: 'hi' } },
    { type: 'user', timestamp: new Date(T + 9e6).toISOString(), message: { content: '<task-notification>\n<task-id>x</task-id>' } }, // not you
  ].map((x) => JSON.stringify(x)).join('\n') + '\n'); return f; };
  const list = [{ id: 'a', file: conv(1000) }, { id: 'b', file: conv(5e6) }, { id: 'c', file: conv(0) }];
  const notes = [{ id: 'a', at: T + 3e6 }, { id: 'b', at: T + 3e6 }, { id: 'c', at: T + 3e6 }, { id: 'a', at: T + 2e6 }]; // newest first
  const ids = (marks) => unreadNotes(list, notes, new Map(marks)).map((n) => `${n.id}@${n.at - T}`).join(' ');
  assert.equal(ids([]), 'a@3000000 c@3000000');            // b: you wrote in it after; a: only its latest
  assert.equal(ids([['a', T + 4e6]]), 'c@3000000');          // a read (island, another browser)
  assert.equal(ids([['*', T + 4e6]]), '');                   // all read
  assert.equal(ids([['*', T + 1e6]]), 'a@3000000 c@3000000'); // an older "all read" doesn't hide newer ones
  fs.rmSync(dir, { recursive: true });
  console.log('notes ok');
}

// The page's 记录 view: what you said, Claude's text, a line per tool call; the rest left out.
{
  const { history } = require('./claude-multi');
  const f = require('path').join(require('os').tmpdir(), `cm-hist-${process.pid}.jsonl`), T = '2026-10-07T08:00:00Z';
  const u = (content, extra = {}) => ({ type: 'user', timestamp: T, message: { role: 'user', content }, ...extra });
  const a = (content) => ({ type: 'assistant', timestamp: T, message: { role: 'assistant', content } });
  fs.writeFileSync(f, [
    u('<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }),
    u('<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args>新名字</command-args>'),
    u('修一下 bug<system-reminder>ignore me</system-reminder>'),
    a([{ type: 'thinking', thinking: '...' }, { type: 'text', text: '好的。' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }]),
    u([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]),
    // a background task over: a line saying so (what woke Claude), its description from the summary
    u('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "Wait for the plan" completed (exit code 0)</summary>'),
    u('Summary of earlier work', { isCompactSummary: true }),
    a([{ type: 'text', text: '测试通过。' }]),
    // sent while Claude was at work; a background task's message delivered the same way isn't yours
    { type: 'attachment', timestamp: T, attachment: { type: 'queued_command', prompt: '顺便看看日志', origin: { kind: 'human' } } },
    { type: 'attachment', timestamp: T, attachment: { type: 'queued_command', prompt: '<task-notification>', origin: { kind: 'task' } } },
    { type: 'system', subtype: 'turn_duration', durationMs: 7750, timestamp: T }, // Claude's turn over
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const all = history(f);
  assert.deepEqual(all.items.map((x) => `${x.role}:${x.text}`),
    ['user:/rename 新名字', 'user:修一下 bug', 'claude:好的。', 'tool:Bash  Run tests', 'note:⏳ 后台的事有结果了：Wait for the plan', 'note:更早的内容已压缩', 'claude:测试通过。', 'user:顺便看看日志', 'done:7750']);
  // read again from where it ended: only what was added, and a line still being written waits
  fs.appendFileSync(f, JSON.stringify(a([{ type: 'text', text: '看完了。' }])) + '\n{"type":"assistant","mess');
  const more = history(f, { from: all.end });
  assert.deepEqual(more.items.map((x) => x.text), ['看完了。']);
  assert.equal(history(f, { from: more.end }).items.length, 0);
  // a long one: the last keep or so, from a message of yours; the ones before it come with end: start, none twice
  fs.writeFileSync(f, Array.from({ length: 30 }, (_, k) => [u(`问${k}`), a([{ type: 'text', text: `答${k}` }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }])])
    .flat().map((x) => JSON.stringify(x)).join('\n') + '\n');
  const tail = history(f, { keep: 10 }), head = history(f, { end: tail.start, keep: 1000 });
  assert.equal(tail.items[0].text, '问26'); // 10 back from the end lands mid-turn: from its question, 12 items
  assert.equal(tail.items.length, 12);
  assert.equal(head.items.length + tail.items.length, 90);
  assert.equal(head.items.at(-1).text, 'Bash  ls');
  assert.ok(!('pos' in tail.items[0]));
  fs.rmSync(f);
  console.log('history ok');
}

// The 终端 of a window here starts at a question of yours: the record fills in from the question the first
// message on the screen belongs to; the lines above that message are left out (the record has them).
{
  const { lead } = require('./claude-multi');
  const items = [['user', '第一个问题'], ['claude', '第一个回答'], ['user', '第二个问题'], ['claude', '**第二个**回答'], ['user', '第三个问题']]
    .map(([role, text]) => ({ role, text }));
  const plain = (l) => l.text.replace(/\x1b\[[0-9;]*m/g, '').split('\r\n').filter(Boolean);
  const MARK = '── 以上是对话记录，下面是电脑窗口里的画面 ──', EARLIER = '── 更早的在「记录」里 ──';
  const l = lead(items, ['…第一个回答的结尾', '', '\x1b[1m● 第二个回答\x1b[0m']);
  assert.equal(l.skip, 2);
  assert.deepEqual(plain(l), [EARLIER, '❯ 第二个问题', MARK]);
  assert.deepEqual(plain(lead(items, ['● 第一个回答'])), ['❯ 第一个问题', MARK]);  // the very first: no note
  assert.equal(lead(items, ['…', '❯ 第二个问题']).text, '');                   // the screen starts at a question
  const none = lead(items, ['● 认不出的', '● 两行']);                           // nothing on it found
  assert.equal(none.skip, 2);
  assert.deepEqual(plain(none), [EARLIER, '❯ 第三个问题', MARK]);
  // a picture in the record (its text is its place there, for the web page): drawn as [图片], never matched to the screen
  const pic = [{ role: 'user', text: '先看第一张' }, { role: 'img', text: '1234.0' }, { role: 'user', text: '[Image #1] 这是什么' }, { role: 'claude', text: '那是一只橘猫' }];
  assert.deepEqual(plain(lead(pic, ['● 那是一只橘猫'])), [EARLIER, '❯ [图片]', '❯ [Image #1] 这是什么', MARK]); // its picture with it
  assert.equal(lead(pic, ['● 1234.0']).skip, 1);                               // not found: the place isn't text
  console.log('lead ok');
}

// The quota: a read that failed for a while (network, rate limit, server) keeps the account's last good one for
// 30 min, a window reset since then counting as fresh; a failure you have to act on (logged out) shows.
{
  const { keepLast } = require('./claude-multi');
  const now = Date.parse('2026-10-07T12:00:00Z'), P = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const u = { five_hour: { utilization: 97, resets_at: '2026-10-07T11:30:00Z' }, seven_day: { utilization: 50, resets_at: '2026-10-10T00:00:00Z' } };
  const cache = { a: { at: now - 600000, u }, b: { at: now - 3600000, u }, c: { at: now - 600000, u } };
  const out = keepLast(P, [{ err: '网络错误：fetch failed', temp: true }, { err: '网络错误：fetch failed', temp: true }, { err: 'token 已过期' }], cache, now);
  assert.equal(out[0].u.five_hour.utilization, 0);  // reset at 11:30, half an hour ago
  assert.equal(out[0].u.seven_day.utilization, 50); // still running
  assert.equal(out[1].err, '网络错误：fetch failed'); // its last good one is an hour old
  assert.equal(out[2].err, 'token 已过期');          // not a passing failure
  const fresh = { five_hour: { utilization: 10, resets_at: null } };
  keepLast([{ id: 'b' }], [{ u: fresh }], cache, now);
  assert.deepEqual(cache.b, { at: now, u: fresh }); // a good read is kept for next time
  console.log('quota ok');
}
// Notes (projects\<folder>\memory) shared by every account: a real one merged into ~/.claude's and made a junction to
// it, the originals kept; a folder Claude is about to start in linked ahead; a second run changes nothing.
{
  const { shareMemory } = require('./claude-multi');
  const fs = require('fs'), path = require('path'), os = require('os');
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mem-')), home = path.join(t, 'home'), a1 = path.join(t, 'a1'), a2 = path.join(t, 'a2'), bak = path.join(t, 'bak');
  const put = (f, s, age) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); const at = Date.now() / 1000 - age; fs.utimesSync(f, at, at); };
  const P = (d) => path.join(d, 'projects', 'P', 'memory');
  put(path.join(P(home), 'MEMORY.md'), '- [A](a.md) — old hook\n- [K](k.md) — k\n', 300);
  put(path.join(P(home), 'a.md'), 'a, old', 300);
  put(path.join(P(home), 'k.md'), 'k', 300);
  put(path.join(P(a1), 'MEMORY.md'), '- [A](a.md) — new hook\n- [B](b.md) — b\n', 10);
  put(path.join(P(a1), 'a.md'), 'a, new', 10);
  put(path.join(P(a1), 'b.md'), 'b', 10);
  fs.mkdirSync(path.join(a2, 'projects', 'Q'), { recursive: true }); // used there, nothing remembered yet
  const run = () => shareMemory([[a2, 'R']], [home, a1, a2], bak);
  run();
  const read = (f) => fs.readFileSync(f, 'utf8');
  assert.equal(read(path.join(P(home), 'a.md')), 'a, new');                 // in both: the newest
  assert.equal(read(path.join(P(home), 'k.md')), 'k');                      // only shared: stays
  assert.equal(read(path.join(P(a1), 'b.md')), 'b');                        // read through the junction
  assert.ok(fs.lstatSync(P(a1)).isSymbolicLink());
  assert.equal(read(path.join(P(home), 'MEMORY.md')), '- [A](a.md) — new hook\n- [B](b.md) — b\n- [K](k.md) — k\n');
  for (const f of ['Q', 'R']) assert.ok(fs.lstatSync(path.join(a2, 'projects', f, 'memory')).isSymbolicLink()); // linked ahead
  const kept = path.join(bak, fs.readdirSync(bak)[0]);
  assert.equal(read(path.join(kept, 'a1', 'P', 'a.md')), 'a, new');        // the account's original
  assert.equal(read(path.join(kept, 'shared', 'P', 'a.md')), 'a, old');    // the shared one before the merge
  run();
  assert.equal(fs.readdirSync(bak).length, 1);                              // nothing left to merge
  fs.rmSync(t, { recursive: true, force: true });
  console.log('memory ok');
}
// MCP servers (`claude mcp add`, in each config's own .claude.json) kept as one set: added in any config, it reaches
// the others as they start; removed in one, it goes everywhere; a config that never had it isn't taken for a removal;
// everything else in the file stays.
{
  const { shareMcp } = require('./claude-multi');
  const fs = require('fs'), path = require('path'), os = require('os');
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mcp-')), F = ['home', 'a1', 'a2'].map((n) => path.join(t, n, '.claude.json')), state = path.join(t, 'state.json');
  const put = (i, j) => { fs.mkdirSync(path.dirname(F[i]), { recursive: true }); fs.writeFileSync(F[i], JSON.stringify(j)); };
  const mcp = (i) => Object.keys(JSON.parse(fs.readFileSync(F[i], 'utf8')).mcpServers ?? {}).sort().join(',');
  const start = (i) => shareMcp(path.dirname(F[i]), F, state);
  put(0, { mcpServers: { chrome: { command: 'npx' } } }); put(1, { oauthAccount: { emailAddress: 'x' } }); put(2, { mcpServers: { git: { command: 'g' } } });
  start(1);
  assert.equal(mcp(1), 'chrome,git');                                            // from plain claude and from account 2
  assert.equal(mcp(0), 'chrome,git');
  assert.equal(JSON.parse(fs.readFileSync(F[1], 'utf8')).oauthAccount.emailAddress, 'x'); // the rest untouched
  const j = JSON.parse(fs.readFileSync(F[0], 'utf8')); delete j.mcpServers.git; put(0, j); // removed in plain claude
  start(2);
  assert.equal(mcp(2), 'chrome');
  start(1);
  assert.equal(mcp(1), 'chrome');                                                // gone there too
  put(2, { mcpServers: { chrome: { command: 'npx' } } }); fs.writeFileSync(F[1], '{"half'); // a file caught mid-write
  start(2);
  assert.equal(mcp(2), 'chrome');                                                // not taken for a removal
  fs.rmSync(t, { recursive: true, force: true });
  console.log('mcp ok');
}
// The next renewal, guessed monthly on the day the subscription began.
{
  const { nextRenewal } = require('./claude-multi');
  const d = (s) => new Date(`${s}T12:00:00`);
  const next = (since, now) => { const x = nextRenewal(d(since), d(now)); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  assert.equal(next('2026-07-07', '2026-10-11'), '2026-11-07'); // this month's has passed
  assert.equal(next('2026-09-28', '2026-10-11'), '2026-10-28');
  assert.equal(next('2026-07-07', '2026-10-07'), '2026-10-07'); // today
  assert.equal(next('2026-10-09', '2026-10-09'), '2026-11-09'); // began today: next month
  assert.equal(next('2026-01-31', '2026-02-10'), '2026-02-28'); // a day February lacks
  assert.equal(next('2026-08-15', '2026-12-20'), '2027-01-15'); // into the next year
  const on = (day, now) => { const x = nextRenewal(d(day), d(now), true); return `${x.getMonth() + 1}-${x.getDate()}`; };
  assert.equal(on('2026-10-28', '2026-10-11'), '10-28');         // a billing day you set: itself counts
  assert.equal(on('2026-10-28', '2026-11-02'), '11-28');
  assert.equal(nextRenewal(new Date('2026-99-99T00:00:00'), d('2026-10-11'), true), null); // a day that isn't: none, at once (it looped forever)
  console.log('renewal ok');
}
// 换账号继续: 答完再换 waits while the Claude is at work (busy, shell) and goes once it isn't; now goes at once. A
// tab picks its switch request up once, by its Claude's pid.
(async () => {
  const { untilFree, takeSwitch } = require('./claude-multi');
  const fs = require('fs'), path = require('path'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-sw-')), f = path.join(dir, 'sessions', `${process.pid}.json`);
  fs.mkdirSync(path.dirname(f));
  const status = (s) => fs.writeFileSync(f, JSON.stringify({ pid: process.pid, status: s }));
  status('busy');
  let t = Date.now();
  setTimeout(() => status('shell'), 700); setTimeout(() => status('idle'), 1500);
  await untilFree(dir, process.pid, false);
  const waited = Date.now() - t;
  assert.ok(waited >= 1400 && waited < 3500, `waited ${waited} ms`);       // through busy and shell, out at idle
  status('busy'); t = Date.now(); await untilFree(dir, process.pid, true);
  assert.ok(Date.now() - t < 200);                                        // now: at once
  status('waiting'); t = Date.now(); await untilFree(dir, process.pid, false);
  assert.ok(Date.now() - t < 200);                                        // waiting on you: nothing to cut
  fs.rmSync(f); t = Date.now();                                           // its status unreadable: not taken for free,
  await assert.rejects(untilFree(dir, process.pid, false, 1500), /读不到/);  // asked again, then given up
  assert.ok(Date.now() - t >= 1400, 'waited for the status before giving up');
  status('busy'); setTimeout(() => fs.rmSync(f), 300); setTimeout(() => status('idle'), 1200); t = Date.now();
  await untilFree(dir, process.pid, false, 5000);                         // gone a moment, then idle: waited out
  assert.ok(Date.now() - t >= 1100);
  const sw = path.join(os.homedir(), '.claude-multi', 'switch');
  fs.mkdirSync(sw, { recursive: true }); fs.writeFileSync(path.join(sw, '999999.json'), JSON.stringify({ id: 'x', n: 2 }));
  assert.deepEqual(takeSwitch(999999), { id: 'x', n: 2 });
  assert.equal(takeSwitch(999999), null);                                 // taken once
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('switch ok');
})();
// removing an account: the links in its folder go, never what they point to; its tokens stay counted
{
  const { unlinkAll, tokenRoots } = require('./claude-multi');
  const path = require('path'), d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cm-rm-'));
  const shared = path.join(d, 'shared'), acct = path.join(d, 'acct'), f = path.join(acct, 'projects', 'f');
  fs.mkdirSync(path.join(shared, 'skills'), { recursive: true }); fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(path.join(shared, 'skills', 'x.md'), 'x'); fs.writeFileSync(path.join(shared, 'settings.json'), '{}');
  fs.writeFileSync(path.join(f, 'a.jsonl'), '');
  fs.symlinkSync(path.join(shared, 'skills'), path.join(acct, 'skills'), 'dir');
  fs.symlinkSync(path.join(shared, 'skills'), path.join(f, 'memory'), 'junction');
  fs.symlinkSync(path.join(shared, 'settings.json'), path.join(acct, 'settings.json'), 'file');
  unlinkAll(acct);
  assert.deepEqual(fs.readdirSync(acct), ['projects']);
  assert.deepEqual(fs.readdirSync(f), ['a.jsonl']);                                   // its own files left for the Recycle Bin
  assert.equal(fs.readFileSync(path.join(shared, 'skills', 'x.md'), 'utf8'), 'x');   // what the links pointed to, untouched
  assert.ok(fs.existsSync(path.join(shared, 'settings.json')));
  fs.rmSync(d, { recursive: true, force: true });
  const roots = tokenRoots({ profiles: [{ id: 'a', label: 'a@x', configDir: 'C:\\A' }], removed: [{ id: 'b', label: 'b@x', configDir: 'C:\\B' }] });
  assert.deepEqual(roots.map((r) => r.label), ['a@x', 'b@x（已移除）']);
  console.log('remove ok');
}

// the web page's key: from the link or the cookie the link left, nothing else opens it
{
  const { keyMatch, keyCookie } = require('./claude-multi');
  const k = 'Zq3x_9-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  assert.ok(keyMatch(k, k));
  for (const bad of [undefined, null, '', k.slice(1), k + 'x', k.replace('Z', 'z'), 'é'.repeat(k.length)]) assert.ok(!keyMatch(bad, k), String(bad));
  assert.equal(keyCookie(`a=1; cm=${k}; b=2`), k);
  assert.equal(keyCookie(`cm=${k}`), k);
  assert.equal(keyCookie(`xcm=${k}`), undefined);   // another cookie's name ending in cm
  assert.equal(keyCookie(undefined), undefined);
  console.log('web key ok');
}

// trusted folders: the config about to start gets every folder another config trusts, nothing else changes
{
  const { shareTrust } = require('./claude-multi');
  const path = require('path'), d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cm-trust-'));
  const cfg = (name, projects) => { fs.mkdirSync(path.join(d, name)); fs.writeFileSync(path.join(d, name, '.claude.json'), JSON.stringify({ projects, theme: name })); return path.join(d, name, '.claude.json'); };
  const files = [cfg('home', { 'C:/a': { hasTrustDialogAccepted: true } }), cfg('one', { 'D:/b': { hasTrustDialogAccepted: true }, 'E:/no': { hasTrustDialogAccepted: false } }),
    cfg('two', { 'C:/a': { allowedTools: ['x'] }, 'F:/c': { hasTrustDialogAccepted: true } })];
  shareTrust(path.join(d, 'two'), files);
  const two = JSON.parse(fs.readFileSync(files[2], 'utf8'));
  assert.deepEqual(Object.keys(two.projects).filter((k) => two.projects[k].hasTrustDialogAccepted).sort(), ['C:/a', 'D:/b', 'F:/c']);
  assert.deepEqual(two.projects['C:/a'].allowedTools, ['x']);            // what it had there stays
  assert.equal(two.projects['E:/no'], undefined);                        // untrusted elsewhere: not added
  assert.equal(two.theme, 'two');
  const at = fs.statSync(files[2]).mtimeMs; shareTrust(path.join(d, 'two'), files);
  assert.equal(fs.statSync(files[2]).mtimeMs, at);                       // nothing new: not written
  fs.rmSync(d, { recursive: true, force: true });
  console.log('trust ok');
}

// The web page's Markdown: a table drawn as a table (cells inline-formatted, \| a pipe in a cell); lines of | without
// the |---| line under a header stay monospace text.
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'web.html'), 'utf8');
  const part = (re) => src.match(re)[0];
  const md = new Function('katex', `${part(/^const esc = .*$/m)}\n${part(/^const svg = .*$/m)}\n${part(/^const I = [\s\S]*?\};$/m)}\n${part(/^const table = [\s\S]*?^};$/m)}
    ${part(/^const LINK = [\s\S]*?^};$/m)}\n${part(/^const MATH = .*$/m)}\n${part(/^const tex = .*$/m)}\n${part(/^function md\(t\) \{[\s\S]*?^\}$/m)}\nreturn md;`)(require('katex'));
  const t = md('看这个\n| 方案 | 快不快 |\n|---|:--:|\n| **A. 离线** | `x` 快 |\n| c \\| d | <e> |\n后面');
  assert.ok(t.includes('<thead><tr><th>方案</th><th>快不快</th></tr></thead>'), t);
  assert.ok(t.includes('<tr><td><b>A. 离线</b></td><td><code>x</code> 快</td></tr>'), t);
  assert.ok(t.includes('<tr><td>c | d</td><td>&lt;e&gt;</td></tr>'), t);              // escaped as everything else
  assert.ok(t.startsWith('看这个\n<div class="tbl">') && t.endsWith('</table></div>后面'), t);
  assert.equal(md('| grep x\n'), '<div class="mono">| grep x\n</div>');               // not a table
  // links: the address to a space, a quote or Chinese text; a sentence's end and an unopened ")" left out; in a code
  // span or bold it's a link inside it (neither cut across its markup); none in a code block
  const a = (u, w = u) => `<a href="${u}" target="_blank" rel="noopener">${w}</a>`;
  assert.equal(md('PR：https://github.com/a/b/pull/7，看看'), `PR：${a('https://github.com/a/b/pull/7')}，看看`);
  assert.equal(md('(见 https://x.com/a)。'), `(见 ${a('https://x.com/a')})。`);
  assert.equal(md('https://w.org/Foo_(bar). x'), `${a('https://w.org/Foo_(bar)')}. x`);
  assert.equal(md('(https://w.org/Foo_(bar))'), `(${a('https://w.org/Foo_(bar)')})`);             // its own pair kept, the outer ")" not
  assert.equal(md('[维基](https://w.org/Foo_(bar))。'), `${a('https://w.org/Foo_(bar)', '维基')}。`); // a pair inside [words](address)
  assert.equal(md('q https://a.com/x?a=1&b=2. "https://q.com"'), `q ${a('https://a.com/x?a=1&amp;b=2')}. &quot;${a('https://q.com')}&quot;`);
  assert.equal(md('[文档](https://d.com/p) `https://c.x` **https://b.x**'), `${a('https://d.com/p', '文档')} <code>${a('https://c.x')}</code> <b>${a('https://b.x')}</b>`);
  assert.ok(md('```\nhttps://in.code/x\n```').endsWith('<pre>https://in.code/x</pre></div>'));
  // math, drawn by KaTeX: in the line and set apart; its | and * left to it, not the table and bold rules
  const m = md(String.raw`估计 $\hat{X}_0=X_t-\sigma(t)\hat{R}_t$，**设 $X_{t_N}=X_p$**` + '\n' + String.raw`$$X_{t'}=\frac{\sigma_{t'}^2}{\sigma_t^2}X_t+\sqrt{|a|*b}$$`);
  assert.ok(m.startsWith('估计 <span class="katex">') && m.includes('<b>设 <span class="katex">') && m.includes('class="katex-display"'), m);
  assert.ok(!m.includes('$') && !m.includes('<td>') && !m.includes('&lt;b'), m);
  assert.equal(md('花了 $5 和 $6，$1.50和$2.00'), '花了 $5 和 $6，$1.50和$2.00');           // money stays money
  assert.equal(md('用 `echo $HOME` 看 $x'), '用 <code>echo $HOME</code> 看 $x');              // code stepped over; a lone $ stays
  assert.ok(md('```\n$a$\n```').includes('<pre>$a$</pre>'));                                     // never in a code block
  assert.ok(md(String.raw`坏的 $\frac{a$ 公式`).includes('katex-error'));                          // shown in red as written
  assert.ok(md(String.raw`行内 \(a<b\) 和 \[c>d\]`).includes('katex-display') && !md(String.raw`\(a<b\)`).includes('&lt;b\\)'));
  // links and math together: KaTeX's own http:// address isn't made a link; a formula right after an address isn't in it
  assert.ok(!m.includes('<a '), m);
  const lm = md('见 https://x.com/a$b$');
  assert.ok(lm.startsWith(`见 ${a('https://x.com/a')}<span class="katex">`), lm);
  console.log('md ok');
  // a message's time, by the day it's on: today's the time alone, yesterday's 昨天, this year's without the year
  const stamp = new Function(`${part(/^function stamp\(ms[\s\S]*?^\}$/m)}\nreturn stamp;`)();
  const now = new Date(2026, 10, 4, 9, 0).getTime(), at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
  assert.equal(stamp(at(2026, 11, 4, 0, 5), now), '00:05');
  assert.equal(stamp(at(2026, 11, 3, 23, 59), now), '昨天 23:59');
  assert.equal(stamp(at(2026, 1, 2, 8, 7), now), '1月2日 08:07');
  assert.equal(stamp(at(2025, 12, 31, 18, 30), now), '2025年12月31日 18:30');
  console.log('stamp ok');
}

// One thing at a time for a conversation in the web service: no rename or delete during a switch or another one, no
// switch during a rename or delete; a second switch goes on without a hold of its own, the first one's end lets go
{
  const { hold } = require('./claude-multi'), id = 'c-1';
  const switched = hold(id, 'switch');
  assert.throws(() => hold(id, 'change'), /换账号/);
  hold(id, 'switch')(); // the second one's end lets nothing go
  assert.throws(() => hold(id, 'change'), /换账号/);
  switched();
  const changed = hold(id, 'change');
  assert.throws(() => hold(id, 'switch'), /改名或删除/);
  assert.throws(() => hold(id, 'change'), /改名或删除/);
  hold('c-2', 'change')(); // another conversation: its own
  changed();
  hold(id, 'change')();
  console.log('hold ok');
}

// GPT (Codex) conversations, from an account's SQLite as Codex 0.166 keeps it: its list (said something in, not archived,
// not a helper agent's; Codex's \\?\ paths plain); a conversation's record (yours, its replies, tool lines named as
// Claude's, thinking left out, each turn's end at its place; read up to a reply still being written, then on from there;
// start 0 at its beginning, else where the shown ones begin; one not running shows an unfinished reply as it is); its usage from its record file; its folders trusted once
{
  const fs = require('fs'), path = require('path'), os = require('os'), { DatabaseSync } = require('node:sqlite');
  const { listGpt, gptHistory, gptUsage, gptTrust } = require('./claude-multi');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gpt-')), work = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-work-'));
  const B = String.fromCharCode(92), long = (p) => `${B}${B}?${B}${p}`, j = JSON.stringify, rollout = path.join(home, 'rollout.jsonl');
  const st = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  st.exec(`create table threads (id text, rollout_path text, cwd text, title text, name text, preview text, first_user_message text,
    updated_at_ms integer, created_at_ms integer, model text, reasoning_effort text, archived integer, has_user_event integer, source text)`); // has_user_event: 0 as Codex leaves it
  const thread = st.prepare('insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  thread.run('t1', long(rollout), long(work), '修复登录', null, '再加个测试', '帮我修登录', 3000, 1000, 'gpt-x', 'high', 0, 0, 'cli');
  thread.run('t2', null, work, '归档了的', null, null, '说过', 2000, 900, null, null, 1, 0, 'cli');
  thread.run('t3', null, work, '帮手', null, null, '说过', 2500, 950, null, null, 0, 0, j({ subagent: {} }));
  thread.run('t4', null, work, '还没说话', null, null, null, 2600, 960, null, null, 0, 0, 'cli');                  // no first message yet
  st.close();
  const h = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  h.exec('create table thread_items (thread_id text, turn_id text, rollout_ordinal integer, item_type text, item_json text, created_at_ms integer, completed_at_ms integer)');
  h.exec('create table thread_turns (thread_id text, turn_id text, rollout_ordinal integer, rollout_end_ordinal integer, status text, duration_ms integer)');
  const item = (o, k, x, at, done = at) => h.prepare('insert into thread_items values (?, ?, ?, ?, ?, ?, ?)').run('t1', o < 8 ? 'u1' : 'u2', o, k, j({ type: k, ...x }), at, done);
  item(1, 'userMessage', { content: [{ type: 'text', text: '帮我修登录' }, { type: 'localImage', path: 'x.png' }] }, 1000);
  item(2, 'reasoning', { summary: [] }, 1001);
  item(3, 'agentMessage', { text: '我先看看', phase: 'commentary' }, 1002);
  item(4, 'commandExecution', { command: 'npm test\nmore' }, 1003);
  item(5, 'fileChange', { changes: [{ path: 'a.js', diff: '+1' }, { path: 'b.js' }] }, 1004);
  item(6, 'agentMessage', { text: '修好了', phase: 'final_answer' }, 1005);
  h.prepare('insert into thread_turns values (?, ?, ?, ?, ?, ?)').run('t1', 'u1', 1, 7, 'completed', 61000);
  item(8, 'userMessage', { content: [{ type: 'text', text: '再加个测试' }] }, 2000);
  item(9, 'agentMessage', { text: '写好了', phase: 'final_answer' }, 2001, null); // still being written
  h.prepare('insert into thread_turns values (?, ?, ?, ?, ?, ?)').run('t1', 'u2', 8, null, 'inProgress', null);
  const list = listGpt({ gpt: [{ home }] });
  assert.deepEqual(list.map((s) => [s.id, s.cwd, s.title, s.prompt, s.gpt, s.acct]), [['t1', work, '修复登录', '再加个测试', true, 0]]);
  const roles = (r) => r.items.map((m) => `${m.role}:${m.text}`);
  assert.equal(roles(gptHistory(home, 't1')).at(-1), 'claude:写好了');           // not running: an unfinished one as it is
  let r = gptHistory(home, 't1', { live: true });
  assert.deepEqual(roles(r), ['user:帮我修登录\n🖼 1 张图片', 'claude:我先看看', 'tool:Bash  npm test', 'tool:Edit  a.js, b.js', 'claude:修好了', 'done:61000', 'user:再加个测试']);
  assert.deepEqual([r.start, r.end], [0, 9]);                                     // its beginning; on from the reply still written
  assert.deepEqual(gptHistory(home, 't1', { from: 9, live: true }).items, []);                // still being written: nothing yet
  h.prepare('update thread_items set completed_at_ms = 2002 where rollout_ordinal = 9').run();
  h.prepare("update thread_turns set status = 'completed', rollout_end_ordinal = 10, duration_ms = 3000 where rollout_ordinal = 8").run();
  r = gptHistory(home, 't1', { from: 9, live: true });
  assert.deepEqual([roles(r), r.end], [['claude:写好了', 'done:3000'], 11]);
  r = gptHistory(home, 't1', { keep: 3 });                                        // the newest, back to a message of yours
  assert.deepEqual([roles(r), r.start], [['user:再加个测试', 'claude:写好了', 'done:3000'], 8]);
  r = gptHistory(home, 't1', { end: 8 });                                         // and what's before it, to its beginning
  assert.deepEqual([r.items.length, r.items.at(-1).role, r.start], [6, 'done', 0]);
  // what the 管家 and the phones read of it: your last words (who set its turn going), its last reply, its turn's state
  const { gptLast, gptTurn, gistText } = require('./claude-multi');
  h.exec('alter table thread_turns add column started_at integer'); // when each began, in seconds (Codex's column)
  assert.deepEqual([gptLast(home, 't1', 'userMessage'), gptLast(home, 't1', 'agentMessage'), gptTurn(home, 't1')?.status, gptTurn(home, 'none')], ['再加个测试', '写好了', 'completed', null]);
  assert.equal(gistText('好的。\n\n已经改好了 `a.js`，测试都过了。\n\n```js\nx\n```'), '好的。 已经改好了 a.js，测试都过了。');
  h.close();
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(rollout, [j({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { plan_type: 'pro', primary: { used_percent: 8.4, window_minutes: 10080, resets_at: now + 3 * 86400 },
    secondary: { used_percent: 40, window_minutes: 300, resets_at: now + 3600 } } } }), j({ type: 'event_msg', payload: { type: 'token_count', rate_limits: null } })].join('\n') + '\n');
  const u = gptUsage(home);
  assert.deepEqual([u.plan, u.windows.map((w) => [w.k, w.pct])], ['pro', [['seven_day', 8], ['five_hour', 40]]]);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"');
  gptTrust(home, work); gptTrust(home, work); gptTrust(home, path.join(work, "it's"));
  const cfg = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  assert.equal(cfg, `model = "x"\n\n[projects.'${path.resolve(work)}']\ntrust_level = "trusted"\n`); // once; none for a path with '
  // Codex's notify (claude-multi notify gpt <its JSON>), as a command in a ROOT of its own: a note for the pages and the
  // island named as the account's list names it; a helper agent's turn, or another kind, none
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-')), cm = path.join(root, '.claude-multi');
  fs.mkdirSync(cm); fs.writeFileSync(path.join(cm, 'island.ps1.pid'), String(process.pid)); // the island "running": not started
  const notifyGpt = (x) => require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'claude-multi.js'), 'notify', 'gpt', j(x)],
    { env: { ...process.env, USERPROFILE: root, HOME: root, CODEX_HOME: home }, encoding: 'utf8' });
  notifyGpt({ type: 'agent-turn-complete', 'thread-id': 't1', 'last-assistant-message': '写好了' });
  require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'claude-multi.js'), 'notify', 'gpt', home, j({ type: 'approval-requested', 'thread-id': 't1' })],
    { env: { ...process.env, USERPROFILE: root, HOME: root, CODEX_HOME: '' } }); // its home given, as the web service gives it
  notifyGpt({ type: 'agent-turn-complete', 'thread-id': 't3' });                 // a helper agent's
  notifyGpt({ type: 'something-else', 'thread-id': 't1' });
  const notes = fs.readFileSync(path.join(cm, 'notes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(notes.map((n) => [n.kind, n.id, n.title, n.project, n.gpt]), [['done', 't1', '修复登录', path.basename(work), true], ['ask', 't1', '修复登录', path.basename(work), true]]);
  assert.equal(fs.readdirSync(path.join(cm, 'inbox')).length, 2);
  fs.rmSync(root, { recursive: true, force: true });
  // Running ones, by their markers (gpt-live/<pid>.json), in a ROOT of its own: a live Codex's marker bound to the thread made
  // in its folder since it started, that thread listed running (in a terminal window: not web); a dead one's marker
  // dropped. The first notify binds a marker not bound yet, and its note gives the island that Codex's pid
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-')), cm2 = path.join(root2, '.claude-multi'), marks = path.join(cm2, 'gpt-live');
  fs.mkdirSync(marks, { recursive: true }); fs.writeFileSync(path.join(cm2, 'island.ps1.pid'), String(process.pid));
  const env2 = { ...process.env, USERPROFILE: root2, HOME: root2, CODEX_HOME: home }, cli = path.join(__dirname, 'claude-multi.js');
  const keep = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']); // a Codex running
  const mark = path.join(marks, `${keep.pid}.json`), unbound = () => fs.writeFileSync(mark, j({ pid: keep.pid, home, cwd: work, since: 0, id: null, web: false }));
  unbound();
  fs.writeFileSync(path.join(marks, '999999.json'), j({ pid: 999999, home, cwd: work, since: 0, id: null })); // its Codex gone (no such pid)
  const listed = require('child_process').spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${j(cli)}).listGpt({ gpt: [{ home: ${j(home)} }] }).map((s) => [s.id, s.pid, s.web])))`],
    { env: env2, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(listed.stdout), [['t1', keep.pid, false]], listed.stderr);
  assert.deepEqual([fs.readdirSync(marks), JSON.parse(fs.readFileSync(mark, 'utf8')).id], [[`${keep.pid}.json`], 't1']);
  // one started after its thread was made, which opened it from Codex's own resume list: bound by the thread's lock file,
  // made when a Codex takes it (none: not bound)
  const later = () => fs.writeFileSync(mark, j({ pid: keep.pid, home, cwd: work, since: Date.now(), id: null, web: false }));
  const listing = () => JSON.parse(require('child_process').spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${j(cli)}).listGpt({ gpt: [{ home: ${j(home)} }] }).map((s) => [s.id, s.pid])))`], { env: env2, encoding: 'utf8' }).stdout);
  later();
  assert.deepEqual(listing(), [['t1', null]]);
  fs.mkdirSync(path.join(home, 'thread-writer-locks')); fs.writeFileSync(path.join(home, 'thread-writer-locks', 't1.lock'), '');
  assert.deepEqual([listing(), JSON.parse(fs.readFileSync(mark, 'utf8')).id], [[['t1', keep.pid]], 't1']);
  fs.rmSync(path.join(home, 'thread-writer-locks'), { recursive: true });
  unbound();
  require('child_process').spawnSync(process.execPath, [cli, 'notify', 'gpt', j({ type: 'agent-turn-complete', 'thread-id': 't1' })], { env: env2 });
  const card = JSON.parse(fs.readFileSync(path.join(cm2, 'inbox', fs.readdirSync(path.join(cm2, 'inbox'))[0]), 'utf8'));
  assert.deepEqual([JSON.parse(fs.readFileSync(mark, 'utf8')).id, card.pid, card.gpt], ['t1', keep.pid, true]);
  keep.kill();
  fs.rmSync(root2, { recursive: true, force: true });
  // Codex on a question of its own (a new account's first start: its plugins' hooks to trust), not at its input box: the
  // 管家 is told its first line instead of typing into it; at the input box, or still starting, nothing to tell
  const { codexBlocked } = require('./claude-multi');
  assert.equal(codexBlocked(['', '  Hooks need review', '  3 hooks are new or changed.', '› 1. Review hooks', '  2. Trust all and continue', '  enter confirm · esc skip']), 'Hooks need review');
  assert.equal(codexBlocked(['>_ OpenAI Codex (v0.166.0)', '› Ask Codex to do anything', '  GPT-6-Astra max · ~\\Desktop\\x', '  ? for shortcuts']), null);
  assert.equal(codexBlocked(['>_ OpenAI Codex (v0.166.0) loading']), null);
  assert.equal(codexBlocked(null), null);
  // what the page sends a Codex: the paste marks gone, a new line inside the words as Shift+Enter; keys alone untouched
  const { codexKeys } = require('./claude-multi');
  const SE = '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_';
  assert.deepEqual(codexKeys('\x1b[200~第一行\r第二行\x1b[201~'), { data: `第一行${SE}第二行`, words: true });
  assert.deepEqual(codexKeys('a\r\nb\nc'), { data: `a${SE}b${SE}c`, words: true });
  assert.deepEqual(codexKeys('\r'), { data: '\r', words: false });
  assert.deepEqual(codexKeys('\x1b[B'), { data: '\x1b[B', words: false });
  assert.deepEqual(codexKeys('\x03'), { data: '\x03', words: false });
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true });
  console.log('gpt ok');
}

// GPT 聊天: a message as OpenAI takes it (a picture as one, a known file by its type, any text file as text/plain, a
// binary one refused, its uploaded name back); an answer's words; a chat's messages as the 对话 view takes a record's
{
  const fs = require('fs'), path = require('path'), os = require('os');
  const { oaiInput, oaiText, oaiItems } = require('./claude-multi');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-oai-')), f = (n, data) => { fs.writeFileSync(path.join(d, n), data); return path.join(d, n); };
  const png = f('20261108T101010-abcdef.png', Buffer.from('89504e47', 'hex')), pdf = f('20261108T101010-abcdef-报告.pdf', '%PDF-1.4');
  const py = f('20261108T101010-abcdef-x.py', 'print(1)'), bin = f('20261108T101010-abcdef-x.exe', Buffer.from([77, 90, 0, 1]));
  const parts = oaiInput('看看这些', [png, pdf, py]);
  assert.deepEqual(parts.map((p) => p.type), ['input_text', 'input_image', 'input_file', 'input_file']);
  assert.equal(parts[1].image_url, 'data:image/png;base64,iVBORw==');
  assert.equal(parts[2].filename, '报告.pdf'); assert.match(parts[2].file_data, /^data:application\/pdf;base64,/);
  assert.match(parts[3].file_data, /^data:text\/plain;base64,/);
  assert.deepEqual(oaiInput('', [png]).map((p) => p.type), ['input_image']);
  assert.throws(() => oaiInput('x', [bin]), /x\.exe：GPT 读不了/);
  assert.equal(oaiText({ output: [{ type: 'reasoning' }, { type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: '答案 ([a.com](https://a.com))' }] }] }), '答案 ([a.com](https://a.com))');
  assert.equal(oaiText({ output: [] }), '');
  assert.deepEqual(oaiItems({ msgs: [{ role: 'user', text: '看看', files: [png, pdf], at: 1 }, { role: 'claude', text: '好', at: 2, took: 65000 }, { role: 'note', text: '已停止', at: 3 }] }), [
    { role: 'img', text: '0.0', at: 1 }, { role: 'user', text: `看看\n附件：${pdf}`, at: 1 }, { role: 'claude', text: '好', at: 2 }, { role: 'done', text: '65000' }, { role: 'note', text: '已停止', at: 3 }]);
  fs.rmSync(d, { recursive: true, force: true });
  console.log('gpt chat ok');
}

// GPT 聊天 for the 管家, as commands in a ROOT of its own: listed by sessions --all (oai), read with chat look (its mode
// and effort, its last answer, what came after it); a bad effort refused, a second message while it answers refused, no
// questions to pick — all before the web service is asked (none runs here)
{
  const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-')), dir = path.join(root, '.claude-multi', 'oai');
  fs.mkdirSync(dir, { recursive: true });
  const chat = (o) => fs.writeFileSync(path.join(dir, 'oai-1.json'), JSON.stringify({ id: 'oai-1', title: '量子纠缠', at: 2, resp: 'r1',
    msgs: [{ role: 'user', text: '量子纠缠是什么', files: [], at: 1 }, { role: 'claude', text: '是一种关联。', at: 2 }, { role: 'note', text: '已停止，这一条不算进对话', at: 3 }], ...o }));
  const cli = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'claude-multi.js'), ...a], { env: { ...process.env, USERPROFILE: root, HOME: root }, encoding: 'utf8' }).stdout.trim();
  chat({ opts: { mode: 'pro', effort: 'max' } });
  assert.deepEqual(JSON.parse(cli('sessions', '--json', '--all')).filter((s) => s.oai).map((s) => [s.id, s.title, s.busy, s.who]), [['oai-1', '量子纠缠', false, 'GPT 聊天']]);
  assert.equal(cli('chat', 'look', '量子'), '「量子纠缠」 oai-1\nGPT 聊天 · Pro · max · 空闲\n\n最后的回答：\n是一种关联。\n\n（之后：已停止，这一条不算进对话）');
  assert.equal(cli('chat', 'say', 'oai-1', '再说说', '--effort', 'none'), '--mode 是 standard 或 pro，--effort 是 low、medium、high、xhigh、max 之一');
  assert.equal(cli('chat', 'pick', 'oai-1', '1'), 'GPT 聊天不会问选择题');
  chat({ pending: 'resp_x', since: Date.now() - 120000 });
  assert.match(cli('chat', 'look', 'oai-1'), /^「量子纠缠」 oai-1\nGPT 聊天 · 普通 · medium · 正在回答（已经 2 分钟）/);
  assert.equal(cli('chat', 'say', 'oai-1', '再说说'), '「量子纠缠」还在回答上一条：它答完网页服务会告诉你，之后再发');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('gpt chat for the 管家 ok');
}

// A picture in a record: history() names it by its line's place in bytes and which picture it is, recordImage() gives
// it back. A picture from the page is saved under a new name; ones older than a week go.
{
  const fs = require('fs'), path = require('path'), os = require('os');
  const { history, recordImage, saveUpload } = require('./claude-multi');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-img-')), f = path.join(d, 'r.jsonl');
  const png = Buffer.from('89504e470d0a1a0a', 'hex'), ts = new Date().toISOString();
  const line = (content) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content } });
  const pic = (type, data) => ({ type: 'image', source: { type: 'base64', media_type: type, data } });
  fs.writeFileSync(f, `${line('你好，世界')}\n${line([{ type: 'text', text: '[Image #1] [Image #2] 看图' }, pic('image/png', png.toString('base64')), pic('image/jpeg', 'AAAA')])}\n`);
  const items = history(f).items;
  assert.deepEqual(items.map((m) => m.role), ['user', 'img', 'img', 'user']);  // the pictures above the words
  const ref = (m) => m.text.split('.').map(Number);
  assert.deepEqual(ref(items[2]), [Buffer.byteLength(line('你好，世界')) + 1, 1]); // bytes, not characters
  assert.deepEqual(recordImage(f, ...ref(items[1])), { type: 'image/png', data: png });
  assert.equal(recordImage(f, ...ref(items[2])).type, 'image/jpeg');
  assert.throws(() => recordImage(f, ref(items[2])[0], 2));                    // no third one
  // one sent while Claude was at work, with a picture: its prompt is parts, not text (was shown "[object Object],...")
  const q = JSON.stringify({ type: 'attachment', timestamp: ts, attachment: { type: 'queued_command', origin: { kind: 'human' },
    prompt: [{ type: 'text', text: '[Image #3]这个也是 bug' }, pic('image/png', png.toString('base64'))] } });
  fs.appendFileSync(f, q + '\n');
  const more = history(f).items.slice(4);
  assert.deepEqual(more.map((m) => [m.role, m.role === 'user' ? m.text : '']), [['img', ''], ['user', '[Image #3]这个也是 bug']]);
  assert.deepEqual(recordImage(f, ...ref(more[0])), { type: 'image/png', data: png });
  // stopped before Claude took it in: the next message hangs on the same line, and only that one is shown (its picture too)
  const typed = (uuid, content) => JSON.stringify({ type: 'user', uuid, parentUuid: 'turn-end', timestamp: ts, message: { role: 'user', content } });
  fs.appendFileSync(f, `${typed('s1', [{ type: 'text', text: '[Image #4] 测试' }, pic('image/png', 'AAAA')])}\n${typed('s2', '测')}\n${typed('s3', '真正要问的')}\n`);
  const last = history(f).items.slice(6);
  assert.deepEqual(last.map((m) => [m.role, m.text, m.u]), [['user', '真正要问的', 's3']]);
  assert.equal(last[0].p, 'turn-end');
  // one Claude answered, then you went back and asked again on the same line: both stay, the answer has its question
  const said = (uuid, parentUuid, text) => JSON.stringify({ type: 'user', uuid, parentUuid, timestamp: ts, message: { role: 'user', content: text } });
  const answer = JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'r1', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: '答' }] } });
  fs.appendFileSync(f, `${said('r1', 'x', '先问这个')}\n${answer}\n${said('r2', 'x', '改问这个')}\n`);
  assert.deepEqual(history(f).items.slice(7).map((m) => m.text), ['先问这个', '答', '改问这个']);
  // a first look that starts at the replacement: the look before it ends before the stopped ones (they don't come back)
  const t4 = history(f, { keep: 4 }), prior = history(f, { end: t4.start, keep: 1000 });
  assert.equal(t4.items[0].text, '真正要问的');
  assert.ok(prior.items.length && !prior.items.some((m) => m.u === 's1' || m.u === 's2'));
  // what another Claude session (a teammate, a subagent) sent this one: not shown as yours
  fs.appendFileSync(f, `${said('tm1', 'r2', 'Another Claude session sent a message:\n<teammate-message teammate_id="speed-test">\n测速已启动\n</teammate-message>\n\nThis came from another Claude session')}\n`);
  assert.equal(history(f).items.at(-1).text, '改问这个');
  const up = path.join(d, 'up'), old = path.join(up, 'old.png');
  fs.mkdirSync(up); fs.writeFileSync(old, 'x'); fs.utimesSync(old, new Date(0), new Date(0));
  const saved = saveUpload(png, 'png', up);
  assert.ok(fs.readFileSync(saved).equals(png) && saved.endsWith('.png') && !fs.existsSync(old));
  const doc = saveUpload(Buffer.from('pdf'), null, up, '..\\..\\报告 v1.pdf');
  assert.ok(path.dirname(doc) === up && /^\d{8}T\d{6}-[0-9a-f]{6}-报告 v1\.pdf$/.test(path.basename(doc)));
  assert.ok(/-a_b_\.txt$/.test(saveUpload(Buffer.from(''), null, up, 'a<b>.txt')) && /[0-9a-f]{6}\.bin$/.test(saveUpload(Buffer.from(''), null, up, '..')));
  fs.rmSync(d, { recursive: true, force: true });
  console.log('image ok');
}

// The status bar's numbers: the status line's (kept per conversation, rewritten only when they change) and when the last
// model request began (the record's last user line, not a subagent's), for the cache's hour.
{
  const fs = require('fs'), path = require('path'), os = require('os');
  const { saveLine, readLine, lastReq } = require('./claude-multi');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-line-'));
  const input = { session_id: 'abc-1', model: { display_name: 'Opus 5.5' }, effort: { level: 'xhigh' }, context_window: { used_percentage: 41.6 } };
  saveLine(input, d);
  assert.deepEqual(readLine('abc-1', d), { model: 'Opus 5.5', effort: 'xhigh', ctx: 41.6 });
  const f = path.join(d, 'abc-1.json'); fs.utimesSync(f, new Date(0), new Date(0));
  saveLine(input, d); assert.equal(fs.statSync(f).mtimeMs, 0);                  // the same: not written
  saveLine({ ...input, session_id: '../x' }, d); assert.equal(readLine('../x', d), null); // not a session id: nothing
  assert.equal(readLine('nope', d), null);
  fs.rmSync(d, { recursive: true, force: true });
  const l = (o) => JSON.stringify(o);
  const tail = [l({ type: 'user', timestamp: '2026-10-30T10:00:00.000Z' }), l({ type: 'assistant', timestamp: '2026-10-30T10:00:05.000Z' }),
    l({ type: 'user', timestamp: '2026-10-30T10:01:00.000Z', message: { content: [{ type: 'tool_result' }] } }),
    l({ type: 'user', isSidechain: true, timestamp: '2026-10-30T10:02:00.000Z' }), l({ type: 'assistant', timestamp: '2026-10-30T10:03:00.000Z' })].join('\n');
  assert.equal(lastReq(tail), Date.parse('2026-10-30T10:01:00.000Z'));         // the tool result, not the subagent's line
  assert.equal(lastReq('{"type":"assistant"}'), null);
  console.log('line ok');
}

// Phone notifications: the encryption is RFC 8291's own example (Appendix A), byte for byte; the signature checks out
// with the public key the page subscribes with.
{
  const { pushBody, pushAuth, pushPublic } = require('./claude-multi');
  const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  const body = pushBody(keys, 'When I grow up, I want to be a watermelon', Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'), Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'));
  assert.equal(body.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  const crypto = require('crypto'), jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  const [, t, k] = /^vapid t=(.+), k=(.+)$/.exec(pushAuth('https://web.push.apple.com/abc', jwk));
  const [h, c, s] = t.split('.'), claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(k, pushPublic(jwk));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  console.log('push ok');
}

// The 管家's chat commands: a time to wake at
{
  const { parseUntil } = require('./claude-multi');
  const now = new Date(2026, 10, 3, 14, 0).getTime();
  assert.equal(parseUntil('15:40', now), new Date(2026, 10, 3, 15, 40).getTime());
  assert.equal(parseUntil('9:05', now), new Date(2026, 10, 4, 9, 5).getTime()); // past today: tomorrow's
  assert.throws(() => parseUntil('soon', now));
  console.log('chat ok');
}

// What's on Claude's screen (screen.js, the page's and the 管家's): a question's options, the trust question, and
// "❯ 4. …" in the input box (your words, not a menu)
{
  const { parseScreen } = require('./screen.js'), rule = '─'.repeat(30);
  const m = parseScreen(['Which color?', '', '❯ 1. Red', '     warm', '  2. Blue', '', 'Enter to select · Esc to cancel']).menu;
  assert.deepEqual([m.cur, m.ask, m.opts.map((o) => o.label).join('|'), m.opts[0].desc], [1, 'Which color?', 'Red|Blue', 'warm']);
  const t = parseScreen(['Quick safety check: Is this a project you trust?', '', '❯ No, exit', '  Yes, I trust this folder', '', 'Enter to confirm · Esc to cancel']).menu;
  assert.deepEqual([t.cur, t.opts.map((o) => o.label).join('|')], [1, 'No, exit|Yes, I trust this folder']);
  assert.equal(parseScreen(['1. 签字', '2. 压缩', '3. 上传', rule, '❯ 4. 保存回执截图', rule]).menu, null);
  const h = parseScreen([rule, ' ☐ 优先级', '', '今天想先做哪件事？', '', '❯ 1. 写论文', '  2. 跑实验', '', 'Enter to select']).menu;
  assert.deepEqual([h.head, h.ask], ['优先级', '今天想先做哪件事？']); // one question's header, apart from it
  console.log('screen ok');
}

// A phone notification: what happened in its title, Claude's answer (its opening words) under it
{
  const { gist, pushText } = require('./claude-multi'), l = (o) => JSON.stringify(o);
  const say = (text, x = {}) => l({ type: 'assistant', ...x, message: { content: [{ type: 'text', text }] } });
  const tool = l({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } });
  const tail = [say('我先看看代码'), tool, l({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }),
    say('改好了，刷新网页就能看到，服务不用重启。\n\n| a | b |\n|---|---|\n| 1 | 2 |')].join('\n');
  assert.equal(gist(tail), '改好了，刷新网页就能看到，服务不用重启。');               // the answer's opening, not the table
  assert.equal(gist(say('好的。\n\n**原因**\n\n文件已经存好了，在 **E:\a.md**。')), '好的。 文件已经存好了，在 E:\a.md。'); // a short one: the next words, not the heading
  assert.equal(gist([say('真正的回答在这里，写得够长。'), say('No response requested.')].join('\n')), '真正的回答在这里，写得够长。');
  assert.equal(gist([say('主对话的回答，写得够长一些。'), say('子任务的话', { isSidechain: true })].join('\n')), '主对话的回答，写得够长一些。');
  assert.ok(gist(say('长'.repeat(400))).endsWith('…'));
  assert.deepEqual(pushText({ kind: 'done', title: 'rag检索', gist: '跑完了' }), { title: '✅ rag检索', body: '跑完了' });
  assert.deepEqual(pushText({ kind: 'ask', title: 'rag检索', msg: '想使用 Bash，等你确认', gist: '要删旧文件' }), { title: '⏸ rag检索 等你确认', body: '想用 Bash。要删旧文件' });
  assert.deepEqual(pushText({ kind: 'ask', project: 'helper', msg: 'Claude needs your permission' }), { title: '⏸ helper 等你确认', body: '打开看看它在问什么' });
  console.log('push text ok');
}

// What Bark gets: the subtitle, a group per conversation, a question time-sensitive with its own sound, a tap's page.
{
  const { barkMsg } = require('./claude-multi');
  assert.deepEqual(barkMsg({ title: '✅ rag检索', body: '跑完了', sub: '智能体rag · 账号 3', group: 'rag检索', id: 'ab' }, 'https://h'),
    { title: '✅ rag检索', subtitle: '智能体rag · 账号 3', body: '跑完了', group: 'rag检索', icon: 'https://h/icon-180.png', url: 'https://h/?open=ab' });
  const ask = barkMsg({ title: '⏸ x 等你确认', body: 'b', ask: true });
  assert.equal(ask.level, 'timeSensitive'); assert.equal(ask.sound, 'bell'); assert.equal(ask.group, 'Claude');
  assert.ok(!('subtitle' in ask) && !('icon' in ask)); // no line under the title when there's nothing to say; no page link off https
  console.log('bark ok');
}

// The 管家's tickets: what you asked for can't be changed; where one stands comes from what happened (a turn ended with
// no report: 停下了; a question or 做完 counts for the turn it was said in), never from words; the notice; its waits
{
  const { ticketOp, stageOf, butlerNotice, waitsNow } = require('./claude-multi'), os = require('os'), path = require('path');
  const all = [], op = (b, at) => ticketOp(all, b, at);
  const t = op({ op: 'new', name: '声速场 Stage 4', ask: '把声速场做到成熟', done: '实验方案定了' }, 1);
  assert.equal(t.id, 1);
  assert.deepEqual(stageOf(t, null), ['没派人', 'queue', '']);
  assert.throws(() => op({ op: 'new', name: '没原话' }, 1));
  assert.deepEqual(stageOf(op({ op: 'new', name: '它想到的', ask: '（管家自己提的）', inferred: true }, 1), null)[0], '建议');
  op({ op: 'give', id: 1, conv: 'c1', title: '声速场' }, 2);
  const s = (o) => ({ id: 'c1', pid: 9, busy: false, wait: false, ...o });
  assert.equal(stageOf(t, s({ busy: true }))[0], '在做');
  assert.equal(stageOf(t, s({ wait: true }))[0], '等确认');
  t.ev.push({ at: 5, k: 'stop', text: '下一步我会跑 Stage 4' }); // a turn ended, nothing reported: it has stopped
  assert.deepEqual(stageOf(t, s()), ['停下了', 'idle', '下一步我会跑 Stage 4']);
  assert.deepEqual(stageOf(t, s({ pid: null })), ['停下了', 'idle', '没在运行']);
  op({ op: 'report', id: '1-1', k: 'ask', text: '用哪种设备？' }, 6);
  assert.equal(stageOf(t, s())[0], '停下了'); // said in a turn not ended yet
  t.ev.push({ at: 7, k: 'stop', text: '……' });
  assert.deepEqual(stageOf(t, s()), ['等你回答', 'you', '用哪种设备？']);
  t.ev.push({ at: 9, k: 'stop', text: '按你说的设备开始了' }); // answered: a new turn, the question gone
  assert.equal(stageOf(t, s())[0], '停下了');
  op({ op: 'report', id: '1-1', k: '卡住', text: '额度用完' }, 10); t.ev.push({ at: 11, k: 'stop', text: '' });
  assert.deepEqual(stageOf(t, s()).slice(0, 2), ['卡住了', 'stuck']);
  op({ op: 'report', id: '1-1', k: '做完', text: '方案写好了' }, 12); t.ev.push({ at: 13, k: 'stop', text: '' });
  assert.deepEqual(stageOf(t, s()), ['等你验收', 'you', '方案写好了']);
  assert.throws(() => op({ op: 'report', id: '1-1', k: '进行中', text: 'x' }, 14)); // only the words it knows
  assert.throws(() => op({ op: 'report', id: 9, k: '做完', text: 'x' }, 14));
  const n = butlerNotice([{ t, st: stageOf(t, s()) }, { t: { id: 2, name: '层析' }, st: ['停下了', 'idle', '下一步写理论稿'] }]);
  assert.ok(n.startsWith('[系统通知]') && n.includes('#1「声速场 Stage 4」等用户验收：方案写好了；#2「层析」停下了：下一步写理论稿'), n);
  assert.equal(op({ op: 'give', id: 1, conv: 'c9', ask: '改掉', name: '改掉' }, 14).ask, '把声速场做到成熟'); // never changed (given again: it starts clean)
  op({ op: 'end', id: 1, how: 'done', text: '交给你了' }, 15);
  assert.deepEqual(stageOf(t, s()), ['完成', 'end', '交给你了']);
  assert.throws(() => op({ op: 'report', id: '1-1', k: '做完', text: 'x' }, 16)); // ended
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waits-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ pid: process.pid, at: 1, until: 9, note: '活的' }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ pid: 999999, at: 2, until: 5, note: '死的' }));
  assert.deepEqual(waitsNow(dir).map((w) => w.note), ['活的']);
  assert.ok(!fs.existsSync(path.join(dir, 'b.json'))); // dropped
  fs.rmSync(dir, { recursive: true });
  console.log('butler tickets ok');
}

// What review of the first version found: a conversation does one open ticket at a time (two tickets on it took each
// other's turns); a ticket given again counts only what the new one did; one the list says is at work (the list is read
// up to 3 s ago) is kept for the 管家, not dropped; nothing is started in the claude-multi in use, or a folder in it
{
  const { ticketOp, stageOf, tellSplit, inLive } = require('./claude-multi'), path = require('path');
  const all = [], op = (b, at) => ticketOp(all, b, at), s = (id, o) => ({ id, pid: 9, busy: false, wait: false, ...o });
  const a = op({ op: 'new', name: 'A', ask: 'a' }, 1), b = op({ op: 'new', name: 'B', ask: 'b' }, 1);
  op({ op: 'give', id: a.id, conv: 'c1' }, 2);
  op({ op: 'report', id: `${a.id}-1`, k: '做完', text: 'A 好了' }, 3); a.ev.push({ at: 4, k: 'stop', text: '' });
  assert.throws(() => op({ op: 'give', id: b.id, conv: 'c1' }, 5), /#1/); // c1 has A open
  assert.equal(stageOf(a, s('c1'))[0], '等你验收'); // A as it was
  assert.throws(() => op({ op: 'give', id: a.id, conv: 'c1' }, 5), /chat say/); // already on it: its worker's number stays
  op({ op: 'end', id: a.id, how: 'done' }, 6);
  op({ op: 'give', id: b.id, conv: 'c1' }, 7); // A ended: c1 free
  // B given to c2 after c1 got stuck on it: c1's 卡住 isn't c2's
  op({ op: 'report', id: `${b.id}-1`, k: '卡住', text: 'c1 卡住' }, 8); b.ev.push({ at: 9, k: 'stop', text: '' });
  assert.equal(stageOf(b, s('c1'))[0], '卡住了');
  op({ op: 'give', id: b.id, conv: 'c2' }, 10);
  assert.deepEqual(stageOf(b, s('c2')), ['停下了', 'idle', '']); // nothing from c2 yet
  b.ev.push({ at: 11, k: 'stop', text: 'c2 做了一轮' });
  assert.deepEqual(stageOf(b, s('c2')), ['停下了', 'idle', 'c2 做了一轮']);
  // queued for the 管家: one at work kept, one stopped told, one ended dropped
  const c = op({ op: 'new', name: 'C', ask: 'c' }, 12); op({ op: 'give', id: c.id, conv: 'c3' }, 12);
  const r = tellSplit([a.id, b.id, c.id, 99], all, [s('c2'), s('c3', { busy: true })]);
  assert.deepEqual(r.items.map((o) => o.t.id), [b.id]);
  assert.deepEqual(r.keep, [c.id]);
  // the claude-multi in use: itself and folders in it, not those beside it or above it
  const here = __dirname; // the test runs from the code's own folder
  assert.ok(inLive(here) && inLive(path.join(here, 'butler')) && inLive(here + path.sep));
  assert.ok(!inLive(here + '-dev') && !inLive(path.dirname(here)) && !inLive(path.join(here, '..', 'x')) && !inLive(path.join(require('os').tmpdir(), 'paper_fast'))); // not a Windows path: on Linux that was a folder in this one
  console.log('ticket review ok');
}

// The second review: a conversation a ticket was taken from can't report for it; a notice's tries are counted for each
// ticket; the notes a restart came between are still taken (from where the last service left off); a link to the
// claude-multi in use is it
{
  const { ticketOp, stageOf, tellAgain, readSeen, allNotes, notesUnseen, notesInto, inLive } = require('./claude-multi'), os = require('os'), path = require('path');
  const all = [], op = (b, at) => ticketOp(all, b, at), s = (id) => ({ id, pid: 9, busy: false, wait: false });
  const t = op({ op: 'new', name: 'T', ask: 't' }, 1);
  op({ op: 'give', id: t.id, conv: 'c1', n: 1 }, 2);
  assert.throws(() => op({ op: 'give', id: t.id, conv: 'c2', n: 1 }, 3), /改派/); // its brief said 1-1: given since
  assert.throws(() => op({ op: 'report', id: `${t.id}`, k: '做完', text: 'x' }, 3), /改派/); // no number: not this give's
  op({ op: 'give', id: t.id, conv: 'c2', n: 2 }, 4);
  assert.throws(() => op({ op: 'report', id: `${t.id}-1`, k: '做完', text: 'c1 迟到的结果' }, 5), /改派/); // c1, late
  t.ev.push({ at: 6, k: 'stop', text: 'c2 停了' });
  assert.deepEqual(stageOf(t, s('c2')), ['停下了', 'idle', 'c2 停了']); // not c1's 做完
  op({ op: 'report', id: `${t.id}-2`, k: '做完', text: 'c2 的结果' }, 7); t.ev.push({ at: 8, k: 'stop', text: '' });
  assert.deepEqual(stageOf(t, s('c2')), ['等你验收', 'you', 'c2 的结果']);
  // tries for each ticket: 1 missed three times (told again twice, then dropped), 2 still gets its two
  const tries = new Map();
  assert.deepEqual(tellAgain(tries, [1]), [1]); assert.deepEqual(tellAgain(tries, [1]), [1]); assert.deepEqual(tellAgain(tries, [1]), []);
  assert.deepEqual(tellAgain(tries, [2, 1]), [2, 1]); // 1 dropped last time: counted from the start again
  // notes: after where the last service left off (a restart in between), 1.5 s old at least, oldest first
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seen-')), f = path.join(dir, 'tickets-seen.json');
  assert.equal(readSeen(f), 0); // never saved: from the start (safe: a note taken twice changes nothing)
  fs.writeFileSync(f, '100');
  assert.equal(readSeen(f), 100); // the last service's
  const notes = [{ at: 90, id: 'c2', kind: 'done' }, { at: 200, id: 'c2', kind: 'done' }, { at: 300, id: 'c9', kind: 'ask' }, { at: 5000, id: 'c2', kind: 'done' }]; // oldest first, as in the file
  assert.deepEqual(notesUnseen(notes, 100, 5500).map((n) => n.at), [200, 300]); // 90 taken already, 5000 too new
  const tk = [{ id: 1, conv: 'c2', ev: [{ at: 50, k: 'give' }] }, { id: 2, conv: 'c9', ev: [] }, { id: 3, conv: 'c2', ev: [], end: { at: 1 } }];
  assert.deepEqual(notesInto(tk, notesUnseen(notes, 100, 5500), (id) => `${id} 的最后一句`), [1, 2]);
  assert.deepEqual(tk[0].ev.slice(1), [{ at: 200, k: 'stop', text: 'c2 的最后一句' }]); // a turn ended: kept
  assert.deepEqual(tk[1].ev, [{ at: 300, k: 'held', text: '' }]); // stopped on a question: kept as held
  assert.deepEqual(tk[2].ev, []); // ended: left alone
  // taken again (the tickets were saved, the place wasn't, when the service ended): nothing changes, no news
  assert.deepEqual(notesInto(tk, notesUnseen(notes, 100, 5500), () => '又一次'), []); // the same notes, from the same place
  assert.equal(tk[0].ev.length, 2); assert.equal(tk[1].ev.length, 1);
  // so a ticket waiting for your review stays so (a second stop at the same time made it 停下了)
  const r = { id: 4, conv: 'c4', n: 1, ev: [{ at: 10, k: 'give' }, { at: 20, k: '做完', text: '好了' }] };
  notesInto([r], [{ at: 30, id: 'c4', kind: 'done' }], () => ''); notesInto([r], [{ at: 30, id: 'c4', kind: 'done' }], () => '');
  assert.deepEqual(stageOf(r, s('c4')), ['等你验收', 'you', '好了']);
  // one from before the ticket was given to this conversation isn't its
  assert.deepEqual(notesInto([{ id: 5, conv: 'c5', ev: [{ at: 100, k: 'give' }] }], [{ at: 100, id: 'c5', kind: 'done' }, { at: 60, id: 'c5', kind: 'done' }], () => ''), []);
  // a backlog of any length: 40 notes piled up after the place, all of them read
  const nf = path.join(dir, 'notes.jsonl');
  fs.writeFileSync(nf, Array.from({ length: 45 }, (_, i) => JSON.stringify({ at: 1000 + i, id: 'c2', kind: 'done' })).join('\n') + '\n');
  assert.equal(notesUnseen(allNotes(nf), 1004, 9999).length, 40);
  assert.deepEqual(allNotes(path.join(dir, 'none.jsonl')), []);
  fs.rmSync(nf);
  // a link (a junction on Windows) to the claude-multi in use is it
  const link = path.join(dir, 'link');
  fs.symlinkSync(__dirname, link, 'junction');
  assert.ok(inLive(link) && inLive(path.join(link, 'butler')));
  fs.unlinkSync(link); fs.rmSync(f); fs.rmdirSync(dir); // the link alone (a junction too), never through it
  console.log('ticket review 2 ok');
}

// Whoever set a turn going gets its end: one the 管家 set going (its words, as its log has their first 40) tells the 管家,
// even outside a ticket (it asked rag something and promised to tell you); one you set going yourself doesn't wake it
{
  const { turnBy, notesInto, butlerNotice } = require('./claude-multi');
  const sent = [{ at: 1000, text: '你知道这个项目有没有一个上传/提交的截止日期吗？之前聊过的话帮我确认一下具体是哪' }];
  assert.equal(turnBy('你知道这个项目有没有一个上传/提交的截止日期吗？之前聊过的话帮我确认一下具体是哪天，有的话告诉我', sent, 5000), 'butler');
  assert.equal(turnBy('先看一下：\r\n截止日期是哪天', [{ at: 1000, text: '先看一下：\n截止日期是哪天' }], 5000), 'butler'); // line breaks however kept
  assert.equal(turnBy('就按这个来，帮我部署', sent, 5000), 'you');
  assert.equal(turnBy(null, sent, 5000), null); // nothing read
  assert.equal(turnBy(sent[0].text, sent, 1000 + 7 * 3600e3), 'you'); // its words from long before: typed again since
  assert.equal(turnBy(sent[0].text, sent, 500 - 120000), 'you'); // sent after that turn ended
  const go = [{ at: 1000, text: '继续' }]; // a short one is kept whole: only the very words are its
  assert.equal(turnBy('继续', go, 5000), 'butler');
  assert.equal(turnBy('继续做第三部分', go, 5000), 'you');
  // a ticket's conversation: your own turn is kept (the panel shows it), not news for the 管家; the 管家's is
  const tk = [{ id: 1, conv: 'w', ev: [{ at: 10, k: 'give' }] }], you = { at: 20, id: 'w', kind: 'done' }, its = { at: 30, id: 'w', kind: 'done' };
  assert.deepEqual(notesInto(tk, [you], () => '我跟用户聊完了', (n) => n === you), []);
  assert.equal(tk[0].ev.at(-1).at, 20);
  assert.deepEqual(notesInto(tk, [its], () => '', (n) => n === you), [1]);
  // your own turn in which the worker reported 做完: news all the same (the 管家 checks it and closes the ticket)
  tk[0].ev.push({ at: 35, k: '做完', text: '好了' });
  const you2 = { at: 40, id: 'w', kind: 'done' };
  assert.deepEqual(notesInto(tk, [you2], () => '', () => true), [1]);
  const you3 = { at: 50, id: 'w', kind: 'done' }; // the next of yours, nothing reported in it: not news
  assert.deepEqual(notesInto(tk, [you3], () => '', () => true), []);
  // a reply outside a ticket, alone and beside a ticket's news
  const r = butlerNotice([], [{ title: 'rag检索', kind: 'done', text: '初赛材料的上传截止时间是 11 月 5 日 24:00' }]);
  assert.ok(r.startsWith('[系统通知] 「rag检索」回复了你发的消息：初赛材料的上传截止时间是 11 月 5 日 24:00') && r.includes('告诉用户') && !r.includes('工单有动静'), r);
  const both = butlerNotice([{ t: { id: 2, name: '层析' }, st: ['停下了', 'idle', ''] }], [{ title: 'rag检索', kind: 'ask' }]);
  assert.ok(both.includes('#2「层析」停下了') && both.includes('「rag检索」在你发消息后停在一个确认上'), both);
  // what set the turn going: the last thing typed, from the record's own lines. Claude Code's last-prompt line lags (it
  // came with a tool call): a [系统通知] the 管家 only answered still had 「对」 there, and was noted and pushed as yours
  const { lastTyped } = require('./claude-multi');
  const L = (o) => JSON.stringify(o), at = (s) => `2026-11-04T08:${s}Z`;
  const rec = [
    L({ type: 'user', timestamp: at('24:00'), message: { role: 'user', content: '对' } }),
    L({ type: 'assistant', timestamp: at('24:10'), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
    L({ type: 'user', timestamp: at('24:22'), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    L({ type: 'last-prompt', lastPrompt: '对' }),
    L({ type: 'assistant', timestamp: at('24:42'), message: { content: [{ type: 'text', text: '两个工单都派出去了' }] } }),
    L({ type: 'user', timestamp: at('24:43'), message: { content: '[系统通知] 工单有动静：#1 停下了' } }),
    L({ type: 'assistant', timestamp: at('24:46'), message: { content: [{ type: 'text', text: '不插手。' }] } }),
  ].join('\n') + '\n';
  assert.ok(lastTyped(rec).startsWith('[系统通知]'), lastTyped(rec));
  assert.equal(lastTyped(rec, Date.parse(at('24:30'))), '对'); // what was typed by then
  // not typed: a background task's news, a reminder; a paste unwrapped; one sent while it worked; a picture alone
  const more = (o) => rec + L({ timestamp: at('25:00'), ...o }) + '\n';
  assert.ok(lastTyped(more({ type: 'user', message: { content: '<task-notification><summary>x</summary></task-notification>' } })).startsWith('[系统通知]'));
  assert.ok(lastTyped(more({ type: 'user', isMeta: true, message: { content: 'Caveat: …' } })).startsWith('[系统通知]'));
  assert.equal(lastTyped(more({ type: 'user', message: { content: [{ type: 'text', text: '<pasted_content id="1">\n继续做第三部分\n</pasted_content id="1">' }] } })), '继续做第三部分');
  assert.equal(lastTyped(more({ type: 'attachment', attachment: { type: 'queued_command', prompt: '顺便看一下图 5', origin: { kind: 'human' } } })), '顺便看一下图 5');
  assert.equal(lastTyped(more({ type: 'user', message: { content: [{ type: 'image', source: {} }] } })), '[Image]');
  assert.equal(lastTyped('{"type":"user" cut off\n'), null);
  console.log('turn owner ok');
  // 额度's 电脑: Claude Code's part, from two reads of its processes
  const { claudeShare } = require('./claude-multi');
  const r1 = claudeShare('10 1000 100\r\n11 500 50 C:\\Users\\me\\.local\\bin\\claude.exe\r\n12 9000 900 C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\app-1\\claude.exe\r\n', null, 0, 4);
  assert.deepEqual([r1.cpu, r1.mem, r1.n], [null, 150, 2]); // the first: no CPU yet; the desktop app left out
  const r2 = claudeShare('10 3000 100\n13 1000 70\n', r1.prev, 2000, 4); // 10: 2 s more; 11 ended; 13 new: all its 1 s
  assert.deepEqual([r2.cpu, r2.mem, r2.n], [38, 170, 2]); // 3 s of CPU over 2 s on 4 cores
  console.log('machines ok');
}

// What the 管家 costs, by what set it going: you, a [系统通知], a background task (a tool's result in between keeps
// the one before), a reply counted once however many lines carry it, the watchdog's logged Haiku; by model too
{
  const { butlerCost } = require('./claude-multi'), os = require('os'), path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cost-')), dir = path.join(tmp, 'projects', path.join(__dirname, 'butler').replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const T = new Date().toISOString(), u = (content) => ({ type: 'user', timestamp: T, message: { content } });
  const a = (id, usage) => ({ type: 'assistant', timestamp: T, requestId: 'r' + id, message: { id, model: 'claude-sonnet-5', usage } });
  fs.writeFileSync(path.join(dir, 's.jsonl'), [u('你好'), a('m1', { input_tokens: 1e6 }), a('m1', { input_tokens: 1e6 }), u('\n\n<pasted_content id="a1">\n[系统通知] 有动静\n</pasted_content id="a1">\n'), a('m2', { output_tokens: 1e5 }), // a long notice: a paste
    u([{ type: 'tool_result', content: 'ok' }]), a('m3', { input_tokens: 5e5 }), u('<task-notification>\n<status>completed</status>'), a('m4', { input_tokens: 1e6 })].map((x) => JSON.stringify(x)).join('\n'));
  const log = path.join(tmp, 'events.jsonl');
  fs.writeFileSync(log, JSON.stringify({ timestamp: T, event: 'watchdog', usd: 0.01 }) + '\n');
  const c = butlerCost([{ dir: path.join(tmp, 'projects') }], log).today, r = (x) => Math.round(x * 100) / 100;
  assert.deepEqual([r(c.you), r(c.notice), r(c.bg), r(c.dog), c.n], [2, 2, 2, 0.01, 5]);
  assert.deepEqual(Object.fromEntries(Object.entries(c.models).map(([k, v]) => [k, r(v)])), { 'claude-sonnet-5': 6, 'claude-haiku-4-5': 0.01 });
  fs.rmSync(tmp, { recursive: true, force: true });
  // what the 管家 typed, found under the paste Claude Code wraps a long one in (so it shows as 管家发的)
  const { unwrapPaste } = require('./claude-multi');
  assert.equal(unwrapPaste('<pasted_content id="adb0">\n继续改图。重点：1) 图4\n</pasted_content id="adb0">\n'), '继续改图。重点：1) 图4');
  assert.equal(unwrapPaste('短的不包'), '短的不包');
  console.log('butler cost ok');
}

// A /model or /effort typed into the 管家 saves itself as every new conversation's default: put back as it was (a
// key that wasn't there goes again), the rest of the file kept
{
  const { keepDefaults } = require('./claude-multi'), os = require('os'), path = require('path');
  const f = path.join(os.tmpdir(), `cm-defaults-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ env: { A: '1' }, model: 'opus' }, null, 2) + '\n');
  const back = keepDefaults([f]);
  fs.writeFileSync(f, JSON.stringify({ env: { A: '1' }, model: 'sonnet', effortLevel: 'low' }, null, 2) + '\n');
  back();
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { env: { A: '1' }, model: 'opus' });
  assert.ok(fs.readFileSync(f, 'utf8').endsWith('}\n'));
  keepDefaults([path.join(os.tmpdir(), 'cm-no-such-file.json')])(); // a missing one: nothing
  fs.rmSync(f);
  console.log('defaults kept ok');
}

// From the review (灵动岛审查清单). The commands as the island and the 管家 run them, each in a home of its own: a GPT
// account isn't removed while a Codex runs on it (its marker, there before it has a conversation); usage --json stays JSON
// with GPT accounts only (the island parses it); a record that can't be read (a folder by a record's name: reading it
// fails as reading one deleted mid-look does) is left out and the rest listed (one threw the whole list away, and the
// web service with it)
{
  const path = require('path'), os = require('os'), cp = require('child_process'), cli = path.join(__dirname, 'claude-multi.js');
  const homeOf = (reg) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-')); fs.mkdirSync(path.join(r, '.claude-multi')); fs.writeFileSync(path.join(r, '.claude-multi', 'profiles.json'), JSON.stringify(reg(r))); return r; };
  const run = (root, ...args) => cp.spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, USERPROFILE: root, HOME: root }, encoding: 'utf8' });
  const r1 = homeOf((r) => ({ profiles: [], gpt: [{ id: 'gpt-1', label: 'g@example.com', home: path.join(r, 'gpt-1') }] })), g = path.join(r1, 'gpt-1');
  fs.mkdirSync(g); fs.mkdirSync(path.join(r1, '.claude-multi', 'gpt-live'));
  fs.writeFileSync(path.join(r1, '.claude-multi', 'gpt-live', `${process.pid}.json`), JSON.stringify({ pid: process.pid, home: g, cwd: __dirname, since: Date.now(), id: null }));
  const rm = run(r1, 'remove', 'G1');
  assert.equal(rm.status, 1, rm.stdout);
  assert.match(rm.stdout, /Codex 正在运行/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r1, '.claude-multi', 'profiles.json'), 'utf8')).gpt.length, 1); // still listed
  assert.ok(fs.existsSync(g));                                                                                   // its folder kept
  if (SESSION0) { // no Codex on it now, but from ssh: refused before it leaves the list (its folder would be gone for good)
    fs.rmSync(path.join(r1, '.claude-multi', 'gpt-live', `${process.pid}.json`));
    const rm2 = run(r1, 'remove', 'G1');
    assert.equal(rm2.status, 1, rm2.stdout); assert.match(rm2.stdout, /回收站/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(r1, '.claude-multi', 'profiles.json'), 'utf8')).gpt.length, 1); assert.ok(fs.existsSync(g));
  }
  const u = run(r1, 'usage', '--json'), uj = JSON.parse(u.stdout);
  assert.deepEqual([uj.accounts, uj.rec, uj.open, uj.gpt.map((x) => x.label)], [[], null, false, ['g@example.com']]);
  fs.rmSync(r1, { recursive: true, force: true });
  const r2 = homeOf((r) => ({ profiles: [{ id: 'acct-1', label: 'me@example.com', configDir: path.join(r, 'acct') }] })), f = path.join(r2, 'acct', 'projects', 'f');
  fs.mkdirSync(path.join(f, '00000000-0000-0000-0000-000000000001.jsonl'), { recursive: true });
  fs.writeFileSync(path.join(f, '00000000-0000-0000-0000-000000000002.jsonl'), JSON.stringify({ type: 'user', cwd: __dirname, aiTitle: '读得到的' }) + '\n');
  const ls = run(r2, 'sessions', '--json');
  assert.equal(ls.status, 0, ls.stderr);
  assert.deepEqual(JSON.parse(ls.stdout).map((s) => s.title), ['读得到的']);
  fs.rmSync(r2, { recursive: true, force: true });
  console.log('review commands ok');
}
// A request's JSON in pieces cut inside a character (a Chinese one, an emoji): whole once decoded; past its size, none.
// The page's token counts: an {err} (or the relay's page) is a failure, never kept as the counts; the quota line tells no
// account, none read and all used up apart.
(async () => {
  const { jsonBody } = require('./claude-multi'), b = Buffer.from(JSON.stringify({ text: '中文😀' }));
  for (let at = 0; at <= b.length; at++) assert.deepEqual(await jsonBody([b.subarray(0, at), b.subarray(at)]), { text: '中文😀' });
  assert.deepEqual(await jsonBody([b], b.length), { text: '中文😀' });
  assert.equal(await jsonBody([b], b.length - 1), undefined);
  assert.equal(await jsonBody([b], 8), undefined);
  const src = fs.readFileSync(require('path').join(__dirname, 'web.html'), 'utf8'), part = (re) => src.match(re)[0];
  const answer = (status, j) => async () => ({ status, json: async () => { if (!j) throw new SyntaxError('not JSON'); return j; } });
  const getTokens = (fetch) => new Function('fetch', `${part(/^const getTokens = [\s\S]*?return t; \}\);$/m)}\nreturn getTokens;`)(fetch)();
  await assert.rejects(getTokens(answer(500, { err: '读不了' })), /读不了/);
  await assert.rejects(getTokens(answer(502, null)), /502/);
  assert.deepEqual(await getTokens(answer(200, { accounts: [], days: [] })), { accounts: [], days: [] });
  const shut = new Function(`${part(/^const shut = .*$/m)}\nreturn shut;`)();
  assert.deepEqual([shut({ accounts: [] }), shut({ accounts: [{}], rec: null }), shut({ accounts: [{}], rec: 0, ready: '2小时' })], ['还没有 Claude 账号', '额度暂时读不到', '都到上限了，2小时后恢复']);
  console.log('review page ok');
})();

// PR 21 follow-up: exercise the real handlers with in-memory terminals and pages, without a web server or a CLI login.
(async () => {
  const vm = require('vm'), path = require('path'), { Writable } = require('stream');
  const js = fs.readFileSync(path.join(__dirname, 'claude-multi.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, 'web.html'), 'utf8');
  const part = (s, a, b) => { const start = s.indexOf(a), end = s.indexOf(b, start + a.length); assert.ok(start >= 0 && end > start, a); return s.slice(start, end); };
  const fn = (s, name, indent = '') => {
    const re = new RegExp(`^${indent}(?:async )?function ${name}\\(`, 'm'), start = s.search(re);
    assert.ok(start >= 0, name); const end = s.indexOf(`\n${indent}}`, start);
    return s.slice(start, end + indent.length + 2);
  };
  const api = (name, next) => '(' + part(js, `'POST /api/${name}': `, `    'POST /api/${next}'`).replace(/^.*?: /, '').replace(/\n    },[\s\S]*$/, '\n    }') + ')';

  const opened = vm.runInNewContext(part(js, 'const opened = async', '\n      const reg') + '\nopened;', { sleep: async () => {} });
  await assert.rejects(opened({ key: 'B', pid: null }), /PID/);
  await assert.rejects(opened({ key: 'B', pid: 22, gone: true }));
  assert.equal((await opened({ key: 'B', pid: 22 })).pid, 22);
  let pid = null, binding = null, written = null, looked = 0;
  const chatNew = vm.runInNewContext(fn(js, 'chatNew') + ';chatNew;', {
    path, fs: { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) }, HOME: 'home',
    sameDir: (a, b) => a === b, inLive: () => false, load: () => ({ profiles: [{ configDir: 'acct' }] }), shareTrust() {},
    webPost: async () => ({ key: 'B', pid }), untilReady: async () => {}, blog() {}, console: { log() {} },
    waitLive: async (match) => { looked++; return [{ pid: 11, sessionId: 'A' }, { pid: 22, sessionId: 'B' }].find(match); },
    typeIn: async (key, live) => { written = [key, live.sessionId]; return true; }
  });
  await assert.rejects(chatNew('project', 'task', 1, (id) => { binding = id; }), /PID/);
  assert.equal(looked, 0); assert.equal(binding, null); assert.equal(written, null);
  pid = 22; await chatNew('project', 'task', 1, (id) => { binding = id; });
  assert.equal(binding, 'B'); assert.deepEqual(written, ['B', 'B']);

  // Existing streams lose access on key rotation, and the close handler releases the client and heartbeat.
  let secret = 'old', beat, close, destroyed = 0, cleared = false, pings = 0;
  const sse = { write() { pings++; } }, terminal = { kind: 'pty', clients: new Set([sse]) };
  vm.runInNewContext('let closed = false; const z = null;\n' + part(js, '        const beat = setInterval', '\n        return;'), {
    req: { headers: { cookie: 'old' }, on: (event, cb) => { assert.equal(event, 'close'); close = cb; } },
    res: { destroy() { destroyed++; } }, sse, t: terminal,
    keyCookie: (v) => v, keyMatch: (a, b) => a === b, webKey: () => secret,
    setInterval: (cb) => { beat = cb; return 42; }, clearInterval: (id) => { assert.equal(id, 42); cleared = true; }
  });
  beat(); assert.equal(pings, 1); assert.equal(destroyed, 0);
  secret = 'new'; beat(); assert.equal(pings, 1); assert.equal(destroyed, 1);
  close(); assert.equal(terminal.clients.size, 0); assert.equal(cleared, true);

  // A desktop mirror must use the owning account's session marker, including a new session with no transcript yet.
  let mirrored = null;
  const open = vm.runInNewContext(api('open', 'switch'), {
    load: () => ({ profiles: [{ configDir: 'acct' }] }), sessions: () => [{ id: 'A', pid: 11, acct: 0, file: 'A.jsonl' }],
    where: () => null, mirror: (pid, dir) => (mirrored = { key: 'w11', kind: 'pc', pid, dir })
  });
  await open(null, { id: 'A' }); assert.equal(mirrored.dir, 'acct');
  let marker = 'B', files = [], corrupt = false;
  const recordOf = vm.runInNewContext(fn(js, 'recordOf', '  ') + ';recordOf;', {
    terms: new Map([['w11', mirrored]]), path, ls: () => ['project'], sessions: () => [],
    fs: { readFileSync: () => { if (corrupt) throw Error('partial marker'); return JSON.stringify({ sessionId: marker }); }, existsSync: (f) => files.includes(path.basename(f)) }
  });
  const query = new URLSearchParams({ key: 'w11', id: 'A' });
  assert.equal(recordOf(query).file, null);
  files = ['B.jsonl']; assert.match(recordOf(query).file, /B\.jsonl$/);
  corrupt = true; assert.match(recordOf(query).file, /B\.jsonl$/);
  corrupt = false; marker = 'C'; assert.equal(recordOf(query).file, null);

  // A Writable can fail after write() returns. The API must await its callback, for both GPT and Claude mirrors.
  const terms = new Map(), inputApi = vm.runInNewContext(api('input', 'resize'), { terms, sleep: async () => {}, codexKeys: require('./claude-multi').codexKeys });
  for (const codex of [true, false]) {
    const stdin = new Writable({ write(chunk, encoding, done) { process.nextTick(() => done(Error('EPIPE'))); } });
    stdin.on('error', () => {});
    terms.set('pc', { kind: 'pc', codex, proc: { stdin } });
    await assert.rejects(inputApi(null, { key: 'pc', data: 'hello' }), /EPIPE/);
  }
  let fail = true, writes = [];
  terms.set('pty', { kind: 'pty', gpt: {}, proc: { write(d) { if (fail) throw Error('closed'); writes.push(d); } } });
  await assert.rejects(inputApi(null, { key: 'pty', data: 'first' }), /closed/);
  fail = false; await inputApi(null, { key: 'pty', data: 'second' }); assert.deepEqual(writes, ['second']);
  let complete;
  const stdin = new Writable({ write(chunk, encoding, done) { complete = done; } }); stdin.on('error', () => {});
  terms.set('slow', { kind: 'pc', codex: true, proc: { stdin } });
  let answered = false; const waiting = inputApi(null, { key: 'slow', data: 'hello' }).then(() => { answered = true; });
  await new Promise(setImmediate); assert.equal(answered, false); complete(); await waiting; assert.equal(answered, true);

  const harness = () => {
    const store = new Map(), context = vm.createContext({ console, setTimeout, clearTimeout, store });
    const run = (s) => vm.runInContext(s, context);
    run(`
      const c = { id: 'A', started: true, ended: false, gpt: false }, drafts = new Map();
      let session = { id: c.id }, conversationGen = 0, key = 'terminal', kind = 'pc', ptySize = null, mine = null, q = Promise.resolve();
      let atts = [], sending = false, stops = 0, lastSent = null, sent = [], liveHtml = '', typing = null, typeOpt = new Map();
      let menuNow = false, typeNow = false, typeTick = false, busyNow = false, view = 'hist', question = false;
      let histNow = false, histEnd = null, histOldest = null, histGen = 0, nextId = 'A', unseen = false;
      const line = { value: '', style: {}, scrollHeight: 0 }, go = { dataset: {} }, messages = [], writes = [];
      const hist = { innerHTML: '', scrollHeight: 1000, scrollTop: 0, clientHeight: 100 };
      const localStorage = { setItem: (k,v) => store.set(k,v), getItem: k => store.get(k) ?? null, removeItem: k => store.delete(k) };
      const noop = () => {}, fitLine = noop, goMode = noop, drawAtts = noop, redraw = noop, markRows = noop, save = noop;
      const claim = async () => {}, toast = t => messages.push(t), shownText = t => t, addItems = noop, topNote = noop, loadOlder = noop;
      const histGet = async () => ({ id: nextId, start: 0, end: 0, items: [] });
      let post = async (url, b) => { writes.push(b.data); };
      let drawLive = () => { menuNow = question; };
      const imagesShown = () => 0;
    `);
    run(part(page, '  const draftKey =', '\n  if (c.id) try'));
    run(part(page, '  const input = (data)', '\n  function claim'));
    run(part(page, '  const cantSend =', '\n  // One message'));
    run(fn(page, 'send', '  ')); run(fn(page, 'loadHist', '  '));
    run(part(page, '  c.say =', '\n  c.close'));
    return { run, store };
  };
  let h = harness();
  h.run("line.value='draft'; atts=[{file:true,name:'keep'}]; busyNow=true;");
  assert.equal(await h.run("c.say('task')"), true);
  assert.equal(h.run('line.value'), 'draft'); assert.equal(h.run('atts[0].name'), 'keep');
  assert.equal(h.run('writes.length'), 2); assert.equal(h.run('writes.includes("\\x1b")'), false);
  h = harness(); h.run("question=true; line.value='draft';");
  assert.equal(await h.run("c.say('task')"), false); assert.equal(h.run('line.value'), 'draft'); assert.equal(h.run('writes.length'), 0);
  h.run('question=false; sending=true;'); assert.equal(await h.run("c.say('task')"), false);
  h = harness(); h.run("line.value='draft'; let redraws=0; drawLive=()=>{ menuNow=++redraws>1; };");
  assert.equal(await h.run("c.say('task')"), true);
  assert.equal(h.run('line.value'), 'task\ndraft'); assert.equal(h.run('writes.length'), 0);
  h = harness(); h.run("line.value='draft'; post=async()=>{ throw Error('offline'); };");
  await h.run("c.say('task')"); assert.equal(h.run('line.value'), 'task\ndraft');

  h = harness(); h.store.set('cm-draft:B', 'draft B');
  h.run("line.value='draft A'; atts=[{file:true,name:'A'}]; sent=[{text:'pending A'}]; lastSent={text:'A'}; nextId='B';");
  await h.run('loadHist()');
  assert.equal(h.run('line.value'), 'draft B'); assert.equal(h.store.get('cm-draft:A'), 'draft A');
  assert.equal(h.run('atts.length + sent.length'), 0); assert.equal(h.run('lastSent'), null);
  h.run("nextId='A';"); await h.run('loadHist()');
  assert.equal(h.run('line.value'), 'draft A'); assert.equal(h.run('atts[0].name'), 'A'); assert.equal(h.run('sent[0].text'), 'pending A');
  h.run("nextId=null;"); await h.run('loadHist()'); assert.equal(h.run('line.value'), '');
  h.run("nextId='B';"); await h.run('loadHist()'); assert.equal(h.run('line.value'), 'draft B');

  // Switch during an upload: no paste or Enter into B; recover text and attachment in A.
  h = harness(); h.store.set('cm-draft:B', 'draft B');
  h.run("line.value='unsent'; let uploadDone; atts=[{file:true,name:'A.txt',up:new Promise(r=>uploadDone=r)}];");
  const sending = h.run('send()'); h.run("nextId='B';"); await h.run('loadHist()');
  h.run("uploadDone('A.txt');"); await sending;
  assert.equal(h.run('writes.length'), 0); assert.equal(h.run('line.value'), 'draft B'); assert.equal(h.run('atts.length'), 0);
  assert.equal(h.store.get('cm-draft:A'), 'unsent');
  h.run("nextId='A';"); await h.run('loadHist()'); assert.equal(h.run('line.value'), 'unsent'); assert.equal(h.run('atts[0].name'), 'A.txt');

  // The first message may get its id before Enter; adopting that id must not cancel the message.
  h = harness(); h.run("c.id=null; session.id=null; nextId='new'; line.value='first'; let uploaded; atts=[{file:true,up:new Promise(r=>uploaded=r)}];");
  const first = h.run('send()'); await h.run('loadHist()'); h.run("uploaded('file.txt');"); await first;
  assert.equal(h.run('writes.length'), 2); assert.equal(h.run('line.value'), '');
  // Even after acquiring its first id, a later switch recovers into that id, never into B.
  h = harness(); h.run("c.id=null; session.id=null; nextId='new'; line.value='first'; let uploaded; atts=[{file:true,up:new Promise(r=>uploaded=r)}];");
  const second = h.run('send()'); await h.run('loadHist()'); h.run("nextId='B';"); await h.run('loadHist()');
  h.run("uploaded('file.txt');"); await second;
  assert.equal(h.store.get('cm-draft:new'), 'first'); assert.equal(h.run('writes.length'), 0); assert.equal(h.run('line.value'), '');
  // A queued key is checked again just before writing, after any previous request finishes.
  h = harness(); h.run('let release; q=new Promise(r=>release=r);');
  const queued = h.run("input('old message')"); h.run("nextId='B';"); await h.run('loadHist()'); h.run('release();');
  assert.equal(await queued, false); assert.equal(h.run('writes.length'), 0);
  // 设置's 管家 switch: on, its file there; off, gone, and the 管家 running here stopped (no other conversation)
  let marked = null; const stopped = [];
  const butlerSwitch = vm.runInNewContext('(' + part(js, "'POST /api/butler': ", "\n    'GET /api/island'").replace(/^.*?: /, '').replace(/,\s*$/, '') + ')', {
    BUTLER_ON: 'on', BUTLER: 'C:/b', sameDir: (a, b) => a === b,
    fs: { writeFileSync: (f) => (marked = f), unlinkSync: (f) => { if (marked !== f) throw new Error('ENOENT'); marked = null; } },
    terms: new Map(['C:/b', 'C:/w'].map((cwd, i) => [i, { kind: 'pty', cwd, proc: { kill: () => stopped.push(cwd) } }])) });
  assert.deepEqual(butlerSwitch(null, { on: true }), { on: true }); assert.equal(marked, 'on'); assert.deepEqual(stopped, []);
  assert.deepEqual(butlerSwitch(null, { on: false }), { on: false }); assert.equal(marked, null); assert.deepEqual(stopped, ['C:/b']);
  assert.deepEqual(butlerSwitch(null, {}), { on: false }); // off again: no file to remove is fine
  // a push whose connection dropped is tried once more (logged only when that fails too); a push service's answer isn't
  const pushLog = [], pushCalls = []; let plan = [];
  const pushAll = vm.runInNewContext(fn(js, 'pushAll') + ';pushAll;', {
    pushStore: () => ({ jwk: {}, subs: [{ endpoint: 'https://fcm.googleapis.com/x', keys: {} }] }), savePush: () => {},
    pushBody: () => 'b', pushAuth: () => 'a', sleep: async () => {}, URL, AbortSignal, log: (e, f) => pushLog.push(`${e} ${f.err ?? f.status}`),
    fetch: async () => { pushCalls.push(1); const p = plan.shift(); if (p instanceof Error) throw p; return { status: p, text: async () => '' }; } });
  const reset = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
  plan = [reset, 201]; assert.deepEqual(await pushAll({}), [201]); assert.equal(pushCalls.length, 2); assert.deepEqual(pushLog, []);
  plan = [reset, reset]; pushCalls.length = 0; assert.deepEqual(await pushAll({}), ['ECONNRESET']); assert.equal(pushCalls.length, 2);
  assert.deepEqual(pushLog, ['push_fail ECONNRESET fetch failed']);
  plan = [410]; pushCalls.length = 0; assert.deepEqual(await pushAll({}), [410]); assert.equal(pushCalls.length, 1);
  // 用量's prices: Fable 5.2 its own (8/40, cache reads 0.2), not the older Fable 5's (cache reads 1) its name also starts with
  const replyCost = vm.runInNewContext(part(js, 'const PRICES', '\nfunction tokenStats') + ';replyCost;');
  assert.equal(replyCost(['k', 'd', 1e6, 1e6, 0, 0, 1e6, 'claude-fable-5-2', false]), 48.2);
  assert.equal(replyCost(['k', 'd', 0, 0, 0, 0, 1e6, 'claude-fable-5-20260101', false]), 0.2); assert.equal(replyCost(['k', 'd', 0, 0, 0, 0, 1e6, 'claude-fable-5', false]), 1);
  // the web service's last guard: a throw before it listens ends it; listening, it's logged (the same once in 10 min) and it goes on
  const guardLog = [], exits = [];
  const guard = (listening) => vm.runInNewContext(part(js, '  const fell = new Map();', '\n  process.on(') + '\nkeepOn;', {
    server: { listening }, log: (e) => guardLog.push(e), console: { error() {} }, process: { exit: (c) => { exits.push(c); throw new Error('exit'); } } });
  assert.throws(() => guard(false)(new Error('EACCES')), /exit/); assert.deepEqual(exits, [1]); assert.deepEqual(guardLog, []);
  const keepOn = guard(true), full = new Error('ENOSPC: no space left on device');
  keepOn(full); keepOn(full); assert.deepEqual(guardLog, ['web_error']);
  keepOn(new Error('another')); keepOn('a rejection that is no Error'); assert.equal(guardLog.length, 3); assert.deepEqual(exits, [1]);
  console.log('review follow-up ok (binding, desktop history, async writes, quick input, session drafts and queued sends)');
})().catch((e) => { console.error(e); process.exitCode = 1; });
