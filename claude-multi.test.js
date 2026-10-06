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
const env = childEnv('D:/acct');
assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
assert.equal(env.CLAUDE_PID, undefined);
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
// the first cache format (no model, no write kind): a deleted file's replies keep counting, as 1-h writes at Opus 5.5
const old = require('path').join(tmp, 'old.json');
fs.writeFileSync(old, JSON.stringify({ [require('path').join(tmp, 'a', 'p', 'gone.jsonl')]: { size: 9, recs: [['msg_9:r', '2026-09-29', 1, 0, 1, 0]] } }));
t = tokenStats(roots, old);
assert.equal(t.total, 2); near(t.usd, (1 + 1 * 2) * 4 / 1e6);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('tokens ok');
