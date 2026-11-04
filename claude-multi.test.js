// node claude-multi.test.js: the account pick on the cases it was designed around.
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
  const md = new Function(`${part(/^const esc = .*$/m)}\n${part(/^const table = [\s\S]*?^};$/m)}\n${part(/^function md\(t\) \{[\s\S]*?^\}$/m)}\nreturn md;`)();
  const t = md('看这个\n| 方案 | 快不快 |\n|---|:--:|\n| **A. 离线** | `x` 快 |\n| c \\| d | <e> |\n后面');
  assert.ok(t.includes('<thead><tr><th>方案</th><th>快不快</th></tr></thead>'), t);
  assert.ok(t.includes('<tr><td><b>A. 离线</b></td><td><code>x</code> 快</td></tr>'), t);
  assert.ok(t.includes('<tr><td>c | d</td><td>&lt;e&gt;</td></tr>'), t);              // escaped as everything else
  assert.ok(t.startsWith('看这个\n<div class="tbl">') && t.endsWith('</table></div>后面'), t);
  assert.equal(md('| grep x\n'), '<div class="mono">| grep x\n</div>');               // not a table
  console.log('md ok');
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

// The 管家's chat commands: a time to wake at, and whether its 待办 still has something to do.
{
  const { parseUntil, todoOpen } = require('./claude-multi');
  const now = new Date(2026, 10, 3, 14, 0).getTime();
  assert.equal(parseUntil('15:40', now), new Date(2026, 10, 3, 15, 40).getTime());
  assert.equal(parseUntil('9:05', now), new Date(2026, 10, 4, 9, 5).getTime()); // past today: tomorrow's
  assert.throws(() => parseUntil('soon', now));
  assert.equal(todoOpen('## rag检索 跑完告诉我\n- 状态：等待中\n\n## 已完成\n- x'), true);
  assert.equal(todoOpen('# 待办\n\n## 已完成\n- rag检索 跑完了'), false); // only done ones
  assert.equal(todoOpen(''), false);
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

// The 管家's 待办 as its 操作台 reads it: each thing's lines, the done ones newest first with their times; its waits,
// a file each, one whose process is gone dropped
{
  const { todoParts, doneAt, waitsNow, todoOpen } = require('./claude-multi'), os = require('os'), path = require('path');
  const md = ['# 待办', '', '## rag检索 跑完告诉我', '- 盯着：rag检索（智能体rag）', '- 等：它回复完', '- 然后：告诉用户结果', '- 状态：等待中（11-03 记下）', '',
    '## 15:40 提醒看额度', '- 状态：进行中', '', '## 二次返修 部署', '- 盯着：二次返修', '', '## 已完成', '- 11-02 09:10 早一件', '- 11-03 15:20 undt-sim 跑完：已转告', '- 没写时间的一件'].join('\n');
  const { todos, lines } = todoParts(md);
  assert.deepEqual(todos.map((t) => t.t), ['rag检索 跑完告诉我', '15:40 提醒看额度', '二次返修 部署']);
  assert.deepEqual(todos[0], { t: 'rag检索 跑完告诉我', ask: '', watch: 'rag检索（智能体rag）', wait: '它回复完', then: '告诉用户结果', st: '等待中（11-03 记下）' });
  assert.equal(todos[1].watch, ''); assert.equal(todos[1].st, '进行中');
  assert.deepEqual(lines, ['没写时间的一件', '11-03 15:20 undt-sim 跑完：已转告', '11-02 09:10 早一件']);
  const d = doneAt(lines[1], new Date(2026, 10, 3, 18));
  assert.deepEqual([new Date(d.at).getMonth(), new Date(d.at).getDate(), new Date(d.at).getHours(), new Date(d.at).getMinutes(), d.text], [10, 3, 15, 20, 'undt-sim 跑完：已转告']);
  assert.equal(doneAt(lines[0]), null);
  assert.ok(todoOpen(md) && !todoOpen('## 已完成\n- x')); // still agrees
  assert.deepEqual(todoParts(''), { todos: [], lines: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waits-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ pid: process.pid, at: 1, until: null, note: '活的' }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ pid: 999999, at: 2, until: 5, note: '死的' }));
  assert.deepEqual(waitsNow(dir).map((w) => w.note), ['活的']);
  assert.ok(!fs.existsSync(path.join(dir, 'b.json'))); // dropped
  fs.rmSync(dir, { recursive: true });
  console.log('butler desk ok');
}

