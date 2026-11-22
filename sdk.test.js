// node --test sdk.test.js: API 额度's turns (sdk.js) with a stand-in for the Agent SDK's query(): what each is asked
// with, a question and a permission waiting for the page, 停止, a failed turn. Nothing here starts claude or npm.
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { createSdk, askView, answersOf, tierEnv } = require('./sdk');

// a query() that records its call and the messages its input gives (msgs; over: the input ended), then does what the
// test's script says: each step a message to yield, or a function given the options (to call canUseTool and wait on it)
function fakeLib(script) {
  const calls = [];
  const query = ({ prompt, options }) => {
    const call = { options, msgs: [], over: false };
    calls.push(call);
    (async () => { for await (const m of prompt) call.msgs.push(m); call.over = true; })();
    return (async function* () {
      for (const step of script()) {
        if (options.abortController.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        yield typeof step === 'function' ? await step(options) : step;
      }
    })();
  };
  return { lib: async () => ({ query }), calls };
}
const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(f(), String(f)); };
const INIT = { type: 'system', subtype: 'init' }, OK = { type: 'result', subtype: 'success', is_error: false, result: 'ok' };

test('a new one: its own id up front (sessionId), on the API provider, every tier there too, the account\'s env and folder; then resumed by that id', async () => {
  let gate; const wait = new Promise((r) => (gate = r)), ended = [];
  const { lib, calls } = fakeLib(() => [INIT, () => wait.then(() => OK)]);
  const s = createSdk({ lib, exe: 'C:/x/claude.exe', envOf: (d) => ({ CLAUDE_CONFIG_DIR: d }), done: (r) => ended.push(r.id) });
  const { id } = s.send({ id: null, configDir: 'C:/acct', cwd: 'C:/work', text: '  你好 ', model: 'claude-haiku-5-5' });
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(s.view(id).busy, true); assert.equal(s.view(id).note, '正在启动');
  await until(() => calls.length && s.view(id).note === '');
  const o = calls[0].options;
  assert.deepEqual(calls[0].msgs, [{ type: 'user', message: { role: 'user', content: '你好' }, parent_tool_use_id: null, session_id: '', origin: { kind: 'human' } }]);
  assert.deepEqual([o.sessionId, o.resume, o.model, o.pathToClaudeCodeExecutable, o.cwd, o.env], [id, undefined, 'anthropic/claude-haiku-5-5', 'C:/x/claude.exe', 'C:/work', { CLAUDE_CONFIG_DIR: 'C:/acct' }]);
  assert.deepEqual(o.settings, { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-opus-5-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-5-5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-5-5', ANTHROPIC_DEFAULT_FABLE_MODEL: 'anthropic/claude-fable-5-2' } });
  gate();
  await until(() => !s.view(id).busy);
  assert.deepEqual([s.view(id).err, ended], ['', [id]]);
  s.send({ id, configDir: 'C:/acct', cwd: 'C:/work', text: '再来', model: 'gpt-6' }); // a model not offered: the first one
  await until(() => calls.length === 2 && !s.view(id).busy);
  assert.deepEqual([calls[1].options.resume, calls[1].options.sessionId, calls[1].options.model], [id, undefined, 'anthropic/claude-opus-5-5']);
  // 思考强度: Claude Code's default (xhigh) unless one of its levels is asked; one it hasn't: the default
  assert.deepEqual([calls[0].options.effort, calls[1].options.effort], ['xhigh', 'xhigh']);
  for (const [asked, sent] of [['low', 'low'], ['max', 'max'], ['turbo', 'xhigh']]) {
    const n = calls.length;
    s.send({ id, configDir: 'C:/acct', cwd: 'C:/work', text: '再来', effort: asked });
    await until(() => calls.length === n + 1 && !s.view(id).busy);
    assert.deepEqual([calls[n].options.effort, s.view(id).effort], [sent, sent], asked);
  }
  assert.throws(() => s.send({ id: null, text: ' ' }), /空的/);
  assert.deepEqual(s.view('nobody'), { busy: false });
});

test('插入: one sent while it answers goes into its input (priority next, yours); after its result, one waits here and goes as the next message, on its model and effort; not while it stops, nor after 停止', async () => {
  const gates = [], gate = () => new Promise((r) => gates.push(() => r(INIT)));
  const { lib, calls } = fakeLib(() => [INIT, gate, () => OK, gate, () => INIT]); // its result, then claude still at what it had queued
  const s = createSdk({ lib, exe: 'claude', envOf: () => ({}) });
  const { id } = s.send({ id: null, configDir: 'C:/a', cwd: 'C:/w', text: '先做这个', model: 'claude-haiku-5-5', effort: 'low' });
  await until(() => gates.length === 1);
  assert.deepEqual(s.send({ id, configDir: 'C:/a', cwd: 'C:/w', text: ' 还有这个 ' }), { id });
  await until(() => calls[0].msgs.length === 2);
  assert.deepEqual(calls[0].msgs.map((m) => [m.message.content, m.priority, m.origin.kind]), [['先做这个', undefined, 'human'], ['还有这个', 'next', 'human']]);
  gates[0]();
  await until(() => calls[0].over && gates.length === 2); // its result: its input over
  s.send({ id, text: '最后一条' }); s.send({ id, text: '再加一条' });
  assert.deepEqual([calls.length, calls[0].msgs.length, s.view(id).later, s.view(id).busy], [1, 2, ['最后一条', '再加一条'], true]);
  gates[1]();
  await until(() => calls.length === 2 && gates.length === 3);
  const o = calls[1].options;
  assert.deepEqual([calls[1].msgs[0].message.content, o.resume, o.cwd, o.model, o.effort, s.view(id).later], ['最后一条\n\n再加一条', id, 'C:/w', 'anthropic/claude-haiku-5-5', 'low', []]);
  // 停止 with one waiting here: it doesn't go; one sent while it stops is refused
  gates[2]();
  await until(() => gates.length === 4);
  s.send({ id, text: '不要了' }); s.stop(id);
  assert.throws(() => s.send({ id, text: '还要' }), /正在停止/);
  gates[3]();
  await until(() => !s.view(id).busy);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 2);
});

test('a permission: shown with what it would run; allowed as asked, or turned down with the words typed; nothing waiting: refused', async () => {
  const got = [];
  const { lib } = fakeLib(() => [INIT, async (o) => { got.push(await o.canUseTool('Bash', { command: 'rm -rf build', description: '清理' }, { signal: o.abortController.signal })); return INIT; },
    async (o) => { got.push(await o.canUseTool('Write', { file_path: 'C:/w/a.txt', content: 'x' }, { signal: o.abortController.signal })); return OK; }]);
  const s = createSdk({ lib, exe: 'claude', envOf: () => ({}) }), { id } = s.send({ id: null, text: '清理一下' });
  await until(() => s.view(id).ask);
  assert.deepEqual(s.view(id).ask, { tool: 'Bash', what: 'rm -rf build', why: '清理' });
  assert.equal(s.waits(id), true);
  s.answer({ id, allow: true });
  await until(() => s.view(id).ask?.tool === 'Write');
  assert.equal(s.view(id).ask.what, 'C:/w/a.txt');
  s.answer({ id, allow: true, text: '别写，先给我看' });
  await until(() => !s.view(id).busy);
  assert.deepEqual(got, [{ behavior: 'allow', updatedInput: { command: 'rm -rf build', description: '清理' } }, { behavior: 'deny', message: '别写，先给我看' }]);
  assert.throws(() => s.answer({ id, allow: true }), /没在问你/);
});

test('AskUserQuestion: the picks of its own questions only (a label, or several), words typed as a reply, or no answer at all', async () => {
  const Q = { questions: [{ question: '用哪个库？', header: '库', multiSelect: false, options: [{ label: 'React', description: '组件' }, { label: 'Vue' }] },
    { question: '要哪些页？', header: '页面', multiSelect: true, options: [{ label: '首页' }, { label: '设置' }] }] };
  const got = [], ask = async (o) => { got.push(await o.canUseTool('AskUserQuestion', Q, { signal: o.abortController.signal })); return INIT; };
  const { lib } = fakeLib(() => [INIT, ask, ask, ask, OK]);
  const s = createSdk({ lib, exe: 'claude', envOf: () => ({}) }), { id } = s.send({ id: null, text: '做个网站' });
  await until(() => s.view(id).ask);
  assert.deepEqual(s.view(id).ask, { tool: 'AskUserQuestion', questions: [
    { question: '用哪个库？', header: '库', multi: false, options: [{ label: 'React', desc: '组件' }, { label: 'Vue', desc: '' }] },
    { question: '要哪些页？', header: '页面', multi: true, options: [{ label: '首页', desc: '' }, { label: '设置', desc: '' }] }] });
  s.answer({ id, allow: true, answers: { '用哪个库？': 'Vue', '要哪些页？': ['首页', '设置'], '别的？': 'x', bad: 3 } });
  await until(() => got.length === 1 && s.view(id).ask);
  s.answer({ id, allow: false, text: '都不要，用纯 HTML' });
  await until(() => got.length === 2 && s.view(id).ask);
  s.answer({ id, allow: false });
  await until(() => !s.view(id).busy);
  assert.deepEqual(got, [
    { behavior: 'allow', updatedInput: { ...Q, answers: { '用哪个库？': 'Vue', '要哪些页？': ['首页', '设置'] } } },
    { behavior: 'allow', updatedInput: { ...Q, answers: {}, response: '都不要，用纯 HTML' } },
    { behavior: 'deny', message: 'The user chose not to answer.' }]);
});

test('停止: its claude (started here, as the SDK asks) ended first, then the query aborted and a question waiting turned down; no error shown', async () => {
  const got = [], order = [], { EventEmitter } = require('events');
  const proc = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null });
  const { lib, calls } = fakeLib(() => [() => (calls[0].options.spawnClaudeCodeProcess({ command: 'claude.exe', args: ['--x'], cwd: 'C:/w', env: { A: '1' } }), INIT),
    async (o) => { got.push(await o.canUseTool('Bash', { command: 'sleep 99' }, { signal: o.abortController.signal })); order.push('answered'); return INIT; }, OK]);
  const spawned = [], killed = [];
  const s = createSdk({ lib, exe: 'claude', envOf: () => ({}), spawn: (o) => (spawned.push(o), proc), kill: (p) => { killed.push(p.pid); order.push('killed'); setTimeout(() => { p.exitCode = 1; order.push('exit'); p.emit('exit', 1); }, 30); } });
  const { id } = s.send({ id: null, text: '等一下' });
  await until(() => s.view(id).ask);
  assert.deepEqual(spawned, [{ command: 'claude.exe', args: ['--x'], cwd: 'C:/w', env: { A: '1' } }]);
  s.stop(id); s.stop(id); // (twice: one kill)
  assert.deepEqual([killed, calls[0].options.abortController.signal.aborted, s.view(id).ask?.tool], [[4242], false, 'Bash']); // the question still waits while its claude ends
  await until(() => !s.view(id).busy);
  assert.deepEqual([order, got, s.view(id).err, s.view(id).ask], [['killed', 'exit', 'answered'], [{ behavior: 'deny', message: 'The user stopped this.' }], '', null]);
  assert.deepEqual(s.stop('nobody'), {});
});

