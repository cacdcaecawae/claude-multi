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
// its end delivered mid-turn, as Claude Code records it now: an attachment, its words in .prompt
assert.equal(helpersBusy([...bg, JSON.stringify({ type: 'attachment', timestamp: ts, attachment: { type: 'queued_command', prompt: '<task-notification>\n<tool-use-id>b1</tool-use-id>\n<status>completed</status>' } })].join('\n')), false);
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
{
  const { startingOwners, stillStarting } = require('./claude-multi'), id = 'e0907995-3eb1-4614-916e-c69bb6f585da';
  assert.deepEqual([...startingOwners(`  12 "/some dir/claude" --resume ${id}\n91 cli.exe "--session-id" "${id}"\n99 other${id}\n24 node "C:/my app/claude-multi.js" delete ${id}`)], [[id, [12, 91, 24]]]);
  const old = new Map([[id, [process.pid]]]);
  assert.ok(stillStarting(old, id, () => []));
  assert.ok(!stillStarting(old, id, () => [{ pid: process.pid }]));
  assert.equal(old.size, 0);
  // its pid alive again, but a scan finds another program on it (or none on this id): the id is let go
  const { keepOwners } = require('./claude-multi'), more = new Map([[id, [process.pid, 12]], ['b', [13]]]);
  keepOwners(more, new Map([[id, [12]], ['c', [13]]]));
  assert.deepEqual([...more], [[id, [12]]]);
  assert.ok(!stillStarting(more, id, () => []), 'a pid no longer running lets go');
}
// A transient sharing violation retries the replacement. Persistent failure leaves the old bytes and no staging file.
{
  const { writeWhole } = require('./claude-multi'), path = require('path');
  const file = path.join(TEST_HOME, 'atomic.json'), rename = fs.renameSync;
  writeWhole(file, 'old');
  let failures = 2;
  fs.renameSync = (...args) => {
    if (failures-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return rename(...args);
  };
  try {
    if (process.platform === 'win32') { writeWhole(file, 'new'); assert.equal(failures, -1); }
    failures = 100;
    assert.throws(() => writeWhole(file, 'partial'), /busy/);
    assert.equal(fs.readFileSync(file, 'utf8'), process.platform === 'win32' ? 'new' : 'old');
    assert.deepEqual(fs.readdirSync(TEST_HOME).filter((n) => n.startsWith('atomic.')), ['atomic.json']);
  } finally { fs.renameSync = rename; }
}
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
assert.equal(tokenStats([], cacheF).total, 0);
assert.equal(tokenStats(roots, cacheF).total, 27); // both roots re-added after the records themselves were deleted
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
// the advisor's calls ride in a reply's usage.iterations: counted too, at its model's price (Fable 5.1), once though repeated
{
  const C = require('path').join(tmp, 'adv', 'p'); fs.mkdirSync(C, { recursive: true });
  const u = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2, iterations: [
    { type: 'message', input_tokens: 1, output_tokens: 2 }, { type: 'advisor_message', model: 'claude-fable-5-1', input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0 }] };
  const line = JSON.stringify({ message: { model: 'claude-opus-5-5', id: 'msg_a', usage: u }, requestId: 'req_a', type: 'assistant', timestamp: atH(14) }) + '\n';
  fs.writeFileSync(require('path').join(C, 's.jsonl'), line + line);
  const ta = tokenStats([{ label: 'adv', dir: require('path').join(tmp, 'adv') }], require('path').join(tmp, 'adv.json'));
  assert.equal(ta.total, 113); near(ta.usd, (1 * 4 + 2 * 20) / 1e6 + (100 * 10 + 10 * 50) / 1e6);
}
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
// Gemini (agy): its records' model steps (input, output, cache reads), every account's in one folder, each reply the
// account's that was on then (by the log; before any switch: the first's), at Google's prices by the reply's day (Argon
// up on 2026-12-01); one read on as it grows; a deleted one stays counted
{
  const path = require('path'), brain = path.join(tmp, 'gem', 'brain'), log = path.join(tmp, 'gem-events.jsonl'), cache = path.join(tmp, 'gem.json');
  const step = (i, at, model, inp, out, cr) => JSON.stringify({ step_index: i, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at, model, input_tokens: inp, output_tokens: out, cache_read_tokens: cr, content: 'x' }) + '\n';
  const rec = (id) => path.join(brain, id, '.system_generated', 'logs', 'transcript.jsonl');
  for (const id of ['g1', 'g2']) fs.mkdirSync(path.dirname(rec(id)), { recursive: true });
  fs.writeFileSync(rec('g1'), JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-20T11:59:00Z', content: '"output_tokens" in your words' }) + '\n'
    + step(1, '2026-11-20T12:00:00Z', 'gemini-4-neon-high', 1e6, 1e6, 1e6) + step(2, '2026-11-20T14:00:00Z', 'gemini-4-argon-high', 1e6, 0, 0));
  fs.writeFileSync(rec('g2'), step(0, '2026-12-02T12:00:00Z', 'gemini-4-argon-xhigh', 1e6, 1e6, 1e6) + '{"step_index":1');
  fs.writeFileSync(log, JSON.stringify({ timestamp: '2026-11-20T13:00:00Z', event: 'gemini_on', profile_id: 'gb' }) + '\n');
  const gr = [{ id: 'c', label: 'c', dir: path.join(tmp, 'none') }, { id: 'ga', label: 'ga', gem: 1, brain }, { id: 'gb', label: 'gb', gem: 2, brain }];
  t = tokenStats(gr, cache, log);
  assert.deepEqual(t.accounts.map((a) => [a.total, a.gem]), [[0, undefined], [3e6, 1], [4e6, 2]]);
  near(t.accounts[1].usd, 3 + 15 + 0.15); near(t.accounts[2].usd, 2 + (4 + 20 + 0.2)); // Neon; Argon before and after its price went up
  fs.appendFileSync(rec('g1'), step(3, '2026-11-21T12:00:00Z', 'gemini-4-hydrogen', 0, 2e6, 0));
  t = tokenStats(gr, cache, log);
  assert.deepEqual([t.accounts[2].total, t.accounts[2].usd.toFixed(2)], [6e6, '41.20']); // Hydrogen $7.50 out, read on once
  fs.rmSync(path.join(brain, 'g2'), { recursive: true }); // deleted: still counted
  assert.equal(tokenStats(gr, cache, log).total, 9e6);
}
// GPT (Codex): its records' responses (input with its cached part in it, output), each at the model its turn named and
// the tier its settings said (Fast: 2x), at OpenAI's prices; one read on as it grows (the model and tier kept from before);
// archived (moved: the same responses) counted once, then deleted: still counted
{
  const path = require('path'), home = path.join(tmp, 'codex'), cache = path.join(tmp, 'gpt.json'), log = path.join(tmp, 'none.log');
  const dir = path.join(home, 'sessions', '2026', '11', '21'), f = path.join(dir, 'rollout-a.jsonl'), arch = path.join(home, 'archived_sessions', 'rollout-a.jsonl');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.dirname(arch), { recursive: true });
  const L = (type, payload) => JSON.stringify({ timestamp: '2026-11-21T10:00:00Z', type, payload }) + '\n';
  const tier = (t) => L('event_msg', { type: 'thread_settings_applied', thread_settings: { service_tier: t } });
  const use = (id, inp, cached, out) => L('token_usage_record', { response_id: id, usage: { input_tokens: inp, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: out } });
  fs.writeFileSync(f, L('session_meta', { id: 'a' }) + tier('default') + L('turn_context', { model: 'gpt-6.2-astra' })
    + L('response_item', { type: 'message', content: [{ text: 'a "token_usage_record" in your words' }] }) + use('r1', 3e6, 2e6, 1e6)
    + tier('priority') + L('turn_context', { model: 'gpt-6-astra' }) + use('r2', 1e6, 0, 0));
  const gr = [{ id: 'c', label: 'c', dir: path.join(tmp, 'none') }, { id: 'g', label: 'g', gpt: 1, dir: path.join(home, 'sessions'), arch: path.dirname(arch) }];
  t = tokenStats(gr, cache, log);
  assert.deepEqual(t.accounts.map((a) => [a.total, a.gpt]), [[0, undefined], [5e6, 1]]);
  near(t.accounts[1].usd, (8 + 40 + 2 * 0.4) + 10 * 2); // 6.2 Astra: 1M in not cached, 1M out, 2M cached; 6 Astra Fast: 1M in, 2x
  fs.appendFileSync(f, use('r3', 0, 0, 1e6));
  t = tokenStats(gr, cache, log);
  assert.deepEqual([t.accounts[1].total, t.accounts[1].usd.toFixed(2)], [6e6, '168.80']); // 6 Astra Fast still: $50 out, 2x
  fs.renameSync(f, arch); // 删除: codex archive
  assert.equal(tokenStats(gr, cache, log).accounts[1].total, 6e6);
  fs.rmSync(arch);
  assert.equal(tokenStats(gr, cache, log).accounts[1].total, 6e6);
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
    ...['[系统通知] 回来看一下', 'Another Claude session sent a message: hi'].map((content) =>
      ({ type: 'user', timestamp: new Date(T + 8e6).toISOString(), message: { content } })),
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

// 改动: an Edit's or a Write's result is a file changed, its lines added and taken out (a new file: all its lines); a
// failed one (its error, no patch), a helper agent's, or a file whose text only mentions a patch, none
{
  const { history, codexEdit } = require('./claude-multi');
  const f = require('path').join(require('os').tmpdir(), `cm-edit-${process.pid}.jsonl`), T = '2026-10-07T08:00:00Z';
  const res = (toolUseResult, extra = {}) => ({ type: 'user', timestamp: T, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }, toolUseResult, ...extra });
  fs.writeFileSync(f, [
    { type: 'user', timestamp: T, message: { content: '改一下' } },
    { type: 'assistant', timestamp: T, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\p\\a.js' } }] } },
    res({ filePath: 'C:\\p\\a.js', originalFile: 'a\nb\nd\n', structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' a', '-b', '+B', '+C', ' d'] }] }),
    res('Error: String to replace not found in file.'),
    res({ type: 'create', filePath: 'C:\\p\\new.md', content: 'x\ny\n', structuredPatch: [] }),
    res({ filePath: 'C:\\p\\sub.js', structuredPatch: [{ lines: ['+z'] }] }, { isSidechain: true }),
    res({ type: 'text', file: { filePath: 'C:\\p\\notes.md', content: '"structuredPatch": [] is what Edit leaves' } }),
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  assert.deepEqual(history(f).items.filter((m) => m.role === 'edit').map(({ text, add, del }) => `${text} +${add} -${del}`), ['C:\\p\\a.js +2 -1', 'C:\\p\\new.md +2 -0']);
  fs.rmSync(f);
  // Codex's: an update's diff (its lines after @@), a new file's whole text, a deleted one's
  assert.deepEqual(codexEdit({ path: 'a.py', kind: { type: 'update' }, diff: '@@ -1,3 +1,3 @@\n a\n-b\n+c\n+d\n' }), { text: 'a.py', add: 2, del: 1 });
  assert.deepEqual(codexEdit({ path: 'n.py', kind: { type: 'add' }, diff: 'import os\nprint(1)\n' }), { text: 'n.py', add: 2, del: 0 });
  assert.deepEqual(codexEdit({ path: 'o.py', kind: { type: 'delete' }, diff: 'x\n' }), { text: 'o.py', add: 0, del: 1 });
  console.log('history edits ok');
}