// The conversations the 管家's 待办 watches (by title, its （folder） dropped, or by 编号), and the one notice it gets for
// several stopping at once, each once with its latest
{
  const { watchedIds, butlerNotice } = require('./claude-multi');
  const md = ['## 声速场', '- 盯着：焊缝声速场层析反演可行性调研（D:\paper_fast，账号 2）', '', '## 新开的', '- 盯着：abc-123', '', '## 没盯谁', '- 状态：进行中', '', '## 已完成', '- 盯着：旧的'].join('\n');
  const list = [{ id: 'a', title: '焊缝声速场层析反演可行性调研' }, { id: 'abc-123', title: '' }, { id: 'c', title: '旧的' }, { id: 'd', title: '别的' }];
  assert.deepEqual([...watchedIds(md, list)].sort(), ['a', 'abc-123']);
  const t = butlerNotice([{ id: 'a', title: '声速场', kind: 'ask' }, { id: 'b', title: '层析', kind: 'done' }, { id: 'a', title: '声速场', kind: 'done' }]);
  assert.ok(t.startsWith('[系统通知]') && t.includes('「声速场」回复完了，现在空闲；「层析」回复完了') && !t.includes('在等人确认'), t);
  // the watchdog's: idle too long (by conversation), and its Haiku's word (one, the latest)
  const w = butlerNotice([{ id: 'b', title: '层析', kind: 'stale', why: '空闲已经 12 分钟' }, { kind: 'dog', why: '旧的' }, { kind: 'dog', why: '「声速场」在打转' }]);
  assert.ok(w.includes('「层析」空闲已经 12 分钟；看门狗觉得：「声速场」在打转') && !w.includes('旧的'), w);
  // a task's 原话
  const { todoParts } = require('./claude-multi');
  assert.equal(todoParts('## 声速场\n- 原话：盯着声速场做完\n- 状态：在跑\n').todos[0].ask, '盯着声速场做完');
  console.log('butler notice ok');
}

// What the 管家 costs, by what set it going: you, a [系统通知], a background task (a tool's result in between keeps
// the one before), a reply counted once however many lines carry it, the watchdog's logged Haiku; by model too
{
  const { butlerCost } = require('./claude-multi'), os = require('os'), path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cost-')), dir = path.join(tmp, 'projects', path.join(__dirname, 'butler').replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const T = new Date().toISOString(), u = (content) => ({ type: 'user', timestamp: T, message: { content } });
  const a = (id, usage) => ({ type: 'assistant', timestamp: T, requestId: 'r' + id, message: { id, model: 'claude-sonnet-5', usage } });
  fs.writeFileSync(path.join(dir, 's.jsonl'), [u('你好'), a('m1', { input_tokens: 1e6 }), a('m1', { input_tokens: 1e6 }), u('[系统通知] 有动静'), a('m2', { output_tokens: 1e5 }),
    u([{ type: 'tool_result', content: 'ok' }]), a('m3', { input_tokens: 5e5 }), u('<task-notification>\n<status>completed</status>'), a('m4', { input_tokens: 1e6 })].map((x) => JSON.stringify(x)).join('\n'));
  const log = path.join(tmp, 'events.jsonl');
  fs.writeFileSync(log, JSON.stringify({ timestamp: T, event: 'watchdog', usd: 0.01 }) + '\n');
  const c = butlerCost([{ dir: path.join(tmp, 'projects') }], log).today, r = (x) => Math.round(x * 100) / 100;
  assert.deepEqual([r(c.you), r(c.notice), r(c.bg), r(c.dog), c.n], [2, 2, 2, 0.01, 5]);
  assert.deepEqual(Object.fromEntries(Object.entries(c.models).map(([k, v]) => [k, r(v)])), { 'claude-sonnet-5': 6, 'claude-haiku-4-5': 0.01 });
  fs.rmSync(tmp, { recursive: true, force: true });
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
