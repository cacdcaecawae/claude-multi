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
// the first cache format (no model, no write kind): a deleted file's replies keep counting, as 1-h writes at Opus 5.5
const old = require('path').join(tmp, 'old.json');
fs.writeFileSync(old, JSON.stringify({ [require('path').join(tmp, 'a', 'p', 'gone.jsonl')]: { size: 9, recs: [['msg_9:r', '2026-09-29', 1, 0, 1, 0]] } }));
t = tokenStats(roots, old);
assert.equal(t.total, 2); near(t.usd, (1 + 1 * 2) * 4 / 1e6);
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
    u('<task-notification>\n<task-id>b1</task-id>'),
    u('Summary of earlier work', { isCompactSummary: true }),
    a([{ type: 'text', text: '测试通过。' }]),
    // sent while Claude was at work; a background task's message delivered the same way isn't yours
    { type: 'attachment', timestamp: T, attachment: { type: 'queued_command', prompt: '顺便看看日志', origin: { kind: 'human' } } },
    { type: 'attachment', timestamp: T, attachment: { type: 'queued_command', prompt: '<task-notification>', origin: { kind: 'task' } } },
    { type: 'system', subtype: 'turn_duration', durationMs: 7750, timestamp: T }, // Claude's turn over
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const all = history(f);
  assert.deepEqual(all.items.map((x) => `${x.role}:${x.text}`),
    ['user:/rename 新名字', 'user:修一下 bug', 'claude:好的。', 'tool:Bash  Run tests', 'note:更早的内容已压缩', 'claude:测试通过。', 'user:顺便看看日志', 'done:7750']);
  // read again from where it ended: only what was added, and a line still being written waits
  fs.appendFileSync(f, JSON.stringify(a([{ type: 'text', text: '看完了。' }])) + '\n{"type":"assistant","mess');
  const more = history(f, { from: all.end });
  assert.deepEqual(more.items.map((x) => x.text), ['看完了。']);
  assert.equal(history(f, { from: more.end }).items.length, 0);
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