// What waits in a running conversation's queue: your messages Claude hasn't taken in yet, read on as the record grows.
// Taken in mid-turn, as the next turn, or back in its input box (popAll); a turn's end clears what's left; a background
// task's news not yours
{
  const { queueNow } = require('./claude-multi');
  const f = require('path').join(require('os').tmpdir(), `cm-queue-${process.pid}.jsonl`), T = '2026-10-07T08:00:00Z';
  const op = (operation, content, extra = {}) => ({ type: 'queue-operation', operation, timestamp: T, sessionId: 's', ...(content != null && { content }), ...extra });
  const put = (...lines) => fs.appendFileSync(f, lines.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const now = () => queueNow(f).map((x) => x.text);
  fs.writeFileSync(f, '');
  put(op('enqueue', '顺便看看日志'), op('enqueue', '<task-notification>\n<task-id>b1</task-id>'), op('enqueue', '再跑一次\n测试'));
  assert.deepEqual(now(), ['顺便看看日志', '再跑一次\n测试']);
  put(op('remove', '顺便看看日志', { reason: 'absorbed_mid_turn' }), { type: 'attachment', timestamp: T, attachment: { type: 'queued_command', prompt: '顺便看看日志', origin: { kind: 'human' } } });
  assert.deepEqual(now(), ['再跑一次\n测试']);
  fs.appendFileSync(f, '{"type":"user","timestamp":"2026-10-07T08:00:00Z","message":{"content":"再跑一'); // still being written
  assert.deepEqual(now(), ['再跑一次\n测试']);
  fs.appendFileSync(f, '次 测试"}}\n'); // taken in as the next turn's message (its spaces aside)
  assert.deepEqual(now(), []);
  put(op('enqueue', '改个说法'), op('popAll'));
  assert.deepEqual(now(), []);
  put(op('enqueue', '一个死掉的 Claude 留下的'), { type: 'system', subtype: 'turn_duration', durationMs: 5, timestamp: T });
  assert.deepEqual(now(), []);
  put(op('enqueue', '还在等'));
  assert.deepEqual(queueNow(f), [{ text: '还在等', at: Date.parse(T) }]);
  fs.rmSync(f);
  console.log('queue ok');
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
  // a long screen of tool rows over a long record: the same answer (the last message with that key), at once
  const big = Array.from({ length: 3000 }, (_, i) => ({ role: i % 3 ? 'tool' : i % 2 ? 'user' : 'claude', text: `消息编号 ${i % 500}` }));
  const rows = [...Array.from({ length: 1000 }, (_, i) => `● Bash(step ${i})`), '● 消息编号 4'], t0 = Date.now(), b = lead(big, rows);
  assert.deepEqual([b.skip, Date.now() - t0 < 100], [1000, true]);
  // the last 消息编号 4 that isn't a tool's is #2004 (Claude's): from its question, #2001
  assert.deepEqual(plain(b), [EARLIER, '❯ 消息编号 1', '● 消息编号 2', '● 消息编号 3', MARK]);
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
  // an API account (本地代理): no quota asked for (no sign-in to ask with), no error either; nothing kept for it. With no
  // key in its settings (apiKeyHelper's), its gateway isn't asked anything
  let asked = 0;
  const gw = require('http').createServer((q, s) => { asked++; s.end('{}'); }).listen(0, '127.0.0.1', () => {
    require('./claude-multi').fetchUsage({ id: 'local', configDir: 'C:/nowhere', api: { baseURL: `http://127.0.0.1:${gw.address().port}` } }).then((r) => {
      assert.deepEqual(r, { api: true }); assert.equal(asked, 0); assert.deepEqual(keepLast([{ id: 'local' }], [r], cache, now), [{ api: true }]); assert.ok(!cache.local);
      console.log('quota of an API account ok');
    }, (e) => { console.error(e); process.exitCode = 1; }).finally(() => gw.close());
  });
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
  let t, idleAt = null;
  setTimeout(() => status('shell'), 700); setTimeout(() => { status('idle'); idleAt = Date.now(); }, 1500);
  await untilFree(dir, process.pid, false);
  // timed from idle, not from the start: these timers wait for the rest of this file's tests, all run first (it took 4.4 s)
  assert.ok(idleAt && Date.now() - idleAt < 2500, `out ${idleAt && Date.now() - idleAt} ms after idle`); // through busy and shell, out at idle (a 1 s poll)
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
  // a removed GPT account too: its row after the ones there are, its records' (gone with its folder) still counted from the cache
  const gr = tokenRoots({ profiles: [], gpt: [{ id: 'g1', label: 'o@x', home: 'C:\\G1' }], removedGpt: [{ id: 'g0', label: 'p@x', home: 'C:\\G0' }] });
  assert.deepEqual(gr.map((r) => [r.label, r.gpt, r.dir]), [['o@x', 1, path.join('C:\\G1', 'sessions')], ['p@x（已移除）', 2, path.join('C:\\G0', 'sessions')]]);
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
    ${part(/^const LINK = [\s\S]*?^};$/m)}\n${part(/^const MATH = .*$/m)}\n${part(/^const tex = .*$/m)}\n${part(/^const PEEKABLE = .*$/m)}\n${part(/^const peekLink = [\s\S]*?\};$/m)}\n${part(/^const FILE_LINK = .*$/m)}\n${part(/^const fileLink = [\s\S]*?\};$/m)}\n${part(/^const BLOCKS = .*$/m)}\n${part(/^const block = [\s\S]*?'<hr>';$/m)}\n${part(/^const PV_LANG = .*$/m)}\n${part(/^const hl = [\s\S]*?^};$/m)}\n${part(/^function md\(t\) \{[\s\S]*?^\}$/m)}\nreturn md;`)(require('katex'));
  // a list's items, a rule and a quote: blocks, each line's end taken with it; a - inside a line, or in code, stays
  const h = md('看\n- 一\n  - 二\n---\n> 引\n正文 - 不是\n```\n- 代码\n```');
  assert.ok(h.startsWith('看\n<span class="li" style="margin-left:0em">一</span><span class="li" style="margin-left:1em">二</span><hr><span class="bq">引</span>正文 - 不是\n'), h);
  assert.ok(h.includes('<pre>- 代码</pre>'), h);
  // a path of this PC in code: a 预览 link, as Codex shows one: its kind's mark and its name, the whole path on hover
  // (Chinese and spaces in it; a folder by its ending / or no .ext); other code, or a Mac's path: code
  const pk = md('`D:\\论文 04\\图7.pptx` `D:/a/` `npm i` `/Users/me/x`');
  const lk = /^<a class="peek" data-peek="D:\\论文 04\\图7\.pptx" title="D:\\论文 04\\图7\.pptx">(<svg.*?<\/svg>)图7\.pptx<\/a> <a class="peek" data-peek="D:\/a\/" title="D:\/a\/">(<svg.*?<\/svg>)a<\/a> <code>npm i<\/code> <code>\/Users\/me\/x<\/code>$/.exec(pk);
  assert.ok(lk && lk[1] !== lk[2], pk); // a file's mark, a folder's
  assert.equal(md('`C:/x/runs/<id>` `D:\\a "b"`'), '<code>C:/x/runs/&lt;id&gt;</code> <code>D:\\a &quot;b&quot;</code>'); // a stand-in (runs/<id>), a ": no path
  // a file linked as Gemini writes one: its words, opened by 预览 (file:///, %-escapes, a line number dropped; a plain
  // path too, a folder's mark for a folder); a relative one, or a Mac's here, as written
  const fl = md('[当前进展.md](file:///D:/paper/%E8%AE%BA%E6%96%87%2004/当前进展.md) 和 [a.js](D:\\x\\a.js:12) 和 [稿件](file:///D:/paper/稿件/) 和 [b](docs/b.md) [c](file:///Users/me/c.md)');
  const fk = /^<a class="peek" data-peek="D:\/paper\/论文 04\/当前进展\.md" title="[^"]+">(<svg.*?<\/svg>)当前进展\.md<\/a> 和 <a class="peek" data-peek="D:\\x\\a\.js" [^>]+>(<svg.*?<\/svg>)a\.js<\/a> 和 <a class="peek" data-peek="D:\/paper\/稿件\/" [^>]+>(<svg.*?<\/svg>)稿件<\/a> 和 \[b\]\(docs\/b\.md\) \[c\]\(file:\/\/\/Users\/me\/c\.md\)$/.exec(fl);
  assert.ok(fk && fk[1] === fk[2] && fk[1] !== fk[3], fl);
  // one written in `code` is shown as written (a reply about such links); a link's words in code still a link, its code kept
  assert.equal(md('写的是 `[当前进展.md](file:///D:/a/…)` 这种'), '写的是 <code>[当前进展.md](file:///D:/a/…)</code> 这种');
  // a path cut short (… or ...) names no file: as written, linked or in code
  assert.equal(md('[当前进展.md](file:///D:/paper/…) `D:\\a\\...\\b.md`'), '[当前进展.md](file:///D:/paper/…) <code>D:\\a\\...\\b.md</code>');
  assert.ok(/^<a class="peek" data-peek="D:\/a\.md" [^>]+>(<svg.*?<\/svg>)<code>a\.md<\/code><\/a> \*\*$/.test(md('[`a.md`](file:///D:/a.md) **')), md('[`a.md`](file:///D:/a.md) **'));
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
// switch during a rename or delete; a second switch holds it too, let go by the last one's end whichever ends first (F4)
{
  const { hold } = require('./claude-multi'), id = 'c-1';
  const switched = hold(id, 'switch'), second = hold(id, 'switch');
  assert.throws(() => hold(id, 'change'), /换账号/);
  switched(); // the first one's end (its later gave up: the second took the switch) lets nothing go
  assert.throws(() => hold(id, 'change'), /换账号/);
  second();
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
  notifyGpt({ type: 'agent-turn-complete', 'thread-id': 't9' });                 // a temporary one of Codex's, not in its database
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
}
// A Gemini one for the 管家, in a home of its own (its ~/.gemini, one account): listed by sessions --all (gem, A1), read
// with chat look (where it runs: nowhere, no service reached: its fetch fails, and the one on 7788, the one in use, is
// never asked), a new one on an account there isn't refused
{
  const fs = require('fs'), path = require('path'), os = require('os'), url = require('url'), { spawnSync } = require('child_process'), { DatabaseSync } = require('node:sqlite');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-')), work = path.join(root, 'work'), a = path.join(root, '.gemini', 'antigravity-cli'), id = '9e1f0000-1111-2222-3333-444444444444';
  fs.mkdirSync(path.join(root, '.claude-multi'), { recursive: true }); fs.mkdirSync(work); fs.mkdirSync(path.join(a, 'brain', id, '.system_generated', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-multi', 'profiles.json'), JSON.stringify({ profiles: [], gemini: [{ id: 'gemini-1', label: 'g@example.com', email: 'g@example.com', home: path.join(root, 'g1') }], geminiOn: 'gemini-1' }));
  const d = new DatabaseSync(path.join(a, 'conversation_summaries.db'));
  d.exec("create table conversation_summaries (conversation_id text, title text, last_modified_time text, workspace_uris text, parent_conversation_id text)");
  d.prepare('insert into conversation_summaries values (?, ?, ?, ?, ?)').run(id, '修复登录', '2026-11-20 10:00:00+00:00', JSON.stringify([url.pathToFileURL(work).href]), ''); d.close();
  fs.writeFileSync(path.join(a, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'), [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T09:59:00Z', content: '<USER_REQUEST>\n把登录改好\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-20T09:59:30Z', content: '改好了。' }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const noFetch = 'data:text/javascript,globalThis.fetch=()=>Promise.reject(new Error("no service in tests"))';
  const cli = (...x) => spawnSync(process.execPath, ['--import', noFetch, path.join(__dirname, 'claude-multi.js'), ...x], { env: { ...process.env, USERPROFILE: root, HOME: root }, encoding: 'utf8' }).stdout.trim();
  assert.deepEqual(JSON.parse(cli('sessions', '--json', '--all')).filter((s) => s.gem).map((s) => [s.id, s.title, s.who, s.cwd]), [[id, '修复登录', 'A1', work]]);
  assert.equal(cli('chat', 'look', '登录'), `「修复登录」 ${id}\nGemini 账号 A1 · ${work} · 没在运行\n\n最后的回答：\n改好了。`);
  assert.equal(cli('chat', 'new', work, '你好', '--gemini', '--acct', 'A3'), '没有 Gemini 账号 A3（用户要先运行 claude-multi new gemini 加一个）');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('butler gemini ok');
  console.log('gpt chat for the 管家 ok');
}

// A picture in a record: history() names it by its line's place in bytes and which picture it is, recordImage() gives
// it back. A picture from the page is saved under a new name; ones older than a week go.
{
  const fs = require('fs'), path = require('path'), os = require('os');
  const { history, recordImage, saveUpload, sdkParts } = require('./claude-multi');
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
  // API 额度: a picture saved here goes as a picture; a file, a picture-named one elsewhere, a missing one, one too big
  // for the API: each as its path
  const big = saveUpload(Buffer.alloc(4 << 20), 'png', up), away = path.join(d, '20261122T000000-abcdef.png'), gone = path.join(up, '20261122T000000-000000.png');
  fs.writeFileSync(away, png);
  assert.deepEqual(sdkParts([saved, doc, away, big, gone], up),
    { images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }], files: [doc, away, big, gone] });
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

// What's on agy's screen (screen.js: Gemini ones, the page's and the 管家's), on screens a real agy 1.5 showed: its
// question to run a command, its own question, its Write-in open, at work with a message queued (its thought's ▸ row
// none), its / menu (no question), a numbered message of yours (no question)
{
  const { parseAgyScreen } = require('./screen.js'), R = '─'.repeat(110);
  const run = parseAgyScreen([R, '> 用命令行删除 junk.txt', '● Ran (Remove-Item .\\junk.txt) (ctrl+o to expand)', 'Command', R, 'Requesting permission for:', '   Remove-Item .\\junk.txt', 'Run this command?',
    '> 1. Yes, run command', "  2. Yes, and always allow in this conversation for commands that start with 'Remove-Item", ".\\junk.txt'", '  3. Yes, and always allow (Persist to settings.json)', '  4. No, cancel',
    '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', 'Gemini 账号 A1  │  Gemini 4 Neon (High)']);
  assert.deepEqual([run.busy, run.menu.cur, run.menu.ask, run.menu.opts.map((o) => o.label.slice(0, 16)), run.menu.opts[1].desc], [null, 1, 'Requesting permission for:\nRemove-Item .\\junk.txt\nRun this command?',
    ['Yes, run command', 'Yes, and always ', 'Yes, and always ', 'No, cancel'], ".\\junk.txt'"]);
  const own = parseAgyScreen(['? 你最喜欢哪种颜色？', 'Question', R, 'Question 1/1: 你最喜欢哪种颜色？', '> 1. 红', '  2. 绿', '  3. 蓝', '  4. Write-in...', '  ↑/↓ Navigate · enter Select · esc Skip']);
  assert.deepEqual([own.menu.ask, own.menu.opts.map((o) => o.label)], ['Question 1/1: 你最喜欢哪种颜色？', ['红', '绿', '蓝', 'Write-in...']]);
  const write = parseAgyScreen([R, 'Question 1/1: 你最喜欢哪种颜色？', '  1. 红', '> 4. Write-in...', '  Your answer:', '  enter Submit · esc Back']);
  assert.deepEqual([write.menu, write.writing], [null, true]);
  const q = parseAgyScreen([R, '> 写一首诗', '▸ Thought for 5s, 203 tokens', '⣟  Generating...', '└ Tip: Press ctrl+r to review pending artifacts.', '▸ 再写一首，关于冬天 (alt+m to send immediately)', R, '>', R]);
  assert.deepEqual([q.busy?.[1], q.menu, q.writing, q.queue], ['Generating...', null, false, ['再写一首，关于冬天']]);
  const slash = parseAgyScreen([R, '> /', R, '> /add-dir             Add a directory to the workspace', '  /agents              List available custom agents', '  ↑/↓ Navigate · enter Select · tab Complete']);
  const mine = parseAgyScreen([R, '> 1. 先改登录', '  2. 再加测试', '⣟  Generating...', R, '>', R]);
  assert.deepEqual([slash.menu, mine.menu, mine.queue], [null, null, []]);
  // a reply that only says 「Question 1/3:」 with a numbered list (agy working on this very code): no question
  assert.equal(parseAgyScreen(['● 第一题：', 'Question 1/3: 你最喜欢哪种颜色？', '  1. 红', '  2. 绿', R, '>', R]).menu, null);
  // its lists without numbers, as agy 1.5 drew them: a folder not trusted yet, /model, /resume (its search box, its
  // columns joined)
  const trust = parseAgyScreen(['Accessing workspace:', '', 'C:\\work\\proj', '', 'Do you trust the contents of this project?', '', 'Antigravity CLI requires permission to read, edit, and execute files here.', '',
    '> Yes, I trust this folder', '  No, exit', '', '  ↑/↓ Navigate · enter Confirm']);
  assert.deepEqual([trust.menu.cur, trust.menu.opts.map((o) => o.label), /信任这个文件夹/.test(trust.menu.ask)], [1, ['Yes, I trust this folder', 'No, exit'], true]);
  const model = parseAgyScreen([R, '>', R, 'Switch Model', '', '  Search:', '          ────────────────────', '', '  Gemini 4 Neon', '> Gemini 4 Argon        (current)', '  Gemini 4 Hydrogen', '  Claude Opus 5.5', '',
    '  Effort  ◂        ●━━━━━━━━━━━━━━●━━━━━━━━━━━━━━◉        ▸', '                  low          medium          high', '', 'Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back']);
  assert.deepEqual([model.menu.cur, model.menu.ask, model.menu.opts.map((o) => o.label)], [2, 'Switch Model', ['Gemini 4 Neon', 'Gemini 4 Argon · (current)', 'Gemini 4 Hydrogen', 'Claude Opus 5.5']]);
  const res = parseAgyScreen([R, '>', R, '   CLI    Other   (tab to cycle)', '', '  Conversations', '  Type to search conversations...  (type title:<query> to filter by title)',
    '> Fix login                                   proj     107 steps        3h ago', '  Tidy notes                                          5 steps        4h ago', '',
    'Keyboard: ↑/↓ Navigate  ←/→ Page  ctrl+f Grouped View  enter Select  f2 Rename  f4 Delete  tab Switch Tab', '  esc Go back / Clear search']);
  assert.deepEqual([res.menu.cur, res.menu.ask, res.menu.opts.map((o) => o.label)], [1, 'Conversations', ['Fix login · proj · 107 steps · 3h ago', 'Tidy notes · 5 steps · 4h ago']]);
  console.log('agy screen ok');
}
// Codex's screen (0.171, as it drew them): at work, its status row (either dot); its answer streaming (a • row of its
// own, no esc to interrupt) and idle: not
{
  const { parseCodexScreen } = require('./screen.js'), foot = ['', '› Ask Codex to do anything', '', '  GPT-6.2 high · ~\\work · 写短文', '  ← for agents · ? for shortcuts'];
  const work = (dot) => parseCodexScreen(['› 再写一篇，讲苹果的历史', '', `${dot} Working (35s • esc to interrupt)`, '  └ Tip: Switch models or reasoning effort quickly with /model.', ...foot]).busy;
  assert.deepEqual([work('•')?.[1], work('◦')?.[1], work('•')?.[2]], ['Working', 'Working', '']); // (how long: the page's count, as agy's)
  assert.equal(parseCodexScreen(['› 再写一篇，讲苹果的历史', '', '• # 苹果的历史：从天山果林到现代果园', '', '  ### 一、天山脚下的野果', ...foot]).busy, null);
  assert.deepEqual(parseCodexScreen(foot), { busy: null, menu: null });
  console.log('codex screen ok');
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
  // the menu's rule on one row with what the screen kept of the line before (a turn's status and cost): the question is
  // only what's under it (/model's took the end of the answer above too)
  const sm = parseScreen(['- /statechart 在本机跑不起来。', '· 本轮约 $0.27，约占 5', '✻ Sautéed for 40s · done 6:37 AM   小时额度 0.8% ' + rule,
    ' Select model', ' Switch between Claude models.', '', ' ❯ 1. Default (recommended)', '   2. Opus 5.5', '', ' Enter to confirm']).menu;
  assert.deepEqual([sm.ask, sm.opts.map((o) => o.label).join('|')], ['Select model\nSwitch between Claude models.', 'Default (recommended)|Opus 5.5']);
  // a numbered message of yours still on the screen over a permission menu: the menu's options, not your lines
  const p = parseScreen(['❯ 1. 修登录', '  2. 更新文档', '', '● Bash(npm test)', rule, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don\'t ask again', '   3. No', '', ' Esc to cancel']).menu;
  assert.deepEqual([p.cur, p.ask, p.opts.map((o) => o.label).join('|')], [1, 'Do you want to proceed?', 'Yes|Yes, and don\'t ask again|No']);
  // the 管家 never answers a tool's permission; a plan's approval it may
  const { asksPermission } = require('./claude-multi');
  assert.deepEqual([p.ask, 'Do you want to make this edit to a.js?', 'Do you want to allow this connection?', 'Would you like to proceed?', '今天想先做哪件事？'].map(asksPermission), [true, true, true, false, false]);
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
  fs.writeFileSync(path.join(dir, 's.jsonl'), [u('你好'), a('m1', { input_tokens: 1e6 }), a('m1', { input_tokens: 1e6 }), u('\n\n<pasted_content id="a1">\n[系统通知] 有动静\n</pasted_content id="a1">\n'), a('m2', { output_tokens: 1e5, iterations: null }), // a long notice: a paste
    u([{ type: 'tool_result', content: 'ok' }]), a('m3', { input_tokens: 5e5 }), u('<task-notification>\n<status>completed</status>'), a('m4', { input_tokens: 1e6, iterations: [{ type: 'advisor_message', model: 'claude-fable-5-2', output_tokens: 25000 }] })].map((x) => JSON.stringify(x)).join('\n'));
  const log = path.join(tmp, 'events.jsonl');
  fs.writeFileSync(log, JSON.stringify({ timestamp: T, event: 'watchdog', usd: 0.01 }) + '\n');
  const c = butlerCost([{ dir: path.join(tmp, 'projects') }], log).today, r = (x) => Math.round(x * 100) / 100;
  assert.deepEqual([r(c.you), r(c.notice), r(c.bg), r(c.dog), c.n], [2, 2, 3, 0.01, 6]);
  assert.deepEqual(Object.fromEntries(Object.entries(c.models).map(([k, v]) => [k, r(v)])), { 'claude-sonnet-5': 6, 'claude-fable-5-2': 1, 'claude-haiku-4-5': 0.01 });
  fs.rmSync(tmp, { recursive: true, force: true });
  // what the 管家 typed, found under the paste Claude Code wraps a long one in (so it shows as 管家发的)
  const { unwrapPaste } = require('./claude-multi');
  assert.equal(unwrapPaste('<pasted_content id="adb0">\n继续改图。重点：1) 图4\n</pasted_content id="adb0">\n'), '继续改图。重点：1) 图4');
  assert.equal(unwrapPaste('短的不包'), '短的不包');
  const blog = path.join(TEST_HOME, '.claude-multi', 'butler-log.jsonl');
  fs.appendFileSync(blog, ['给「修好「额度」面板」发了消息：处理一下', '新开了对话（D:/测试（旧）版）：继续'].map((text) =>
    JSON.stringify({ id: 'nested', at: 10, text })).join('\n') + '\n');
  assert.deepEqual(require('./claude-multi').blogSent('nested').map((e) => e.text), ['处理一下', '继续']);
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
  const r0 = homeOf((r) => ({ profiles: [], gemini: [{ id: 'gemini-1', label: 'g@example.com', home: path.join(r, 'gemini-1') }], geminiOn: 'gemini-1' }));
  const ra = run(r0, 'remove', 'A2'); // a Gemini one, by its A number (not read as a Claude account's)
  assert.equal(ra.status, 1, ra.stdout); assert.match(ra.stdout, /没有这个 Gemini 账号/);
  fs.rmSync(r0, { recursive: true, force: true });
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
  // money in one format: whole dollars; under one said so; none $0
  const [usd, about] = new Function(`${part(/^const usd = .*$/m)}\n${part(/^const about = .*$/m)}\nreturn [usd, about];`)();
  assert.deepEqual([usd(7012.4), usd(154.66), usd(0), usd(0.42), about(154.66), about(0.42), about(0)], ['$7,012', '$155', '$0', '不到 $1', '约 $155', '不到 $1', '约 $0']);
  const shut = new Function(`${part(/^const shut = .*$/m)}\nreturn shut;`)();
  assert.deepEqual([shut({ accounts: [] }), shut({ accounts: [{}], rec: null }), shut({ accounts: [{}], rec: 0, ready: '2小时' })], ['还没有 Claude 账号', '额度暂时读不到', '都到上限了，2小时后恢复']);
  assert.deepEqual([shut({ accounts: [{ api: true }], rec: null }), shut({ accounts: [{}, { api: true }], rec: null })], ['接入已失效', '额度暂时读不到']); // API ones only: none takes the key
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
    path, isDir: () => true, HOME: 'home',
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
    where: () => null, mirror: (pid, dir) => (mirrored = { key: 'w11', kind: 'pc', pid, dir }), sdk: { busy: (id) => id === 'S' }
  });
  await open(null, { id: 'A' }); assert.equal(mirrored.dir, 'acct');
  // an API 额度 one answering here (its Claude the Agent SDK's) isn't opened in a terminal beside it: two writers on one record
  const openS = vm.runInNewContext(api('open', 'switch'), { load: () => ({ profiles: [] }), sessions: () => [{ id: 'S', pid: 12, acct: 0, sdk: true }], sdk: { busy: (id) => id === 'S' } });
  await assert.rejects(openS(null, { id: 'S' }), /API 额度/);
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
      let menuNow = false, typeNow = false, typeTick = false, writeNow = false, busyNow = false, view = 'hist', question = false;
      let histNow = false, histEnd = null, histOldest = null, histGen = 0, nextId = 'A', unseen = false, gotAt = 0, waitAns = 0, waitT = 0;
      const line = { value: '', style: {}, scrollHeight: 0 }, go = { dataset: {} }, messages = [], writes = [];
      const hist = { innerHTML: '', scrollHeight: 1000, scrollTop: 0, clientHeight: 100 };
      const localStorage = { setItem: (k,v) => store.set(k,v), getItem: k => store.get(k) ?? null, removeItem: k => store.delete(k) };
      const noop = () => {}, fitLine = noop, goMode = noop, drawAtts = noop, redraw = noop, markRows = noop, save = noop, slashDraw = noop, peekWarm = noop;
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
  const haiku = (read) => replyCost(['k', 'd', 100, 200, 20, 30, read, 'claude/claude-haiku-5-5', false]);
  near(haiku(99850), (185 * 0.1 + 200 * 0.5 + 99850 * 0.01) / 1e6);
  near(haiku(99851), (185 * 0.5 + 200 * 2.5 + 99851 * 0.05) / 1e6);
  // 本地代理's names (a gateway's provider/ before the model's): its own price, not Opus 5.5's for any it doesn't know
  assert.equal(replyCost(['k', 'd', 1e6, 0, 0, 0, 0, 'claude/claude-sonnet-5-5', false]), 2); assert.equal(replyCost(['k', 'd', 1e6, 0, 0, 0, 0, 'claude/claude-fable-5-1', false]), 10);
  // Gemini's (agy's name: its effort after it), by the reply's day where Google changes a price on one
  assert.deepEqual([['2026-11-30', 'gemini-4-argon-high'], ['2026-12-01', 'gemini-4-argon-high'], ['2026-12-31', 'gemini-3.8-flash'], ['2027-01-01', 'gemini-3.8-flash'], ['2026-11-21', 'gemini-4-neon-xhigh']]
    .map(([d, m]) => +replyCost(['k', d, 1e6, 1e6, 0, 0, 1e6, m, false]).toFixed(3)), [12.1, 24.2, 4.575, 9.15, 18.15]);
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

// The Mac mini's conversations, from the copy the web service keeps (accounts\mac): listed though their folder is the
// Mac's, as running (busy) by live.json, the Mac's pid negative (never one of this PC's), under its label. And the
// watcher that runs on the Mac is valid Python.
{
  const fs = require('fs'), path = require('path');
  const { listSessions, MAC_WATCH, macName } = require('./claude-multi');
  const id = '0f1e2d3c-4b5a-4968-8776-655443322110', dir = path.join(TEST_HOME, '.claude-multi', 'accounts', 'mac');
  fs.mkdirSync(path.join(dir, 'projects', '-Users-me-Desktop-mine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', '-Users-me-Desktop-mine', `${id}.jsonl`),
    JSON.stringify({ type: 'user', cwd: '/Users/me/Desktop/mine', message: { role: 'user', content: 'hi' } }) + '\n'
    + JSON.stringify({ type: 'ai-title', aiTitle: '在 Mac 上改文件' }) + '\n');
  fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify([{ pid: 4321, sessionId: id, status: 'busy', kind: 'interactive' }]));
  const reg = { profiles: [], mac: { host: 'mini', dir: '~/Desktop/mine' } };
  const heads = new Map(), s = listSessions(reg, heads).find((x) => x.id === id);
  assert.ok(s, 'the Mac one listed');
  const restored = new Map(JSON.parse(JSON.stringify([...heads]))), open = fs.openSync;
  try {
    fs.openSync = (file, ...args) => { if (file === s.file) throw new Error('unexpected transcript read'); return open(file, ...args); };
    assert.equal(listSessions(reg, restored).find((x) => x.id === id).title, s.title);
  } finally { fs.openSync = open; }
  assert.deepEqual([s.mac, s.acct, s.pid, s.busy, s.who, s.title], ['mac', -1, -4321, true, 'Mac mini', '在 Mac 上改文件']);
  assert.equal(listSessions({ profiles: [] }).some((x) => x.id === id), false); // no Mac set up: not listed
  // one in a project's folder there (mine/demo-sim): shown in the folder here it's for (folders.json), running where it runs
  const id2 = '1f1e2d3c-4b5a-4968-8776-655443322110', sub = path.join(dir, 'projects', '-Users-me-Desktop-mine-demo-sim');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, `${id2}.jsonl`), JSON.stringify({ type: 'user', cwd: '/Users/me/Desktop/mine/demo-sim', message: { role: 'user', content: '改一下' } }) + String.fromCharCode(10)
    + JSON.stringify({ type: 'ai-title', aiTitle: '改 demo-sim' }) + String.fromCharCode(10));
  fs.writeFileSync(path.join(dir, 'folders.json'), JSON.stringify({ 'demo-sim': String.raw`F:\demo-sim` }));
  const s2 = listSessions(reg).find((x) => x.id === id2);
  assert.deepEqual([s2.mac, s2.cwd, s2.macCwd], ['mac',String.raw`F:\demo-sim`, '/Users/me/Desktop/mine/demo-sim']);
  assert.equal(listSessions(reg).find((x) => x.id === id).cwd, '/Users/me/Desktop/mine'); // the Mac's own folder: as it is
  // one in a subfolder of a project there that has another project's name: not that project's
  const id3 = '2f1e2d3c-4b5a-4968-8776-655443322110', sub3 = path.join(dir, 'projects', '-Users-me-Desktop-mine-x-demo-sim');
  fs.mkdirSync(sub3, { recursive: true });
  fs.writeFileSync(path.join(sub3, `${id3}.jsonl`), JSON.stringify({ type: 'user', cwd: '/Users/me/Desktop/mine/x/demo-sim', message: { role: 'user', content: '改一下' } }) + String.fromCharCode(10)
    + JSON.stringify({ type: 'ai-title', aiTitle: '改 x 里的' }) + String.fromCharCode(10));
  assert.equal(listSessions(reg).find((x) => x.id === id3).cwd, '/Users/me/Desktop/mine/x/demo-sim');
  // a folder here's name there: its last part, a drive's root its letter, nothing sh or a path would take otherwise
  assert.deepEqual([String.raw`F:\demo-sim`, 'F:/', String.raw`D:\a\my proj's`, String.raw`D:\-x`, String.raw`D:\论文 返修`].map(macName),
    ['demo-sim', 'F', 'my-proj-s', 'x', '论文-返修']);
  fs.writeFileSync(path.join(dir, 'live.json'), '[]');
  const replica = path.join(dir, 'projects', '-Users-me-Desktop-mine', id + '.jsonl'), bytes = fs.readFileSync(replica);
  const registry = path.join(TEST_HOME, '.claude-multi', 'profiles.json'), prior = fs.readFileSync(registry);
  try {
    fs.writeFileSync(registry, JSON.stringify(reg));
    const r = require('child_process').spawnSync(process.execPath, [require.resolve('./claude-multi'), 'rename', id, '新标题'], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stdout, /Mac 上的对话/);
    assert.deepEqual(fs.readFileSync(replica), bytes);
    assert.ok(!fs.existsSync(replica.slice(0, -6)));
  } finally { fs.writeFileSync(registry, prior); }
  assert.equal(listSessions(reg).find((x) => x.id === id).pid, null); // ended there
  // an API 额度 one: begun by the Agent SDK (entrypoint sdk-ts, sdk-py for Python's); claude -p's (sdk-cli) is Claude Code's own
  const ep = (n, e) => { const f = `${n}f1e2d3c-4b5a-4968-8776-655443322110`; fs.writeFileSync(path.join(dir, 'projects', '-Users-me-Desktop-mine', `${f}.jsonl`),
    JSON.stringify({ type: 'user', cwd: '/Users/me/Desktop/mine', entrypoint: e, message: { role: 'user', content: 'hi' } }) + '\n' + JSON.stringify({ type: 'last-prompt', lastPrompt: e }) + '\n'); return f; };
  const eps = [['5', 'sdk-ts'], ['6', 'sdk-py'], ['7', 'sdk-cli'], ['8', 'cli']].map(([n, e]) => ep(n, e)), all = listSessions(reg);
  assert.deepEqual(eps.map((f) => all.find((x) => x.id === f)?.sdk ?? false), [true, true, false, false]);
  const py = require('child_process').spawnSync('python', ['-c', 'import sys; compile(sys.stdin.read(), "watch", "exec")'],
    { input: `DIR = "~"\nCFG = None\nHAVE = {}\n${MAC_WATCH}`, encoding: 'utf8' });
  if (py.error) console.log('(no python here: the Mac watcher not compiled)'); else assert.equal(py.status, 0, py.stderr);
  // and run (this PC's python, in a home of its own; async: the timing tests run meanwhile): a record of ours, one of its
  // subagents', each sent as it is; and one of another folder there, of which only each reply's id, model, time and usage
  // go out, nothing said
  if (!py.error) {
    const H = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cm-mw-')), mine = path.join(H, 'Desktop', 'mine'), P = path.join(H, '.claude', 'projects');
    fs.mkdirSync(mine, { recursive: true });
    const base = fs.realpathSync.native(mine).replace(/[^a-zA-Z0-9]/g, '-'), nl = String.fromCharCode(10);
    const rec = JSON.stringify({ type: 'user', message: { content: '我的话' } }) + nl, usage = { input_tokens: 1, output_tokens: 2 };
    fs.mkdirSync(path.join(P, base, 'c1', 'subagents'), { recursive: true }); fs.mkdirSync(path.join(P, '-other'), { recursive: true });
    fs.writeFileSync(path.join(P, base, 'c1.jsonl'), rec);
    fs.writeFileSync(path.join(P, base, 'c1', 'subagents', 'agent-a.jsonl'), rec);
    const other = path.join(P, '-other', 'c2.jsonl');
    fs.writeFileSync(other, JSON.stringify({ type: 'user', message: { content: '别人的话' } }) + nl + JSON.stringify({ type: 'assistant', timestamp: '2099-01-01T00:00:00.000Z',
      requestId: 'req_1', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'text', text: '别人的回答' }], usage } }) + nl);
    const w = require('child_process').spawn('python', ['-u', '-'], { env: { ...process.env, USERPROFILE: H, HOME: H } });
    let out = '', err = '';
    const stop = setTimeout(() => w.kill(), 5000); // it runs till killed: once the other folder's line is out, or by then
    w.stdout.on('data', (d) => { out += d; if (/"o": "-other\/c2\.jsonl".*\n/.test(out)) w.kill(); });
    w.stderr.on('data', (d) => { err += d; });
    w.stdin.end(`DIR = ${JSON.stringify(mine)}${nl}CFG = None${nl}HAVE = {}${nl}OTHER = {}${nl}${MAC_WATCH}`);
    w.on('exit', () => {
      clearTimeout(stop);
      const got = out.split(nl).filter(Boolean).map((l) => JSON.parse(l)), sent = (k) => Buffer.from(got.find((o) => o.f === k)?.d ?? '', 'base64').toString();
      assert.equal(sent(`${base}/c1.jsonl`), rec, err);
      assert.equal(sent(`${base}/c1/subagents/agent-a.jsonl`), rec);
      const o = got.find((x) => x.o === '-other/c2.jsonl'), d = Buffer.from(o.d, 'base64').toString();
      assert.deepEqual([o.at, o.to], [0, fs.statSync(other).size]);
      assert.deepEqual(JSON.parse(d), { type: 'assistant', timestamp: '2099-01-01T00:00:00.000Z', requestId: 'req_1', message: { id: 'msg_1', model: 'claude-opus-5-5', usage } });
      fs.rmSync(H, { recursive: true, force: true });
      console.log('mac watcher run ok');
    });
  }
  // the names taken from the Mac: a record, a conversation's folder, a record of its subagents; nothing leading out
  {
    const src = /const macPath = .*/.exec(fs.readFileSync(path.join(__dirname, 'claude-multi.js'), 'utf8'))[0];
    const macPath = new Function('path', `${src} return macPath;`)(path.posix).bind(null, '/m');
    assert.equal(macPath('p/a.jsonl'), '/m/projects/p/a.jsonl');
    assert.equal(macPath('p/id/'), '/m/projects/p/id');
    assert.equal(macPath('p/id/subagents/agent-1.jsonl'), '/m/projects/p/id/subagents/agent-1.jsonl');
    assert.equal(macPath('p/a.jsonl', 'others'), '/m/others/p/a.jsonl');
    for (const bad of ['../x', 'p/../x', 'p/id/other/a.jsonl', 'p/id/subagents/../../../x', 'p/id/subagents/a/b', '/p/a']) assert.throws(() => macPath(bad), /不认识的名字/, bad);
  }
  // a Claude there in our tmux: new, continued (one running there joined first), or its session joined again
  const { macCmd } = require('./claude-multi');
  const script = (c) => Buffer.from(/echo (\S+) \| base64 -D/.exec(c)[1], 'base64').toString();
  const fresh = script(macCmd({ into: 'cd ~/Desktop/mine', name: 'cm-p1', cols: 80, rows: 24 }));
  assert.match(fresh, /new-session -d -s "\$S" -x 80 -y 24 -c "\$PWD" 'exec ~\/.local\/bin\/claude' \|\| exit/);
  assert.ok(!fresh.includes('grep -l') && fresh.includes("S='cm-p1'") && fresh.indexOf('unset LC_MACKC') < fresh.indexOf('start-server'));
  const again = script(macCmd({ into: 'cd x', resume: id, name: 'cm-p2' }));
  assert.ok(again.includes(`grep -l '${id}' ~/.claude/sessions/*.json`) && again.includes(`'exec ~/.local/bin/claude --resume ${id}'`));
  assert.equal(macCmd({ sess: 'cm-p1' }), `T=/opt/homebrew/bin/tmux; [ -x "$T" ] || T="$HOME"/.local/bin/tmux; exec "$T" -u -f /dev/null -L cm attach -t 'cm-p1'`);
  // its tmux: Homebrew's, else ~/.local's (built there on a Mac without Homebrew); none: said so
  {
    const r = require('child_process').spawnSync('sh', ['-c', `${/^T=.*$/m.exec(fresh)[0]}; echo "$T"`], { env: { ...process.env, HOME: '/no-such-home' }, encoding: 'utf8' });
    if (!r.error) assert.equal(r.stdout.trim(), '/no-such-home/.local/bin/tmux'); // (no Homebrew here)
  }
  const sh = require('child_process').spawnSync('sh', ['-n'], { input: again, encoding: 'utf8' });
  if (sh.error) console.log('(no sh here: the Mac script not parsed)'); else assert.equal(sh.status, 0, sh.stderr);
  // the PC project's CLAUDE.md after the Mac folder's: packed into the start's sh; none there, or too big: only the old one taken out
  {
    const { macRules } = require('./claude-multi'), pc = path.join(TEST_HOME, 'pc-proj');
    fs.mkdirSync(pc, { recursive: true });
    assert.ok(!macRules(pc).includes('gunzip') && macRules(pc).includes("awk '/^<!-- cm-pc-rules/{exit}{print}'"));
    fs.writeFileSync(path.join(pc, 'CLAUDE.md'), '\uFEFF# 规矩\n\n- 先跑测试\n');
    const put = /^{ T=CLAUDE\.md\.cm\.\$\$; .* && echo (\S+) \| base64 -D \| gunzip >> \$T && mv \$T CLAUDE.md \|\| rm -f \$T; }$/.exec(macRules(pc));
    const text = require('zlib').gunzipSync(Buffer.from(put[1], 'base64')).toString();
    assert.match(text, /^<!-- cm-pc-rules: [^\n]*pc-proj\/CLAUDE.md[^\n]* -->\n\n# 规矩\n\n- 先跑测试\n$/);
    fs.writeFileSync(path.join(pc, 'CLAUDE.md'), require('crypto').randomBytes(20000).toString('hex'));
    assert.ok(!macRules(pc).includes('gunzip'));
    const sh2 = require('child_process').spawnSync('sh', ['-n'], { input: macRules(pc), encoding: 'utf8' });
    if (!sh2.error) assert.equal(sh2.status, 0, sh2.stderr);
  }
  // a reply of the Mac's other folders as the watcher sends it (its usage only): counted like a record's, as an amount beside the Mac's
  {
    const { tokenStats } = require('./claude-multi'), od = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cm-oth-'));
    fs.mkdirSync(path.join(od, 'others', 'p'), { recursive: true });
    fs.writeFileSync(path.join(od, 'others', 'p', 's.jsonl'), '{"type":"assistant","timestamp":"2026-11-09T11:18:30.593Z","requestId":"req_1","message":{"id":"msg_1","model":"claude-opus-5-5","usage":{"input_tokens":2,"cache_creation_input_tokens":10,"cache_read_input_tokens":3,"output_tokens":4}}}\n');
    const ts = tokenStats([{ id: 'mac', label: 'M', dir: path.join(od, 'projects'), mac: true }, { id: 'mac-other', of: 'mac', label: '', dir: path.join(od, 'others'), other: true }], path.join(od, 'c.json'), path.join(od, 'no.log'));
    assert.deepEqual([ts.total, ts.usd, ts.days.length, ts.accounts.length, ts.accounts[0].mac, ts.accounts[0].plus > 0], [0, 0, 0, 1, true, true]); // in no total: beside the Mac's
    fs.rmSync(od, { recursive: true, force: true });
  }
  // the Mac's password file (ConvertFrom-SecureString: DPAPI, this Windows user) read back by .NET alone; a broken one says
  // why. In a node of its own: its PowerShells, run here, held up the timed waits going on meanwhile
  require('child_process').execFile(process.execPath, ['-e', `
    const { dpapiRead } = require(${JSON.stringify(require.resolve('./claude-multi'))}), fs = require('fs'), f = ${JSON.stringify(path.join(TEST_HOME, "O'Brien.dpapi"))};
    fs.writeFileSync(f, require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-Command', "ConvertTo-SecureString 'pw Test-1' -AsPlainText -Force | ConvertFrom-SecureString"], { encoding: 'utf8' }).stdout.trim());
    const good = dpapiRead(f).stdout; fs.writeFileSync(f, 'abcd'); const bad = dpapiRead(f);
    console.log(JSON.stringify([good, bad.stdout, bad.stderr]));`], { encoding: 'utf8' }, (e, out) => {
    assert.ifError(e);
    const [good, badOut, badErr] = JSON.parse(out);
    assert.equal(good.replace(/\r?\n$/, ''), 'pw Test-1');
    assert.ok(!badOut.trim() && /Unprotect/.test(badErr), badErr);
    console.log('mac password read ok');
  });
  console.log('mac mini ok');
}
// More Macs (the registry's macs, beside the Mac mini): each an account there, its own config dir. Listed from its own
// copy (accounts\<id>) under its label, mac its id; started with that config dir, its sign-in looked up under the name
// Claude Code files it by; an id that would name another folder here, or no host, left out.
{
  const fs = require('fs'), path = require('path');
  const { listSessions, macList, macCmd, MAC_USAGE } = require('./claude-multi');
  const la = { id: 'la-a1', host: 'mymac', dir: '~/work', config: '~/claude/a1', label: 'Mac a1', icon: 'rainbow' };
  const reg = { profiles: [], mac: { host: 'mini', dir: '~/Desktop/mine' },
    macs: [la, { id: 'mac', host: 'x', dir: '~' }, { id: 'acct-1', host: 'x', dir: '~' }, { id: '../x', host: 'x', dir: '~' }, { id: 'nohost', dir: '~' }, { id: 'h', host: 'a b', dir: '~' }] };
  assert.deepEqual(macList(reg).map((m) => [m.id, m.config, m.label]), [['mac', null, 'Mac mini'], ['la-a1', la.config, 'Mac a1']]);
  const id = '3f1e2d3c-4b5a-4968-8776-655443322110', dir = path.join(TEST_HOME, '.claude-multi', 'accounts', 'la-a1', 'projects', '-Users-me-work');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: '/Users/me/work', message: { role: 'user', content: 'hi' } }) + '\n'
    + JSON.stringify({ type: 'ai-title', aiTitle: '在 Mac 上' }) + '\n');
  fs.writeFileSync(path.join(TEST_HOME, '.claude-multi', 'accounts', 'la-a1', 'live.json'), JSON.stringify([{ pid: 77, sessionId: id, status: 'idle', kind: 'interactive' }]));
  const s = listSessions(reg).find((x) => x.id === id);
  assert.deepEqual([s.mac, s.acct, s.pid, s.who, s.cwd], ['la-a1', -1, -77, 'Mac a1', '/Users/me/work']);
  // started with its config dir, as its launcher sets it ($HOME's, the string its sign-in is filed under); continued: its sessions there
  const script = (c) => Buffer.from(/echo (\S+) \| base64 -D/.exec(c)[1], 'base64').toString();
  const fresh = script(macCmd({ into: 'cd x', name: 'cm-p3', config: la.config }));
  assert.ok(fresh.includes(`'exec env CLAUDE_CONFIG_DIR="$HOME"/'\\''claude/a1'\\'' ~/.local/bin/claude'`), fresh);
  const again = script(macCmd({ into: 'cd x', resume: id, name: 'cm-p4', config: la.config }));
  assert.ok(again.includes(`grep -l '${id}' "$HOME"/'claude/a1'/sessions/*.json`), again);
  const sh = require('child_process').spawnSync('sh', ['-n'], { input: again, encoding: 'utf8' });
  if (!sh.error) assert.equal(sh.status, 0, sh.stderr);
  // the keychain name: sha256 of its config dir, first 8 hex, as Claude Code 2.1.323 names a sign-in (checked on a real Mac) (Claude Code-credentials-85b28ada)
  const svc = /^svc = .*$/m.exec(MAC_USAGE)[0];
  const py = require('child_process').spawnSync('python', ['-c', `import hashlib, os\nCFG = '/Users/me/claude/a1'\n${svc}\nprint(svc)`], { encoding: 'utf8' });
  if (!py.error) assert.equal(py.stdout.trim(), 'Claude Code-credentials-85b28ada', py.stderr);
  console.log('more macs ok');
}