test('a turn that failed says why; an SDK that won\'t load too', async () => {

  const bad = createSdk({ lib: fakeLib(() => [INIT, { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 403 这把 key（join-x）没开 API 额度' }]).lib, exe: 'claude', envOf: () => ({}) });
  const b = bad.send({ id: null, text: 'hi' }).id;
  await until(() => !bad.view(b).busy);
  assert.equal(bad.view(b).err, 'API Error: 403 这把 key（join-x）没开 API 额度');
  const none = createSdk({ lib: async () => { throw new Error('Agent SDK 没装上：npm ERR! network'); }, exe: 'claude', envOf: () => ({}) });
  const n = none.send({ id: null, text: 'hi' }).id;
  await until(() => !none.view(n).busy);
  assert.equal(none.view(n).err, 'Agent SDK 没装上：npm ERR! network');
});

test('what a tool would do, shown short; answers only for the questions asked; every tier on the API provider', () => {
  assert.deepEqual(askView({ tool: 'ExitPlanMode', input: { plan: '1. 改 a\n2. 改 b' } }), { tool: 'ExitPlanMode', what: '1. 改 a\n2. 改 b', why: '' });
  assert.equal(askView({ tool: 'mcp__x__y', input: { a: 1 } }).what, '{"a":1}');
  assert.equal(askView({ tool: 'Bash', input: { command: 'x'.repeat(3000) } }).what.length, 2000);
  assert.deepEqual(askView({ tool: 'AskUserQuestion', input: {} }), { tool: 'AskUserQuestion', questions: [] });
  assert.deepEqual(answersOf({ questions: [{ question: 'a' }] }, null), {});
  assert.deepEqual(answersOf({ questions: [{ question: 'a' }] }, { a: ['x', 1] }), {});
  assert.ok(Object.values(tierEnv()).every((m) => m.startsWith('anthropic/claude-')));
});