// the web service's process check runs beside, never waited on (waiting on PowerShell froze every terminal once a
// minute): at once the pid alone (null), a moment later the start times
{
  const cli = require('path').join(__dirname, 'claude-multi.js');
  require('child_process').execFile(process.execPath, ['-e', `const { procStarts } = require(${JSON.stringify(cli)}); procStarts.beside = true;
const t = Date.now(), first = procStarts([process.pid]), quick = Date.now() - t < 100, end = Date.now() + 20000;
(function poll() { const m = procStarts([process.pid]); if (m || Date.now() > end) { console.log(JSON.stringify([first, quick, !!m?.get(String(process.pid))])); process.exit(0); } setTimeout(poll, 100); })();`], { encoding: 'utf8' }, (err, out) => {
    try { assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), [null, true, true]); console.log('process check beside ok'); } // not waited on: the timed tests above go on
    catch (e) { console.error(e); process.exitCode = 1; }
  });
}

// the page's usage counted beside, in a child node (counting it in the web service held every terminal ~0.3 s): the
// same fields as counted here, the 管家's cost with them
{
  const { tokensBeside, tokenStats, butlerCost } = require('./claude-multi');
  const here = Object.keys({ ...tokenStats(), butler: butlerCost() }).sort();
  tokensBeside().then((t) => { assert.deepEqual(Object.keys(t).sort(), here); assert.ok(t.butler && Array.isArray(t.days)); console.log('usage beside ok'); },
    (e) => { console.error(e); process.exitCode = 1; });
}

// a page that opens a busy terminal late still gets its modes: the mouse (the band's buttons), the full screen, paste
{
  const { keepOut, replayPty } = require('./claude-multi');
  const t = { buf: '' };
  keepOut(t, '\x1b[?1049h\x1b[?1003h\x1b[?100'); keepOut(t, '6h\x1b[?2004h\x1b[?2026h'); // a switch cut between two pieces
  for (let i = 0; i < 300; i++) keepOut(t, 'x'.repeat(1024)); // 300 KB more: the switches long out of the kept output
  keepOut(t, '\x1b[?2004l');
  const r = replayPty(t), head = r.slice(0, r.length - t.buf.length);
  assert.ok(!t.buf.includes('\x1b[?1003h') && t.buf.length === 262144 && r.endsWith(t.buf));
  assert.deepEqual(head.match(/\x1b\[\?\d+[hl]/g).sort(), ['\x1b[?1003h', '\x1b[?1006h', '\x1b[?1049h', '\x1b[?2004h']); // enabled at the cut; the retained output turns paste off
  console.log('replay modes ok');
}
// a Mac's CPU and memory as the page draws them: its numbers only (the page puts them in its HTML)
{
  const { macSysOf } = require('./claude-multi');
  assert.deepEqual(macSysOf({ cpu: 12, cpuClaude: 3, mem: 8e9, memClaude: 2e9, memAll: 16e9, n: 2 }), { cpu: 12, cpuClaude: 3, mem: 8e9, memClaude: 2e9, memAll: 16e9, n: 2 });
  assert.deepEqual(macSysOf({ cpu: '<img src=x onerror=alert(1)>', n: '3', mem: NaN, memAll: 16e9, evil: 1 }), { memAll: 16e9 });
  assert.deepEqual(macSysOf(null), {});
  console.log('mac sys ok');
}
// GPT 聊天: its answer under way at OpenAI is kept in the chat though a file of the message won't move into the chat's
// folder (sent twice in one message): the second stays where the first went
(async () => {
  const fs = require('fs'), path = require('path'), { oaiSend, oaiRead } = require('./claude-multi');
  const root = path.join(TEST_HOME, '.claude-multi'), up = path.join(root, 'uploads'), f = path.join(up, '20261122T000000-abcdef-笔记.txt');
  fs.writeFileSync(path.join(root, 'openai-key.txt'), 'sk-test'); fs.mkdirSync(up, { recursive: true }); fs.writeFileSync(f, '内容');
  const real = globalThis.fetch, asked = [];
  globalThis.fetch = async (u, o) => { // (another test's, running meanwhile: the real one)
    if (!String(u).startsWith('https://api.openai.com/')) return real(u, o);
    asked.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ id: 'resp_1' }) };
  };
  try {
    const { id } = await oaiSend({ text: '看看', paths: [f, f], mode: 'standard', effort: 'low' });
    const c = oaiRead(id), moved = path.join(root, 'oai', id, path.basename(f));
    assert.deepEqual([asked.length, c.pending, c.msgs[0].files, fs.existsSync(moved), fs.existsSync(f)], [1, 'resp_1', [moved, moved], true, false]);
    const { oaiPoll, oaiStop } = require('./claude-multi'), mode = { id, mode: 'standard', effort: 'low' };
    fs.writeFileSync(path.join(root, 'island-off'), '');
    let result = { status: 'completed', id: 'resp_1', output: [{ type: 'message', content: [{ text: '好了' }] }] }, status = 200;
    let hold;
    globalThis.fetch = async (u, opts) => {
      if (!String(u).startsWith('https://api.openai.com/')) return real(u, opts);
      if (opts.method === 'GET' && hold) await hold;
      return { ok: status === 200, status, json: async () => result };
    };
    await oaiPoll();
    assert.equal(oaiRead(id).msgs.at(-1).text, '好了');
    for (const code of [200, 404]) {
      result = { id: 'resp_2' }; status = 200; await oaiSend({ ...mode, text: '继续' });
      status = 503; await oaiPoll(); assert.equal(oaiRead(id).pending, 'resp_2');
      result = { status: 'incomplete', incomplete_details: { reason: 'limit' } }; status = code;
      await oaiPoll();
      const chat = oaiRead(id); assert.equal(chat.pending, null); assert.equal(chat.resp, 'resp_1');
      assert.match(chat.msgs.at(-1).text, code === 404 ? /404/ : /limit/);
    }
    status = 200; result = { id: 'resp_3' }; await oaiSend({ ...mode, text: '停止测试' });
    let release; hold = new Promise((ok) => { release = ok; });
    const poll = oaiPoll(); await oaiStop(id); release(); await poll;
    assert.equal(oaiRead(id).msgs.at(-1).role, 'note'); assert.match(oaiRead(id).msgs.at(-1).text, /已停止/);
    assert.equal(oaiRead(id).pending, null);
    let finishBin;
    const deleting = require('./claude-multi').oaiDelete(id, () => new Promise((ok) => { finishBin = ok; }));
    await assert.rejects(oaiSend({ ...mode, text: '不能丢掉的消息' }), /正在删除/);
    finishBin({ status: 1, stderr: '文件正在使用' });
    await assert.rejects(deleting, /文件正在使用/); assert.equal(oaiRead(id).pending, null);
  } finally { globalThis.fetch = real; }
  console.log('gpt chat files and polling ok');
})().catch((e) => { console.error(e); process.exitCode = 1; });
// 休眠: which conversations running in the web service are ended to free memory, and the shells that keep one going
{
  const { dozable, shellsIn } = require('./claude-multi'), H = 3600e3, now = 10 * H;
  const t = (o = {}) => ({ kind: 'pty', pid: 7, clients: new Set(), outAt: now - 2 * H, dir: 'C:/acct', ...o });
  const idle = { status: 'idle', statusUpdatedAt: now - 2 * H }, none = new Set();
  assert.equal(dozable(t(), idle, none, now), true); // a Claude idle by its own word for two hours, nobody looking, nothing typed
  for (const [why, x, j, sh] of [
    ['a page shows it', t({ clients: new Set([1]) }), idle, none], ['idle for half an hour', t(), { ...idle, statusUpdatedAt: now - H / 2 }, none],
    ['at work', t(), { ...idle, status: 'busy' }, none], ['running a command', t(), { ...idle, status: 'shell' }, none],
    ['asking you', t(), { ...idle, status: 'waiting' }, none], ['its state unread', t(), null, none],
    ['a shell of its own under it (a background command)', t(), idle, new Set([7])], ['which shells: unknown', t(), idle, null],
    ['typed in ten minutes ago', t({ typed: now - H / 6 }), idle, none], ['a Mac\'s', t({ mac: 'mac' }), idle, none],
    ['switching accounts', t({ switching: true }), idle, none], ['ended already', t({ gone: true }), idle, none],
    ['a terminal window\'s (its reader)', t({ kind: 'pc' }), idle, none], ['no pid yet', t({ pid: 0 }), idle, none],
  ]) assert.equal(dozable(x, j, sh, now), false, why);
  // a GPT or Gemini one (no session file): by what it last showed
  assert.deepEqual([dozable(t({ dir: undefined }), null, none, now), dozable(t({ dir: undefined, outAt: now - H / 2 }), null, none, now)], [true, false]);
  // Win32_Process's "<parent> <name>" and ps's "<ppid> <path>": the shells' parents, not MCP's cmd or node
  assert.deepEqual([...shellsIn('  4 System\r\n 54336 bash.exe\r\n 54336 cmd.exe\r\n 811 powershell.exe\r\n 812 pwsh.exe\r\n 9 node.exe\r\n 10 bashful.exe\r\n')], [54336, 811, 812]);
  assert.deepEqual([...shellsIn('  501 /bin/zsh\n  502 -zsh\n  503 /bin/sh\n  504 /usr/bin/ssh\n')], [501, 503]);
  console.log('休眠 ok');
}
// A file sent in a conversation, opened from the page: a PDF shown (no sandbox: it'd get no viewer), text and pictures
// shown sandboxed, the page's own kinds (HTML, SVG) and anything else downloaded; its name as sent; only a saved upload's name
{
  const { fileServed } = require('./claude-multi');
  const h = (n) => fileServed(n)?.headers;
  assert.deepEqual([h('20261113T081500-a1b2c3-全文-中文-v16.pdf')['content-type'], h('20261113T081500-a1b2c3-全文-中文-v16.pdf')['content-security-policy']], ['application/pdf', undefined]);
  assert.equal(h('20261113T081500-a1b2c3-全文-中文-v16.pdf')['content-disposition'], `inline; filename*=UTF-8''${encodeURIComponent('全文-中文-v16.pdf')}`);
  assert.deepEqual([h('20261113T081500-a1b2c3-a.txt')['content-type'], h('20261113T081500-a1b2c3-a.txt')['content-security-policy']], ['text/plain; charset=utf-8', 'sandbox']);
  for (const bad of ['x.html', 'x.svg', 'x.htm', 'x.docx', 'x']) {
    const x = h(`20261113T081500-a1b2c3-${bad}`);
    assert.deepEqual([x['content-type'], x['content-disposition'].split(';')[0]], ['application/octet-stream', 'attachment'], bad);
  }
  for (const bad of ['../x.pdf', 'x.pdf', '20261113T081500-a1b2c3-../x.pdf', String.raw`20261113T081500-a1b2c3-a\b.pdf`, '20261113T081500-zzzzzz-a.pdf', '']) assert.equal(fileServed(bad), null, bad);
  const at = fileServed('20261113T081500-a1b2c3-a.pdf').file;
  assert.ok(at.endsWith(require('path').join('uploads', '20261113T081500-a1b2c3-a.pdf')), at);
  // one sent in a GPT 聊天: moved into that chat's folder, found there by its saved name
  const fs = require('fs'), path = require('path'), os = require('os'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-files-'));
  const up = path.join(tmp, 'uploads'), oai = path.join(tmp, 'oai'), n = '20261113T060145-8c06a5-全文-v16.pdf';
  fs.mkdirSync(up); fs.mkdirSync(path.join(oai, 'oai-1'), { recursive: true }); fs.writeFileSync(path.join(oai, 'oai-1.json'), '{}'); fs.writeFileSync(path.join(oai, 'oai-1', n), 'x');
  assert.equal(fileServed(n, up, oai).file, path.join(oai, 'oai-1', n));
  assert.equal(fileServed('20261113T060145-8c06a5-gone.pdf', up, oai).file, path.join(up, '20261113T060145-8c06a5-gone.pdf')); // nowhere: the uploads (not there: 不在了)
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('files opened ok');
}
// 预览: a file of this PC by its path: a PDF, a picture or a video as itself (a PDF unsandboxed: its viewer), text sandboxed
// (a web page or an SVG too: never as one), an Office one as its PDF, the rest downloaded. An Office one made a PDF once (by
// path, time and size; two asks at once: one making), none half-made left, a failure said. `/`'s list: no internal,
// removed or renamed ones
{
  const { peekHead, peekPdf, slashKeep, macSlashCmd, slashParse, shellCmd, frontOf, FRONT_PS } = require('./claude-multi');
  // `/` in a Mac's conversation: asked on that Mac, in its folder (its own folder if that's gone), on the account its
  // conversations use; the answer found among what it printed, or why not
  const mc = macSlashCmd({ id: 'm', dir: '~/work', config: '~/.claude-cm' }, "/Users/x/it's");
  assert.ok(mc.includes(`cd '/Users/x/it'\\''s' || cd "$HOME"/'work'`), mc);
  assert.ok(mc.includes(`printf '%s\\n' '{"type":"control_request","request_id":"cm","request":{"subtype":"initialize"}}' | CLAUDE_CONFIG_DIR="$HOME"/'.claude-cm' ~/.local/bin/claude -p --input-format stream-json`), mc);
  assert.ok(mc.includes(`find "$HOME"/'.claude-cm'/sessions -name "$p.*" -delete`) && mc.includes('--no-session-persistence') && mc.startsWith('security unlock-keychain'), mc);
  assert.ok(macSlashCmd({ id: 'm', dir: '~/w' }, '/w').includes(`find "$HOME/.claude"/sessions`));
  const ans = (cmds) => JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { commands: cmds } } });
  assert.deepEqual(slashParse({ out: `{"type":"system"}\n${ans([{ name: 'maintain-formal-verification-skill', description: 'x' }, { name: '_hidden' }])}\n` }),
    [{ name: 'maintain-formal-verification-skill', desc: 'x', hint: '', also: [], builtin: false }]);
  assert.throws(() => slashParse({ status: 255, out: '', err: 'ssh: connect to host x port 22: Connection refused\n' }), /Connection refused/);
  assert.throws(() => slashParse({ status: -1, out: '', err: '30 秒没回' }), /30 秒没回/);
  // …and the window it opens brought to the front: an Explorer window at the folder (a file shown in its own, a script
  // never opened: shown); Windows' chooser; a file's own program's (no folder: found by its name)
  assert.equal(frontOf('D:\\a b', 'open', true).CM_DIR, 'D:\\a b');
  assert.equal(frontOf('D:\\a\\x.md', 'reveal', false).CM_DIR, 'D:\\a');
  assert.equal(frontOf('D:\\a\\run.bat', 'open', false).CM_DIR, 'D:\\a');
  assert.equal(frontOf('D:\\a\\x.md', 'open', false).CM_DIR, '');
  assert.deepEqual(frontOf('D:\\x.md', 'with', false), { CM_PATH: 'D:\\x.md', CM_HOW: 'with', CM_DIR: '' });
  assert.equal(frontOf('D:\\x.md', 'reveal', false).CM_DIR, 'D:\\'); // a drive's own file: Explorer at the drive
  if (process.platform === 'win32') (async () => { // the script as PowerShell reads it (its C# too): no window asked for, none found
    // at once (apart, not spawnSync: that would hold up the timed tests running beside it)
    const ps = FRONT_PS.replace('AddSeconds($(if ($dir) { 8 } else { 20 }))', 'AddSeconds(1)');
    const r = await new Promise((ok) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { env: { ...process.env, CM_PATH: 'Z:\\cmv-no-such\\x.cmvnone', CM_HOW: 'open', CM_DIR: '' }, encoding: 'utf8', windowsHide: true }, (e, out, err) => ok({ out, err })));
    assert.equal(r.out.trim(), 'none', r.err);
    console.log('front ok');
  })();
  // 右键's opening on this PC: a file with its own program, Windows' chooser (its path bare), Explorer at it; a program or a
  // script never opened (it'd run): Explorer at it instead; a folder in Explorer; anything else asked: Explorer at it
  assert.deepEqual(shellCmd('D:\\论文 04\\图7.pptx', 'open', false), ['explorer.exe', '"D:\\论文 04\\图7.pptx"']);
  assert.deepEqual(shellCmd('D:\\论文 04\\图7.pptx', 'with', false), ['rundll32.exe', 'shell32.dll,OpenAs_RunDLL D:\\论文 04\\图7.pptx']);
  assert.deepEqual(shellCmd('D:\\a\\x.md', 'reveal', false), ['explorer.exe', '/select,"D:\\a\\x.md"']);
  for (const f of ['D:\\a\\run.BAT', 'D:\\a\\setup.exe', 'D:\\a\\x.ps1', 'D:\\a\\t.js', 'D:\\a\\go.py', 'D:\\a\\l.lnk']) assert.deepEqual(shellCmd(f, 'open', false), ['explorer.exe', `/select,"${f}"`], f);
  assert.deepEqual(shellCmd('D:\\a b', 'open', true), ['explorer.exe', '"D:\\a b"']);
  assert.deepEqual(shellCmd('D:\\a\\x.md', 'rm', false), ['explorer.exe', '/select,"D:\\a\\x.md"']);
  const t = (n, o) => { const h = peekHead(n, o); return [h['content-type'], h['content-disposition'].split(';')[0], h['content-security-policy'] ?? '']; };
  assert.deepEqual(t('图7.pptx', true), ['application/pdf', 'inline', '']);
  assert.ok(peekHead('图7.pptx', true)['content-disposition'].endsWith(encodeURIComponent('图7.pptx.pdf')));
  assert.deepEqual(t('a.pdf'), ['application/pdf', 'inline', '']);
  assert.deepEqual(t('a.PNG'), ['image/png', 'inline', 'sandbox']);
  assert.deepEqual(t('a.mp4'), ['video/mp4', 'inline', 'sandbox']);
  for (const n of ['a.html', 'a.svg', 'a.py', 'Makefile', '.gitignore']) assert.deepEqual(t(n), ['text/plain; charset=utf-8', 'inline', 'sandbox'], n);
  assert.deepEqual(t('a.exe'), ['application/octet-stream', 'attachment', '']);
  assert.deepEqual([{ name: 'clear', description: 'x' }, { name: '__remote-workflow', description: 'x' }, { name: 'agents', description: '(removed) Ask Claude' },
    { name: 'extra-usage', description: 'Renamed to /usage-credits' }, { name: 'ponytail:ponytail' }].filter(slashKeep).map((c) => c.name), ['clear', 'ponytail:ponytail']);
  if (process.platform === 'win32') {
    const fs = require('fs'), path = require('path'), os = require('os'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-peek-')), dir = path.join(tmp, 'peek');
    const deck = path.join(tmp, '图 7.pptx'), deck2 = path.join(tmp, '图8.pptx'), bad = path.join(tmp, 'b.docx'), sheet = path.join(tmp, 'c.xlsx');
    for (const f of [deck, deck2, bad, sheet]) fs.writeFileSync(f, f);
    process.env.CM_RUNS = path.join(tmp, 'runs');
    const each = (body) => `foreach ($j in ($env:CM_JOBS | ConvertFrom-Json)) { ${body} }`;
    const ps = { ppt: 'Add-Content -LiteralPath $env:CM_RUNS -Value run; ' + each('Set-Content -LiteralPath $j.out -Value $j.in -Encoding UTF8; "ok $($j.k)"'),
      doc: each('"fail $($j.k) no Word here"'), xls: "throw 'no Excel here'" }, o = { dir, ps };
    Promise.all([peekPdf(deck, o), peekPdf(deck, o), peekPdf(deck2, o)]).then(async ([a, b, c2]) => {
      assert.equal(a, b); assert.notEqual(a, c2);
      assert.equal(fs.readFileSync(a, 'utf8').trim(), path.resolve(deck)); // its path through, a Chinese name and a space in it
      assert.equal(fs.readFileSync(c2, 'utf8').trim(), path.resolve(deck2));
      assert.equal(await peekPdf(deck, o), a); // kept: not made again
      assert.equal(fs.readFileSync(process.env.CM_RUNS, 'utf8').trim().split(/\s+/).length, 1); // two asked for at once: Office started once
      await assert.rejects(peekPdf(bad, o), /Word 没能把它转成 PDF：no Word here/);
      await assert.rejects(peekPdf(sheet, o), /Excel 没能把它转成 PDF：no Excel here/);
      assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(a), path.basename(c2)].sort()); // none half-made
      const lock = path.join(tmp, 'locked.pptx'); fs.writeFileSync(lock, 'x');
      const hold = { ppt: each('[IO.File]::WriteAllText($j.out, "pdf"); $f=[IO.File]::Open($j.out, "Open", "Read", "None"); "ok $($j.k)"; [Console]::Out.Flush(); Start-Sleep -Milliseconds 500; $f.Dispose()') };
      await assert.rejects(peekPdf(lock, { dir, ps: hold }), /没能把它转成 PDF/);
      await new Promise((ok) => setTimeout(ok, 1000));
      delete process.env.CM_RUNS; fs.rmSync(tmp, { recursive: true, force: true });
      console.log('peek ok');
    });
  } else console.log('peek ok (no Office here: no PDFs made)');
}
// 项目: made, renamed (names unique), conversations added from anywhere (each once) and taken out; dropped, its
// conversations untouched; nonsense refused
{
  const { projectOp } = require('./claude-multi');
  const all = [], op = (b) => projectOp(all, b, 1);
  assert.equal(op({ op: 'new', name: '  声速场   论文 ' }).id, 1);
  assert.equal(op({ op: 'new', name: '工具' }).id, 2);
  assert.throws(() => op({ op: 'new', name: '工具' }), /已经有/);
  assert.throws(() => op({ op: 'new', name: ' ' }), /名字/);
  assert.deepEqual(op({ op: 'add', id: 1, conv: ['a-1', 'b-2', 'a-1'] }).ids, ['a-1', 'b-2']);
  assert.deepEqual(op({ op: 'add', id: '1', conv: 'c-3' }).ids, ['a-1', 'b-2', 'c-3']);
  assert.deepEqual(op({ op: 'out', id: 1, conv: ['b-2'] }).ids, ['a-1', 'c-3']);
  assert.equal(op({ op: 'rename', id: 1, name: '声速场' }).name, '声速场');
  assert.throws(() => op({ op: 'rename', id: 1, name: '工具' }), /已经有/);
  assert.throws(() => op({ op: 'add', id: 1, conv: ['../x'] }), /对话 id/);
  assert.throws(() => op({ op: 'add', id: 9, conv: ['a-1'] }), /没有这个项目/);
  op({ op: 'drop', id: 2 });
  assert.equal(op({ op: 'new', name: '再一个' }).id, 2);
  assert.deepEqual(all.map((p) => [p.id, p.name, p.ids.join()]), [[1, '声速场', 'a-1,c-3'], [2, '再一个', '']]);
  console.log('projects ok');
}
// 新对话's 浏览: a folder's folders (no files; dot ones last; $Recycle.Bin and the like not) and the one above; a drive's
// top: '' above; none asked: the home folder first; one not there: said so
(async () => {
  const { dirsIn } = require('./claude-multi'), path = require('path'), os = require('os'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dirs-'));
  for (const d of ['b', '.hid', 'a', '$Recycle.Bin']) fs.mkdirSync(path.join(tmp, d));
  fs.writeFileSync(path.join(tmp, 'f.txt'), '');
  const r = await dirsIn(tmp);
  assert.deepEqual([r.path, r.up, r.dirs, r.files], [tmp, path.dirname(tmp), ['a', 'b', '.hid'].map((n) => path.join(tmp, n)), ['f.txt']]);
  assert.equal((await dirsIn(path.parse(tmp).root)).up, '');
  fs.mkdirSync(path.join(os.homedir(), 'Desktop'), { recursive: true }); // the test's home: a 桌面, no 文档
  const top = await dirsIn('');
  assert.deepEqual(top.dirs.slice(0, 2), [os.homedir(), path.join(os.homedir(), 'Desktop')]);
  assert.ok(!top.dirs.includes(path.join(os.homedir(), 'Documents')) && top.dirs.length > 2, 'the drives after');
  await assert.rejects(dirsIn(path.join(tmp, 'gone')), /打不开/);
  // a network folder: not looked at (\\?\ + a folder here is there, so only the guard says no)
  const { isDir } = require('./claude-multi');
  assert.deepEqual([isDir(tmp), isDir('\\\\?\\' + tmp), isDir('//?/' + tmp), isDir(undefined), isDir('')], [true, false, false, false, false]);
  await assert.rejects(dirsIn('\\\\?\\' + tmp), /网络/);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('folders to pick ok');
})();
// A Mac's usage read at most every 5 minutes (each read an ssh there and a request from it to Anthropic): read again
// within that, the first read's; 刷新 (fresh) reads now. (A Mac with no password saved here: no ssh at all.)
{
  const { macUsageNow } = require('./claude-multi'), m = { id: 'cache-test', host: 'no-such-mac', label: 'T' };
  const a = macUsageNow(m), b = macUsageNow(m), c = macUsageNow(m, true);
  assert.ok(a === b && c !== a, 'cached within 5 minutes, fresh reads again');
  c.then((r) => { assert.match(r.err, /密码/); console.log('mac usage every 5 min ok'); });
}
// 申请接入, against a stand-in apply service: applied, asked while it waits, approved: an API account with the key (your
// shared settings, less their own key), the record dropped and the service told; the same approval again: no second
// account; the key taken back: 额度 says so; rejected: said so
(async () => {
  const { joinApply, checkJoins, pointJoins, readJoins, fetchUsage, quotaSource } = require('./claude-multi'), http = require('http'), path = require('path');
  const reg = () => JSON.parse(fs.readFileSync(path.join(TEST_HOME, '.claude-multi', 'profiles.json'), 'utf8'));
  fs.mkdirSync(path.join(TEST_HOME, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(TEST_HOME, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'x', env: { KEEP: '1', ANTHROPIC_API_KEY: 'mine' }, hooks: { Stop: [] } }));
  let st = 'pending', models = 200, done = 0, quotas = 200, sdkOn = null;
  const srv = http.createServer((req, res) => {
    let s = '';
    req.on('data', (d) => (s += d)).on('end', () => {
      const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const b = s ? JSON.parse(s) : {};
      if (req.url === '/m/v1/models') return send(req.headers.authorization === 'Bearer sk-cm-test' ? models : 401, {});
      if (req.url === '/m/_quota') return send(req.headers.authorization === 'Bearer sk-cm-test' ? quotas : 401, [{ provider: 'claude', name: 'Claude Code', plan: 'pro', user: 's***@example.com', windows: [{ name: '5 hours', used: 14 }] }]);
      if (req.url === '/m/_sdk' && sdkOn) return send(req.headers.authorization === 'Bearer sk-cm-test' ? 200 : 401, sdkOn);
      if (req.url === '/m/apply') return send(200, { ticket: 'T-' + b.name });
      if (b.ticket === 'T-gone') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<html>Gone</html>'); }
      if (b.ticket !== 'T-me' && b.ticket !== 'T-no') return send(404, { err: '没有这个申请' });
      if (req.url === '/m/apply/done') { done++; return send(200, { ok: true }); }
      send(200, { state: b.ticket === 'T-no' ? 'rejected' : st, ...(st === 'approved' && { key: 'sk-cm-test' }) });
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/m`, mine = () => reg().profiles.filter((p) => p.api?.baseURL === url);
  await assert.rejects(joinApply({ url: 'ftp://x', name: 'me' }), /https/);
  const shown = await joinApply({ url: url + '/', name: 'me', note: 'n' });
  assert.deepEqual(shown.map((j) => [j.url, j.state, 'ticket' in j]), [[url, 'pending', false]]);
  await checkJoins();
  assert.equal(mine().length, 0);
  st = 'approved'; const rec = readJoins()[0];
  const accounts = path.join(TEST_HOME, '.claude-multi', 'accounts'), folders = fs.readdirSync(accounts).sort(), rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(TEST_HOME, '.claude-multi', 'profiles.json')) throw Object.assign(new Error('registry full'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  try { await assert.rejects(checkJoins(), /registry full/); } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readdirSync(accounts).sort(), folders);
  assert.equal(readJoins()[0].state, 'pending');
  await checkJoins();
  const [p] = mine(), s = JSON.parse(fs.readFileSync(path.join(p.configDir, 'settings.json'), 'utf8'));
  assert.deepEqual([p.api.join, p.subscriptionType, readJoins().length], [rec.id, 'API', 0]);
  assert.deepEqual([s.env.ANTHROPIC_BASE_URL, s.env.ANTHROPIC_AUTH_TOKEN, s.env.KEEP, s.env.ANTHROPIC_API_KEY, s.apiKeyHelper, !!s.hooks], [url, 'sk-cm-test', '1', undefined, undefined, true]);
  // through delta.js send once it listens (the web service runs it), straight again when it can't start; the rest kept
  const base = () => JSON.parse(fs.readFileSync(path.join(p.configDir, 'settings.json'), 'utf8')).env;
  pointJoins(true); assert.deepEqual([base().ANTHROPIC_BASE_URL, base().KEEP], [`http://127.0.0.1:7789/j/${p.id}`, '1']);
  pointJoins(false); assert.deepEqual([base().ANTHROPIC_BASE_URL, base().ANTHROPIC_AUTH_TOKEN], [url, 'sk-cm-test']);
  assert.ok(!fs.lstatSync(path.join(p.configDir, 'settings.json')).isSymbolicLink(), 'its own, not the shared one');
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.configDir, '.claude.json'), 'utf8')).hasCompletedOnboarding, true); // no first-run screens
  fs.writeFileSync(path.join(TEST_HOME, '.claude-multi', 'join.json'), JSON.stringify([rec])); // asked again: the same one
  await checkJoins();
  assert.deepEqual([mine().length, readJoins().length], [1, 0]);
  await new Promise((r) => setTimeout(r, 200)); assert.equal(done, 2); // told the service each time
  assert.deepEqual(await fetchUsage(p), { api: true }); // a gateway with no /_sdk (404): says nothing of API 额度
  // API 额度: the gateway's word for this account's key, off or on its list
  sdkOn = { on: false }; assert.deepEqual(await fetchUsage(p), { api: true, sdk: false });
  sdkOn = { on: true }; assert.deepEqual(await fetchUsage(p), { api: true, sdk: true }); sdkOn = null;
  // 代理额度 from the gateway joined, with the account's key; one that won't tell (403: Magpie's key not let see) adds nothing
  assert.deepEqual((await quotaSource().read()).quotas.map((q) => [q.name, q.plan, q.user]), [['Claude Code', 'pro', 's***@example.com']]);
  quotas = 403; assert.deepEqual((await quotaSource().read()).quotas, []); quotas = 200;
  models = 401;
  assert.match((await fetchUsage(p)).err, /接入已失效/);
  await joinApply({ url, name: 'no' }); // a new one at the same address replaces the last
  await checkJoins();
  assert.deepEqual(readJoins().map((j) => [j.name, j.state]), [['no', 'rejected']]);
  await joinApply({ url, name: 'gone' }); await checkJoins(); assert.equal(readJoins()[0].state, 'gone');
  // applied there again and approved (a new application, a new key): the same account takes it, no second one
  fs.writeFileSync(path.join(TEST_HOME, '.claude-multi', 'join.json'), JSON.stringify([{ ...rec, id: 'again1', state: 'pending' }]));
  assert.equal(await checkJoins(), 1);
  assert.deepEqual([mine().length, mine()[0].id, mine()[0].api.join], [1, p.id, 'again1']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.configDir, 'settings.json'), 'utf8')).env.KEEP, '1');
  srv.close();
  console.log('申请接入 ok');
})();
// web restart: the web port's pid read off netstat (no WMI), not another port's or a connection's; run in a Claude
// conversation, refused before anything is stopped
{
  const { webPid } = require('./claude-multi'), { spawnSync } = require('child_process');
  if (process.platform === 'win32') {
    const ns = ['  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1180', '  TCP    127.0.0.1:77880        0.0.0.0:0              LISTENING       999',
      '  TCP    127.0.0.1:7788         127.0.0.1:61000        ESTABLISHED     42', '  TCP    127.0.0.1:7788         0.0.0.0:0              LISTENING       56852'];
    assert.equal(webPid(ns.join('\r\n')), 56852);
    assert.equal(webPid(ns.slice(0, 3).join('\r\n')), null);
  } else assert.equal(webPid('56852\n'), 56852);
  const r = spawnSync(process.execPath, [require.resolve('./claude-multi'), 'web', 'restart'], { env: { ...process.env, CLAUDECODE: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stdout, /在终端里运行/);
  console.log('web restart ok');
}
// API accounts only (a Mac's, 申请接入's): the first one not refused is recommended, nothing to read; a subscription beside
// one: as before (its quota unread is said so, the API one not taken in its place)
(async () => {
  const { usageState } = require('./claude-multi'), path = require('path');
  const api = (id) => ({ id, configDir: path.join(TEST_HOME, id), api: { baseURL: 'http://127.0.0.1:9' } });
  const a = (await usageState({ profiles: [api('x1'), api('x2')] })).json;
  assert.deepEqual([a.rec, a.open], [0, true]);
  const b = (await usageState({ profiles: [{ id: 'sub1', configDir: path.join(TEST_HOME, 'sub1') }, api('x3')] })).json;
  assert.deepEqual([b.rec, b.open], [null, false]);
  console.log('API accounts only: the first recommended ok');
})();
// setup's settings: our notes and status line added to yours, once (run again: nothing new); your own status line kept
{
  const { withHooks } = require('./claude-multi'), js = 'C:/Users/me/.claude-multi/claude-multi.js';
  const mine = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
  const a = withHooks(mine, js);
  assert.deepEqual(a.s.hooks.Stop.map((e) => e.hooks[0].command), ['say done', `node "${js}" notify done`]);
  assert.deepEqual([a.s.hooks.Notification[0].matcher, a.s.hooks.Notification[0].hooks[0].command, a.s.statusLine.command, a.s.model, a.theirs],
    ['permission_prompt', `node "${js}" notify ask`, `node "${js}" statusline`, 'opus', false]);
  assert.equal(JSON.stringify(withHooks(a.s, js).s), JSON.stringify(a.s)); // again: the same
  const b = withHooks({ statusLine: { type: 'command', command: 'my-line' } }, js);
  assert.deepEqual([b.s.statusLine.command, b.theirs], ['my-line', true]);
  assert.equal(withHooks({ statusLine: { type: 'command', command: 'node "/old/claude-multi.js" statusline' } }, js).s.statusLine.command, `node "${js}" statusline`); // ours, moved
  console.log('setup settings ok');
}
// a Mac's running check: the pid's start (ps, in UTC) as Claude wrote it down, to the second; another program on a pid
// reused, or gone: not Claude; a start that can't be read: the pid alone
{
  const { sameStart } = require('./claude-multi');
  const was = 'Tue Nov 17 03:26:30 2026';
  assert.deepEqual([sameStart('Tue Nov 17 03:26:30 2026', was, false), sameStart('Tue Nov 17 03:26:31 2026', was, false),
    sameStart('Tue Nov 17 04:26:30 2026', was, false), sameStart(undefined, was, false), sameStart('Tue Nov 17 03:26:30 2026', 'garbage', false),
    sameStart('Thu Jan  1 00:00:00 1970', '1970-01-01T00:00:00.000Z', false), sameStart('Tue Nov 17 03:26:30 2026', '1970-01-01T00:00:00.000Z', false),
    sameStart('133', 133, true), sameStart('133', 134, true)], [true, true, false, false, true, true, false, true, false]);
  // a Mac's page: its own paths (/Users/…) are 预览 links, a /command isn't; on Windows a Mac's path stays code
  const line = /^const PEEKABLE = .*$/m.exec(fs.readFileSync(require('path').join(__dirname, 'web.html'), 'utf8'))[0];
  const pk = (win) => new Function('state', `${line}; return peekable;`)({ win });
  assert.deepEqual(['/Users/me/a.md', '/private/tmp/x', 'C:/a.md', '/model', '/api/state', '/Users/me/&lt;id&gt;'].map((c) => pk(false)(c)), [true, true, true, false, false, false]);
  assert.deepEqual(['/Users/me/a.md', 'C:/a.md'].map((c) => pk(true)(c)), [false, true]);
  console.log('a Mac\'s start check and paths ok');
}
// 有新版本 and claude-multi update, against a bare repo standing in for GitHub (setup isn't reached: no case here pulls a
// change that keeps its packages). Its git and npm calls block this process, so it runs once every other test is done:
// run beside them, they threw a timing test off
let updRan = false;
process.on('exit', () => { if (!updRan) { console.error('update test never ran'); process.exitCode = 1; } });
process.once('beforeExit', () => {
  const { updateCheck, upgrade } = require('./claude-multi'), { execFileSync } = require('child_process'), path = require('path'), fs = require('fs');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env, stdio: 'pipe' }).trim();
  const at = (n) => path.join(TEST_HOME, 'up', n), up = at('gh.git'), dev = at('dev'), mine = at('mine'), fork = at('fork');
  const put = (file, text, msg) => { fs.writeFileSync(path.join(dev, file), text); g(dev, 'add', '.'); g(dev, 'commit', '-qm', msg); g(dev, 'push', '-q', 'origin', 'HEAD:master'); };
  const said = (dir) => { const log = console.log, code = process.exitCode, out = []; console.log = (m) => out.push(m);
    try { upgrade(dir); } finally { console.log = log; } const r = { out: out.join('\n'), code: process.exitCode }; process.exitCode = code; return r; };
  fs.mkdirSync(at(''), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', up], { stdio: 'pipe' });
  execFileSync('git', ['clone', '-q', up, dev], { stdio: 'pipe' }); put('a.txt', '1', 'one');
  execFileSync('git', ['clone', '-q', up, mine], { stdio: 'pipe' });
  updateCheck(mine).then(async (none) => {
    assert.equal(none, null); // up to date
    put('a.txt', '2', 'two');
    assert.deepEqual(await updateCheck(mine), { n: 1, to: g(dev, 'rev-parse', '--short', 'HEAD') });
    assert.equal(await updateCheck(at('nothing')), null); // no git there
    // a commit of its own: not pulled over, said
    execFileSync('git', ['clone', '-q', up, fork], { stdio: 'pipe' });
    fs.writeFileSync(path.join(fork, 'b.txt'), 'mine'); g(fork, 'add', '.'); g(fork, 'commit', '-qm', 'local');
    put('a.txt', '3', 'three');
    const forked = g(fork, 'rev-parse', 'HEAD'), f = said(fork);
    assert.match(f.out, /没拉下来/); assert.equal(f.code, 1); assert.equal(g(fork, 'rev-parse', 'HEAD'), forked);
    // packages changed and npm failing: the code back to where it was, never new code on old packages
    put('package.json', '{ not json', 'four');
    const was = g(mine, 'rev-parse', 'HEAD'), m = said(mine);
    assert.match(m.out, /拉下来 3 个更新/); assert.match(m.out, /依赖没装上/); assert.equal(m.code, 1); assert.equal(g(mine, 'rev-parse', 'HEAD'), was);
    assert.equal(said(dev).out, '已经是最新的');
    console.log('update ok');
    updRan = true;
  }).catch((e) => { console.error(e); process.exitCode = 1; updRan = true; });
});
// claude installed by npm (Windows): where gives its sh shim, which nothing but a shell starts; the package's claude.exe
if (process.platform === 'win32') {
  const fs = require('fs'), path = require('path'), { claudeCmd } = require('./claude-multi');
  const npm = path.join(TEST_HOME, 'npm'), exe = path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(path.join(npm, 'claude'), '#!/bin/sh\n'); fs.writeFileSync(exe, '');
  assert.equal(claudeCmd(path.join(npm, 'claude')), exe);
  assert.equal(claudeCmd(path.join(npm, 'claude.cmd')), exe);
  assert.equal(claudeCmd('C:\\Users\\me\\.local\\bin\\claude.exe'), 'C:\\Users\\me\\.local\\bin\\claude.exe'); // the installer's: as it is
  assert.equal(claudeCmd(path.join(TEST_HOME, 'elsewhere', 'claude')), path.join(TEST_HOME, 'elsewhere', 'claude')); // no package beside it
  assert.equal(claudeCmd(''), 'claude'); // none found
  console.log('claude from npm ok');
}
// Gemini (agy): its conversations from ~/.gemini's conversation_summaries.db and history.jsonl, shared by all accounts;
// its status line; the account on switched by its sign-in alone (Credential Manager: a test entry here, never agy's own)
{
  const fs = require('fs'), path = require('path'), url = require('url'), { listGemini, gemHistory, gemOn, agyCred, gemSettings, statusline, saveLine, readLine, saveGemQuota, gemUsage, gemRename, gemDelete, gemAgyConvs, gemEnded, gemSum } = require('./claude-multi');
  const { DatabaseSync } = require('node:sqlite');
  const regFile = path.join(TEST_HOME, '.claude-multi', 'profiles.json'), reg0 = fs.readFileSync(regFile, 'utf8');
  const GEM = path.join(TEST_HOME, '.gemini', 'antigravity-cli');
  const acc = (n) => {
    const home = path.join(TEST_HOME, '.claude-multi', 'accounts', `gemini-t-00${n}`);
    fs.mkdirSync(home, { recursive: true });
    return { id: `gemini-t-00${n}`, label: `g${n}@example.com`, email: `g${n}@example.com`, home };
  };
  const a1 = acc(1), a2 = acc(2), work = path.join(TEST_HOME, 'gem-work'), uri = url.pathToFileURL(work).href;
  fs.mkdirSync(work); fs.mkdirSync(GEM, { recursive: true });
  fs.writeFileSync(regFile, JSON.stringify({ ...JSON.parse(reg0), gemini: [a1, a2], geminiOn: a1.id }));
  const d = new DatabaseSync(path.join(GEM, 'conversation_summaries.db'));
  d.exec("create table conversation_summaries (conversation_id text, title text not null default '', preview text not null default '', last_modified_time datetime not null, workspace_uris text not null, parent_conversation_id text not null default '')");
  const ins = d.prepare('insert into conversation_summaries values (?, ?, ?, ?, ?, ?)');
  ins.run('c-new', '', '', '0001-01-01 00:00:00+00:00', JSON.stringify([uri]), '');               // no title yet: your first message's first line
  ins.run('c-old', '修复登录', '', '2026-11-19 08:00:00.123456+00:00', JSON.stringify([uri]), ''); // titled by agy
  ins.run('c-empty', '', '', '2026-11-20 09:00:00+00:00', JSON.stringify([uri]), '');              // nothing said in it
  ins.run('c-sub', 'helper', '', '2026-11-20 09:00:00+00:00', JSON.stringify([uri]), 'c-old');      // a helper agent's
  ins.run('c-gone', 'x', '', '2026-11-20 09:00:00+00:00', JSON.stringify([url.pathToFileURL(path.join(TEST_HOME, 'nope')).href]), ''); // its folder gone
  d.close();
  // each one's record, as agy 1.5 writes it (brain\<id>\.system_generated\logs\transcript.jsonl, a step a line, as its own
  // swarm board reads it): a model step logged once done, its tool calls on it (string args JSON-quoted), each call's
  // result a GENERIC step (one sent to the background RUNNING for good); a line still being written at the end
  const say = (t) => `<USER_REQUEST>\n${t}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>`;
  const rec = (id, steps) => { const f = path.join(GEM, 'brain', id, '.system_generated', 'logs'); fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.jsonl'), steps.map((s, i) => JSON.stringify({ step_index: i, status: 'DONE', ...s })).join('\n') + '\n{"step_index":9'); };
  const U = (t, at) => ({ source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: at, content: say(t) }), M = (t, at, calls) => ({ source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: at, content: t, ...(calls && { tool_calls: calls }) });
  const G = (at, status = 'DONE', content) => ({ source: 'MODEL', type: 'GENERIC', status, created_at: at, ...(content && { content }) }), q = JSON.stringify;
  // one cut short by your next message (its end by that; its edit: as its result says), the next a file written and
  // answered (its lines counted off the call: its result says none)
  rec('c-old', [U('把登录改好', '2026-11-19T07:59:00Z'), M('改一半', '2026-11-19T07:59:10Z', [{ name: 'edit_file', args: { toolSummary: q('Edit a.js'), Path: q('/p/a.js'), Target: q('a\nb'), Replacement: q('c') } }]),
    G('2026-11-19T07:59:12Z', 'DONE', 'Made 1 replacement in /p/a.js starting at line 2 (+5/-4 lines).'), U('算了', '2026-11-19T07:59:30Z'),
    M('', '2026-11-19T07:59:40Z', [{ name: 'write_file', args: { Path: q('/p/b.js'), Content: q('x\ny\n') } }]), G('2026-11-19T07:59:41Z', 'DONE', 'Created file.'), M('写好了', '2026-11-19T07:59:45Z')]);
  // two commands, one a server left running (its result RUNNING for good); then on at work: a command called, its result not in
  rec('c-new', [U('加一个测试\n第二行', '2026-11-20T10:00:00Z'), M('', '2026-11-20T10:00:02Z', [{ name: 'run_command', args: { CommandLine: q('npm test\n--watch'), Cwd: q(work) } }, { name: 'run_command', args: { CommandLine: q('npm run dev') } }]),
    G('2026-11-20T10:00:05Z'), G('2026-11-20T10:00:05Z', 'RUNNING'), { source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'x', created_at: '2026-11-20T10:00:06Z' },
    M('测试加好了', '2026-11-20T10:00:09Z'), { source: 'USER_IMPLICIT', type: 'USER_INPUT', content: 'auto', created_at: '2026-11-20T10:04:00Z' },
    U('再跑一遍', '2026-11-20T10:05:00Z'), M('在跑', '2026-11-20T10:05:01Z', [{ name: 'run_command', args: { CommandLine: q('npm test') } }])]);
  rec('c-empty', [{ source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'x', created_at: '2026-11-20T09:00:00Z' }]);
  rec('c-sub', [U('sub', '2026-11-20T09:00:00Z')]);
  rec('c-gone', [U('gone', '2026-11-20T09:00:00Z'), { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'quota\nmore', created_at: '2026-11-20T09:00:00Z' }]);
  const L = listGemini();
  assert.deepEqual(L.map((s) => [s.id, s.title, s.prompt, s.cwd, s.acct, s.gem, s.going]), [['c-new', '加一个测试', null, work, 0, true, 'busy'], ['c-old', '修复登录', '把登录改好', work, 0, true, null]]);
  assert.deepEqual(L.map((s) => [s.at, s.made, s.lastAt]), [[Date.parse('2026-11-20T10:05:01Z'), Date.parse('2026-11-20T10:00:00Z'), Date.parse('2026-11-20T10:05:01Z')],
    [Date.parse('2026-11-19T08:00:00.123Z'), Date.parse('2026-11-19T07:59:00Z'), Date.parse('2026-11-19T07:59:45Z')]]);
  // its record as the page's messages: yours (without what agy adds), its replies, each tool it called as Claude's are
  // named (its results not shown), a turn's end with about how long, a model error as a note; nothing held back for a
  // step still running (a server); in pieces
  const hd = (id, o) => gemHistory(id, o).items.map((m) => [m.role, m.text]);
  const tail = [['user', '再跑一遍'], ['claude', '在跑'], ['tool', 'Bash  npm test']];
  assert.deepEqual(hd('c-new', { live: true }), [['user', '加一个测试\n第二行'], ['tool', 'Bash  npm test'], ['tool', 'Bash  npm run dev'], ['claude', '测试加好了'], ['done', '9000'], ...tail]);
  assert.deepEqual([gemHistory('c-new', { live: true }).end, gemHistory('c-new').end, hd('c-new', { from: 6, live: true })], [9, 9, tail]);
  assert.deepEqual(hd('c-new').slice(-1), [['done', '1000']]); // cut short (no agy on it any more): its end too
  assert.deepEqual(hd('c-old'), [['user', '把登录改好'], ['claude', '改一半'], ['tool', 'Edit  /p/a.js'], ['edit', '/p/a.js'], ['done', '10000'],
    ['user', '算了'], ['tool', 'Edit  /p/b.js'], ['edit', '/p/b.js'], ['claude', '写好了'], ['done', '15000']]);
  assert.deepEqual(gemHistory('c-old').items.filter((m) => m.role === 'edit').map((m) => [m.text, m.add, m.del]), [['/p/a.js', 5, 4], ['/p/b.js', 2, 0]]);
  const k3 = gemHistory('c-old', { keep: 3 }); // the newest piece from your last message, the end of the turn it cut short with it; the rest before
  assert.deepEqual([k3.start, k3.items.map((m) => m.role), hd('c-old', { end: k3.start }).map((m) => m[0])], [3, ['done', 'user', 'tool', 'edit', 'claude', 'done'], ['user', 'claude', 'tool', 'edit']]);
  assert.deepEqual(hd('c-gone'), [['user', 'gone'], ['note', '出错了：quota'], ['done', '1000']]);
  // what the list and the notes have of one: your last message's time, the error its turn stopped on
  assert.deepEqual([gemSum('c-gone').err, gemSum('c-gone').going, gemSum('c-new').said, gemSum('c-new').err], ['quota', null, Date.parse('2026-11-20T10:05:00Z'), null]);
  // a background task of its own over (agy goes on by itself): a line, as a Claude one's; its other system messages not
  const sys = (sender, content) => ({ source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: '2026-11-20T09:01:00Z',
    content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-20T09:01:00Z sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=${content}\n</SYSTEM_MESSAGE>` });
  rec('c-bg', [U('起个服务', '2026-11-20T09:00:00Z'), sys('system', '[Notice] All your subagents and background tasks have been stopped due to server restart.'),
    sys('c-bg/task-96', 'Task id "c-bg/task-96" finished with result:\nCommand exited with code 0.\n\nOutput: ok'), M('好了', '2026-11-20T09:01:05Z')]);
  assert.deepEqual(hd('c-bg'), [['user', '起个服务'], ['note', '⏳ 后台的事有结果了：Command exited with code 0.'], ['claude', '好了'], ['done', '65000']]);
  // a reply over 4 KB, cut in transcript.jsonl (its first and last 2 KB): whole from transcript_full.jsonl, the same line
  const long = '长'.repeat(1500) + '中间' + '尾'.repeat(1500), cutShort = '长'.repeat(600) + '\n<truncated 4000 bytes>\n' + '尾'.repeat(600);
  rec('c-long', [U('写长一点', '2026-11-20T09:00:00Z'), { ...M(cutShort, '2026-11-20T09:00:09Z'), truncated_fields: ['content'] }]);
  fs.writeFileSync(path.join(GEM, 'brain', 'c-long', '.system_generated', 'logs', 'transcript_full.jsonl'),
    [U('写长一点', '2026-11-20T09:00:00Z'), M(long, '2026-11-20T09:00:09Z')].map((s, i) => JSON.stringify({ step_index: i, status: 'DONE', ...s })).join('\n') + '\n');
  assert.deepEqual(hd('c-long').map((m) => m[1]), ['写长一点', long, '9000']);
  assert.deepEqual([hd('../c-old'), hd('nope')], [[], []]);
  // the same ones with A2 on (they go on with it); none before there's an account
  fs.writeFileSync(regFile, JSON.stringify({ ...JSON.parse(reg0), gemini: [a1, a2], geminiOn: a2.id }));
  assert.deepEqual(listGemini().map((s) => [s.id, s.acct]), [['c-new', 1], ['c-old', 1]]);
  fs.writeFileSync(regFile, reg0);
  assert.deepEqual(listGemini(), []);
  fs.writeFileSync(regFile, JSON.stringify({ ...JSON.parse(reg0), gemini: [a1, a2], geminiOn: a1.id }));
  // renamed: the list by its new name, agy's list too (one running here: its name in claude-multi only); deleted: its
  // record and files gone (to the Recycle Bin: here, just removed), its row out of agy's list, its name forgotten
  const dbTitle = (id) => { const x = new DatabaseSync(path.join(GEM, 'conversation_summaries.db')); try { return x.prepare('select title from conversation_summaries where conversation_id = ?').get(id)?.title ?? null; } finally { x.close(); } };
  gemRename('c-old', '登录的事'); gemRename('c-new', '跑测试', true);
  assert.deepEqual([listGemini().map((s) => [s.id, s.title]), dbTitle('c-old'), dbTitle('c-new')], [[['c-new', '跑测试'], ['c-old', '登录的事']], '登录的事', '']);
  for (const [d, f] of [['conversations', 'c-new.db'], ['annotations', 'c-new.pbtxt'], ['presence', 'c-new.lock'], ['presence', 'c-old.lock']]) {
    fs.mkdirSync(path.join(GEM, d), { recursive: true }); fs.writeFileSync(path.join(GEM, d, f), 'x');
  }
  const regNow = JSON.parse(fs.readFileSync(regFile, 'utf8')); // (the tests after this one change it before it goes on)
  (async () => { // (the web service's bin: in the background)
    const gone = []; await gemDelete('c-new', async (p) => { gone.push(...p.map((x) => path.relative(GEM, x))); p.forEach((x) => fs.rmSync(x, { recursive: true })); return { status: 0 }; });
    assert.deepEqual([gone, listGemini(regNow).map((s) => s.id), dbTitle('c-new'), 'c-new' in JSON.parse(fs.readFileSync(path.join(TEST_HOME, '.claude-multi', 'gem-titles.json'), 'utf8'))],
      [[path.join('brain', 'c-new'), path.join('conversations', 'c-new.db'), path.join('annotations', 'c-new.pbtxt'), path.join('presence', 'c-new.lock')], ['c-old'], null, false]);
  })().catch((e) => { console.error(e); process.exitCode = 1; });
  // a turn's end, by its record: once over (a reply calling no tool, an error), since the agy that runs it began (its steps then: each end once)
  assert.deepEqual([gemEnded({ going: null, lastAt: 5000, n: 7 }, 4000), gemEnded({ going: null, lastAt: 5000, n: 7 }, 9000), gemEnded({ going: 'busy', lastAt: 5000, n: 7 }, 0), gemEnded(null, 0)], [7, null, null, null]);
  assert.throws(() => gemRename('../x', 'y'), /找不到这个对话/);
  // the conversation each agy running holds, by its log (as agy 1.5 writes it): its pid on the first line, the last one it
  // names its own; a pid an older agy had too: the newest log's; one with no conversation yet: none
  const logs = path.join(GEM, 'log'), u = (n) => `${String(n).repeat(8)}-1111-2222-3333-444444444444`;
  fs.mkdirSync(logs, { recursive: true });
  const logAt = (name, ...l) => fs.writeFileSync(path.join(logs, name), l.map((x) => `I1120 10:00:00.000000      1 x.go:1] ${x}`).join('\n') + '\n');
  logAt('cli-20261120_100000.log', 'Starting language server process with pid 111', `Created conversation ${u(1)} (backend=X)`, `Resuming conversation ${u(2)}`, `Streaming conversation ${u(2)}`);
  logAt('cli-20261119_090000.log', 'Starting language server process with pid 111', `Created conversation ${u(3)} (backend=X)`);
  logAt('cli-20261120_110000.log', 'Starting language server process with pid 222', 'Language server version: 1.5.13');
  assert.deepEqual([...gemAgyConvs(new Set([111, 222, 333]))], [[u(2), { pid: 111, since: new Date(2026, 10, 20, 10, 0, 0).getTime(), cut: 0, ask: null }]]);
  // what a log adds read on (another conversation sent to); one an agy named long before its last 256 KB (idle for hours)
  fs.appendFileSync(path.join(logs, 'cli-20261120_100000.log'), `I1120 10:05:00.000000      1 x.go:1] Forwarding user message to conversation ${u(4)}\n`);
  logAt('cli-20261120_120000.log', 'Starting language server process with pid 444', `Created conversation ${u(5)} (backend=X)`, ...Array(4000).fill('x'.repeat(100)));
  assert.deepEqual([...gemAgyConvs(new Set([111, 444]))].map(([id, m]) => [id, m.pid]), [[u(5), 444], [u(4), 111]]);
  // a turn cut short (Esc), as agy 1.5 logs it: its time (a cut of another conversation isn't its own one's)
  fs.appendFileSync(path.join(logs, 'cli-20261120_100000.log'), `I1120 10:06:00.250000    2524 conversation_manager.go:1920] Cancelling in-progress response for conversation ${u(4)}\n`);
  fs.appendFileSync(path.join(logs, 'cli-20261120_120000.log'), `I1120 12:01:00.000000    2524 conversation_manager.go:1920] Cancelling in-progress response for conversation ${u(6)}\n`);
  assert.deepEqual([...gemAgyConvs(new Set([111, 444]))].map(([id, m]) => [id, m.cut]), [[u(5), 0], [u(4), new Date(2026, 10, 20, 10, 6, 0).getTime() + 250]]);
  // a question up, as agy 1.5 logs it (a permission, its own question), till it's answered; another conversation it
  // names (/clear, /resume there), or a fork's new one, its own from then on; a helper's (agent=true) never
  const ln = (t, x) => `I1120 ${t}.000000    129 x.go:1] ${x}\n`, add = (...x) => fs.appendFileSync(path.join(logs, 'cli-20261120_120000.log'), x.join(''));
  const now = () => gemAgyConvs(new Set([444])), askOf = () => now().get(u(5))?.ask;
  add(ln('12:02:00', 'Surfacing tool confirmation: "Bash" at step 13'));
  assert.deepEqual(askOf(), { at: new Date(2026, 10, 20, 12, 2, 0).getTime(), kind: 'tool' });
  add(ln('12:02:05', `Responding to tool confirmation: convID=${u(5)}, stepIdx=13, approved=true`));
  assert.equal(askOf(), null);
  add(ln('12:03:00', 'Surfacing ask_question at step 20'));
  assert.equal(askOf().kind, 'question');
  add(ln('12:03:04', `AskQuestion response for conversation ${u(5)} step 20 (1 responses)`));
  assert.equal(askOf(), null);
  add(ln('12:04:00', 'Starting new conversation (agent=true)'), ln('12:04:00', `Created conversation ${u(7)} (backend=X)`), ln('12:04:01', `Forwarding user message to conversation ${u(7)} (items=1, media=0)`));
  assert.deepEqual([...now().keys()], [u(5)]);
  add(ln('12:05:00', 'Starting new conversation (agent=false)'), ln('12:05:00', `Created conversation ${u(8)} (backend=X)`));
  assert.deepEqual([...now().keys()], [u(8)]);
  add(ln('12:06:00', `Forked conversation ${u(8)} -> ${u(9)} (targetProjectID=x)`));
  assert.deepEqual([...now().keys()], [u(9)]);
  // its status line: ours set in ~/.gemini's settings (what's there kept), a status line of your own left; what it says,
  // by the account on (its email), and kept for the page's status bar (its effort is the model's)
  const sf = path.join(GEM, 'settings.json');
  fs.writeFileSync(sf, JSON.stringify({ model: 'gemini-4-neon-high' }));
  gemSettings(undefined, '/x/claude-multi.js');
  assert.deepEqual(JSON.parse(fs.readFileSync(sf, 'utf8')), { model: 'gemini-4-neon-high', statusLine: { type: 'command', command: 'node /x/claude-multi.js statusline' } }); // bare: agy's cmd hands quotes on
  fs.writeFileSync(sf, String.fromCharCode(0xfeff) + JSON.stringify({ theme: 'dark' })); gemSettings(undefined, '/x/claude-multi.js'); // a BOM before (Notepad's)
  assert.deepEqual(JSON.parse(fs.readFileSync(sf, 'utf8')), { theme: 'dark', statusLine: { type: 'command', command: 'node /x/claude-multi.js statusline' } });
  gemSettings(undefined, '/x y/claude-multi.js'); // a path with a space: none (ours out), the rest kept
  assert.deepEqual(JSON.parse(fs.readFileSync(sf, 'utf8')), { theme: 'dark' });
  fs.writeFileSync(sf, '{ theme: dark }'); gemSettings(undefined, '/x/claude-multi.js'); // not JSON: left as it is
  assert.equal(fs.readFileSync(sf, 'utf8'), '{ theme: dark }');
  fs.writeFileSync(sf, JSON.stringify({ statusLine: { command: 'mine.cmd' } })); gemSettings(undefined, '/x/claude-multi.js');
  assert.equal(JSON.parse(fs.readFileSync(sf, 'utf8')).statusLine.command, 'mine.cmd');
  // a folder a Gemini one starts in from here: in agy's trusted list (once, however written; what's there kept), so agy
  // asks nothing there; settings it can't read left as they are
  const { gemTrust } = require('./claude-multi'), gh0 = path.join(TEST_HOME, '.gemini');
  fs.writeFileSync(sf, JSON.stringify({ model: 'm', trustedWorkspaces: ['C:\\a'] }));
  gemTrust('c:/A/', gh0); gemTrust('E:\\proj\\新项目', gh0); gemTrust('E:/proj/新项目', gh0);
  assert.deepEqual(JSON.parse(fs.readFileSync(sf, 'utf8')), { model: 'm', trustedWorkspaces: ['C:\\a', path.resolve('E:\\proj\\新项目')] });
  fs.writeFileSync(sf, '{ x'); gemTrust('C:/b', gh0);
  assert.equal(fs.readFileSync(sf, 'utf8'), '{ x');
  const gin = { product: 'antigravity', email: 'g2@example.com', session_id: 'c-gem', model: { display_name: 'Gemini 4 Neon', effort: 'high' }, context_window: { used_percentage: 12 } };
  assert.equal(statusline(gin), 'Gemini 账号 A2  │  Gemini 4 Neon · high  │  context 12%');
  assert.equal(statusline({ ...gin, email: 'other@example.com' }).split('  │  ')[0], 'Gemini');
  // its account's quota, kept as agy hands it over (whose: by its email), its Gemini windows as the page shows them (one
  // past its reset: 0)
  const qd = path.join(TEST_HOME, 'gem-quota'), soon = new Date(Date.now() + 3 * 3600e3 + 90e3).toISOString();
  saveGemQuota({ ...gin, plan_tier: 'Google AI Pro', quota: { 'gemini-5h': { remaining_fraction: 0.75, reset_time: soon, reset_in_seconds: 1 }, 'gemini-weekly': { remaining_fraction: 0.5, reset_time: '2000-01-01T00:00:00Z' }, '3p-5h': { remaining_fraction: 1 } } }, qd);
  const gu = gemUsage(a2, qd);
  assert.deepEqual([fs.readdirSync(qd), gu.plan, gu.windows.map((w) => [w.k, w.pct, w.reset ? 'set' : ''])], [[`${a2.id}.json`], 'Google AI Pro', [['five_hour', 25, 'set'], ['seven_day', 0, '']]]);
  assert.match(gu.windows[0].reset, /^3小时0[12]分$/);
  assert.deepEqual(gemUsage(a1, qd), { windows: null }); // none read for it yet
  fs.writeFileSync(regFile, JSON.stringify({ ...JSON.parse(reg0), gemini: [a1, { ...a2, email: null }], geminiOn: a2.id })); // its email never found: by being on
  assert.equal(statusline({ ...gin, email: 'other@example.com' }).split('  │  ')[0], 'Gemini 账号 A2');
  const ld = path.join(TEST_HOME, 'gem-status'); saveLine(gin, ld);
  assert.deepEqual(readLine('c-gem', ld), { model: 'Gemini 4 Neon', effort: 'high', ctx: 12 });
  fs.writeFileSync(regFile, reg0);
  console.log('gemini list ok');
  // the switching: once everything else is done (a PowerShell each step, a minute in all, would hold up the tests with a
  // timer of their own), the registry with them meanwhile
  if (process.platform === 'win32') process.once('beforeExit', async () => {
    const { execFileSync } = require('child_process'), { newGemini } = require('./claude-multi'), gh = path.join(TEST_HOME, '.gemini'), ACCOUNTS_T = path.join(TEST_HOME, '.claude-multi', 'accounts');
    process.env.CM_AGY_CRED = `cm-test-${process.pid}:antigravity`;
    const set = (v) => execFileSync('cmdkey', [`/generic:${process.env.CM_AGY_CRED}`, '/user:antigravity', `/pass:${v}`], { stdio: 'pipe' });
    const now = async () => { const r = await agyCred('peek'); return r.status ? null : Buffer.from(r.stdout, 'base64').toString('latin1').replace(/\0/g, ''); }; // (cmdkey writes UTF-16)
    const reg = () => JSON.parse(fs.readFileSync(regFile, 'utf8'));
    const on = async () => [reg().geminiOn, await now()];
    const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
    // ~/.gemini yours throughout: a folder, what's in it where it was
    const yours = () => assert.ok(!fs.lstatSync(gh).isSymbolicLink() && fs.readFileSync(path.join(gh, 'mine.txt'), 'utf8') === 'x' && fs.existsSync(path.join(GEM, 'conversation_summaries.db')));
    try {
      fs.writeFileSync(path.join(gh, 'mine.txt'), 'x');
      fs.writeFileSync(regFile, JSON.stringify({ ...JSON.parse(reg0), gemini: [a1, a2], geminiOn: a1.id }));
      set('two'); assert.equal((await agyCred('save', path.join(a2.home, 'cm-login.dpapi'))).status, 0);
      set('one'); assert.equal((await agyCred('save', path.join(a1.home, 'cm-login.dpapi'))).status, 0);
      await gemOn(a1, async () => true); // already on: nothing to switch, whatever runs
      assert.deepEqual(await on(), [a1.id, 'one']);
      await assert.rejects(gemOn(a2, async () => true), /有 Gemini（agy）在运行.*A2/); // an agy running: no switch
      assert.deepEqual(await on(), [a1.id, 'one']);
      set('one-refreshed'); // agy refreshed A1's sign-in meanwhile: kept with A1 on the switch
      await gemOn(a2, async () => false);
      assert.deepEqual(await on(), [a2.id, 'two']);
      await gemOn(a1, async () => false);
      assert.deepEqual(await on(), [a1.id, 'one-refreshed']);
      // A2's saved sign-in unreadable: no switch, none on (A1's sign-in kept with it and still in), and A1 on again after
      fs.writeFileSync(path.join(a2.home, 'cm-login.dpapi'), 'not dpapi');
      await assert.rejects(gemOn(a2, async () => false), /A2 的登录读不出来/);
      assert.deepEqual(await on(), [null, 'one-refreshed']);
      await gemOn(a1, async () => false);
      assert.deepEqual(await on(), [a1.id, 'one-refreshed']);
      yours();
      // new gemini. agy here: node started bare (as agy is, to sign in), NODE_OPTIONS making it run a script first: one
      // that signs in with what tok holds, or one that ends at once (no sign-in); either ends it before node would wait on
      // its input. Google: says it's g1. Each signs in for real: agy's own sign-in from before (mine) never taken, and
      // back if none is made
      process.env.CM_AGY = process.execPath;
      const tok = path.join(TEST_HOME, 'tok.dpapi'), fetch0 = global.fetch, day = new Date().toLocaleDateString('sv').replace(/-/g, '');
      const signs = (s) => execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Security; [IO.File]::WriteAllText($env:F, [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:S), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)))'], { env: { ...process.env, F: tok, S: s } });
      const yes = path.join(TEST_HOME, 'agy-signs.js'), no = path.join(TEST_HOME, 'agy-none.js'), o = process.env.NODE_OPTIONS;
      // (the one that signs in stays on till the account is on, as you would in agy, and says what it saw then)
      const saw = path.join(TEST_HOME, 'agy-saw.txt');
      fs.writeFileSync(yes, `require('child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(`require(${JSON.stringify(path.join(__dirname, 'claude-multi.js'))}).agyCred('load', ${JSON.stringify(tok)})`)}], { env: { ...process.env, NODE_OPTIONS: '' } });
const fs = require('fs'), t = Date.now(); let on = null;
while (!on && Date.now() - t < 30000) { try { on = JSON.parse(fs.readFileSync(${JSON.stringify(regFile)}, 'utf8')).geminiOn; } catch {} if (!on) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); }
fs.writeFileSync(${JSON.stringify(saw)}, String(on)); process.exit(0);`);
      fs.writeFileSync(no, 'process.exit(1);');
      const add = async (signed) => {
        process.env.NODE_OPTIONS = `--require ${JSON.stringify(signed ? yes : no)}`;
        try { return await quiet(() => newGemini(async () => false)); } finally { if (o === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = o; }
      };
      const made = () => fs.readdirSync(ACCOUNTS_T).filter((x) => x.startsWith(`gemini-${day}`));
      global.fetch = async () => ({ ok: true, json: async () => ({ email: 'g1@example.com' }) });
      try {
        fs.writeFileSync(regFile, reg0); fs.rmSync(sf); set('mine');
        const stash = path.join(ACCOUNTS_T, 'gemini-before.dpapi');
        assert.equal(await add(false), null); // the first, not signed in: nothing added, agy's own sign-in back
        assert.deepEqual([reg().gemini, ...await on(), made(), fs.existsSync(stash)], [undefined, null, 'mine', [], false]);
        await agyCred('save', stash); assert.equal((await agyCred('drop')).status, 0); // one cut short (its window closed) once agy's own was out
        assert.equal(await add(false), null); // the next: agy's own back all the same
        assert.deepEqual([...await on(), fs.existsSync(stash)], [null, 'mine', false]);
        const one = '{"token":{"access_token":"t1"}}'; signs(one);
        assert.equal(await add(true), true); // signed in: that one A1 (its folder: its sign-in alone), the status line set
        const g1 = reg().gemini?.[0];
        assert.deepEqual([g1?.id, g1?.email, ...await on()], [`gemini-${day}-001`, 'g1@example.com', g1?.id, one]);
        assert.deepEqual([fs.readdirSync(g1.home), fs.existsSync(stash), fs.readFileSync(saw, 'utf8')], [['cm-login.dpapi'], false, g1.id]); // on while agy still ran
        if (!/\s/.test(__dirname)) assert.match(fs.readFileSync(sf, 'utf8'), /"node [^"]*claude-multi\.js statusline"/);
        assert.equal(await add(false), null); // the next, not signed in: its folder gone, A1 on again
        assert.deepEqual([reg().gemini.length, ...await on(), made()], [1, g1.id, one, [g1.id]]);
        yours();
        const two = '{"token":{"access_token":"t2"}}'; signs(two); fs.rmSync(saw);
        assert.equal(await add(true), true); // the same Google account again: A1's sign-in renewed, A1 on, no second
        assert.deepEqual([reg().gemini.length, ...await on(), made(), fs.readFileSync(saw, 'utf8')], [1, g1.id, two, [g1.id], g1.id]);
        yours();
      } finally { global.fetch = fetch0; }
      assert.equal((await agyCred('has')).status, 0); assert.equal((await agyCred('drop')).status, 0); assert.equal((await agyCred('has')).status, 3);
      assert.equal((await agyCred('drop')).status, 0); // none there: nothing to clear
    } finally {
      await agyCred('drop'); fs.rmSync(gh, { recursive: true, force: true }); fs.writeFileSync(regFile, reg0);
      delete process.env.CM_AGY_CRED; delete process.env.CM_AGY;
    }
    console.log('gemini switch ok');
  });
}

// Exercise the actual terminal parser too: string membership alone misses output replayed into the wrong buffer.
require('./replay.test')().then(() => console.log('replay terminal buffers ok'), (e) => { console.error(e); process.exitCode = 1; });
