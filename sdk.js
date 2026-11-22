'use strict';
// API 额度: Claude conversations the web page runs through Anthropic's Claude Agent SDK, on an API account (a gateway's
// address and key in its own settings.json: 申请接入's, or this computer's own). The Console's monthly API credits (Max,
// Ultra, Team) pay for the Agent SDK and never for Claude Code, so these go out as the SDK's own requests (its User-Agent
// says sdk-ts), each model named on the gateway's API-key provider (anthropic/…), never on a subscription's sign-in:
// Anthropic doesn't let an SDK app use one. The SDK runs this computer's claude, so the record is Claude Code's own: the
// list, the 对话 view, rename, delete and the token counts read it as any other (its lines say entrypoint sdk-ts).
// A message is one query(), the conversation resumed by its id; a question or a permission Claude asks for (canUseTool)
// waits for the page's answer; 停止 aborts the query. A turn going when the web service ends is cut there.
// 插入: one sent while it answers goes into that query's input (streaming input) as Claude Code takes one typed in its
// window: into the turn between its steps (priority next), else its own turn once that one's done. Its input ends with
// its first result (claude still runs what it has queued, then ends: tried 2026-11-22 on Claude Code 2.1.322); one sent
// after that, while it still runs, waits here (later) and goes as the next message.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { exec } = require('child_process'), { pathToFileURL } = require('url');

const NAME = '@anthropic-ai/claude-agent-sdk', VER = '0.3.330';
// the gateway's provider for the Console key. shortcut: Magpie's Anthropic preset's id; a gateway naming it otherwise needs a setting
const API = 'anthropic';
// [id, name, price per million tokens in / out] (the Claude API's, 2026-11-21); the first is a new one's
const MODELS = [['claude-opus-5-5', 'Opus 5.5', '$4 / $20'], ['claude-fable-5-2', 'Fable 5.2', '$8 / $40'],
  ['claude-sonnet-5-5', 'Sonnet 5.5', '$2 / $10'], ['claude-haiku-5-5', 'Haiku 5.5', '$0.1 / $0.5']];
// 思考强度: Claude Code's levels (its --effort, the SDK's effort); a new one's is Claude Code's own default
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'], EFFORT = 'xhigh';
// the models Claude Code picks by itself (a subagent's sonnet, a small task's haiku) on the API provider too. As flag
// settings: they win over the account's settings.json, whose env names the subscription's (claude/…), where the SDK's
// own env loses to it (tried 2026-11-21 on Claude Code 2.1.322)
const TIERS = { OPUS: 'claude-opus-5-5', SONNET: 'claude-sonnet-5-5', HAIKU: 'claude-haiku-5-5', FABLE: 'claude-fable-5-2' };
const tierEnv = () => Object.fromEntries(Object.entries(TIERS).map(([k, m]) => [`ANTHROPIC_DEFAULT_${k}_MODEL`, `${API}/${m}`]));

// The SDK, put in <root>/sdk the first time a message is sent (npm, under a minute): not in claude-multi's own
// dependencies, where every install would bring the 390 MB Claude Code that comes with it (an optional dependency, left
// out: this computer's claude runs instead). Another version there is replaced.
function loader(root) {
  let p = null;
  return () => (p ??= (async () => {
    const dir = path.join(root, 'sdk'), pkg = path.join(dir, 'node_modules', ...NAME.split('/'));
    let have = null;
    try { have = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version; } catch {}
    if (have !== VER) {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{ "private": true }\n');
      await new Promise((ok, no) => exec(`npm install --omit=optional --no-audit --no-fund --loglevel=error ${NAME}@${VER}`, { cwd: dir, windowsHide: true, timeout: 600000 },
        (e, out, err) => (e ? no(new Error(`Agent SDK 没装上：${String(err || e.message).trim().split('\n').pop()}`)) : ok())));
    }
    return import(pathToFileURL(path.join(pkg, 'sdk.mjs')).href);
  })().catch((e) => { p = null; throw e; }));
}

// What the page shows of a question: AskUserQuestion's questions, or the tool and what it would do
function askView({ tool, input = {} }) {
  if (tool === 'AskUserQuestion') return { tool, questions: (Array.isArray(input.questions) ? input.questions : []).map((q) => ({
    question: String(q?.question ?? ''), header: String(q?.header ?? ''), multi: !!q?.multiSelect,
    options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({ label: String(o?.label ?? ''), desc: String(o?.description ?? '') })) })) };
  const what = input.command ?? input.plan ?? input.file_path ?? input.notebook_path ?? input.url ?? input.pattern ?? JSON.stringify(input);
  return { tool, what: String(what).slice(0, 2000), why: String(input.description ?? '').slice(0, 300) };
}
// the answers as Claude asked them: each one of its questions, a label or several (or words typed for it)
function answersOf(input, answers) {
  const qs = new Set((input.questions ?? []).map((q) => q?.question));
  return Object.fromEntries(Object.entries(answers && typeof answers === 'object' ? answers : {})
    .filter(([k, v]) => qs.has(k) && (typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')))));
}

// lib: () => the SDK's module; exe: claude's program; envOf(configDir): the environment an account's Claude runs with;
// done(run): a turn over
// A turn's claude, started here (the SDK's spawnClaudeCodeProcess: its command, arguments and environment as the SDK
// made them), so 停止 can end it at once. Left to the SDK, an aborted query's claude went on for 2 to 7 s, asking the
// model again each time a question it had waiting was turned down (tried 2026-11-21 on Claude Code 2.1.322: 160 to 220
// requests to a fake that answered at once). Its tree: the commands it runs go with it.
const WIN = process.platform === 'win32';
const spawnClaude = (o) => require('child_process').spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: !WIN });
function killTree(p) {
  if (WIN) require('child_process').execFile('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else try { process.kill(-p.pid, 'SIGKILL'); } catch { p.kill('SIGKILL'); } // its own group (detached)
}

// a message of yours, as the SDK takes one: origin human, as a host passing on what you typed must say (the record's
// queued_command line has it then, and the page shows that one as yours)
const said = (text, priority) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', origin: { kind: 'human' }, ...(priority && { priority }) });
// a query's input: the messages as they're pushed, over at end()
function feed() {
  const q = [], wake = [];
  let over = false;
  const kick = () => wake.splice(0).forEach((f) => f());
  return { push: (m) => { q.push(m); kick(); }, end: () => { over = true; kick(); }, over: () => over,
    async *[Symbol.asyncIterator]() { for (;;) { while (q.length) yield q.shift(); if (over) return; await new Promise((ok) => wake.push(ok)); } } };
}

function createSdk({ lib, exe, envOf, done = () => {}, spawn = spawnClaude, kill = killTree }) {
  const runs = new Map(); // conversation id → { id, model, busy, since, at, ask, err, note, ac, proc, stopping, input, later }
  const busy = (id) => !!runs.get(id)?.busy;
  const asked = (run, tool, input, signal) => new Promise((ok) => {
    const ask = { tool, input, at: Date.now(), answer: (r) => { if (run.ask === ask) run.ask = null; ok(r); } };
    run.ask = ask;
    signal?.addEventListener('abort', () => ask.answer({ behavior: 'deny', message: 'The user stopped this.' }), { once: true });
  });
  // {id} one to go on with (null: a new one), on the account in configDir, in folder cwd: the turn starts, answered at once
  function send({ id, configDir, cwd, text, model, effort }) {
    text = String(text ?? '').trim();
    if (!text) throw new Error('消息是空的');
    const was = id && runs.get(id);
    if (was?.busy) { // 插入
      if (was.stopping) throw new Error('正在停止，停下来再发');
      if (was.input.over()) was.later.push(text); else was.input.push(said(text, 'next'));
      return { id };
    }
    const m = MODELS.find((x) => x[0] === model)?.[0] ?? MODELS[0][0], e = EFFORTS.includes(effort) ? effort : EFFORT, fresh = !id;
    id ??= crypto.randomUUID();
    const run = { id, model: m, effort: e, busy: true, since: Date.now(), at: 0, ask: null, err: '', note: '正在启动', ac: new AbortController(), input: feed(), later: [] };
    runs.set(id, run);
    run.input.push(said(text));
    (async () => {
      const { query } = await lib();
      for await (const msg of query({ prompt: run.input, options: {
        pathToClaudeCodeExecutable: exe, env: envOf(configDir), cwd, abortController: run.ac, spawnClaudeCodeProcess: (o) => (run.proc = spawn(o)),
        model: `${API}/${m}`, effort: e, settings: { env: tierEnv() }, ...(fresh ? { sessionId: id } : { resume: id }),
        canUseTool: (tool, input, o) => asked(run, tool, input, o?.signal) } })) {
        if (msg.type === 'system' && msg.subtype === 'init') run.note = '';
        if (msg.type === 'result' && !run.stopping) run.err = msg.is_error ? String(msg.result || (msg.errors ?? []).join('；') || msg.subtype).slice(0, 500) : '';
        if (msg.type === 'result') run.input.end();
      }
    })().catch((e) => { if (!run.stopping) run.err = String(e?.message ?? e).slice(0, 500); }) // (停止's: no error)
      .finally(() => {
        run.input.end(); run.ask?.answer({ behavior: 'deny', message: 'The conversation stopped.' }); Object.assign(run, { busy: false, note: '', at: Date.now() }); done(run);
        if (run.later.length && !run.stopping) try { send({ id, configDir, cwd, text: run.later.join('\n\n'), model: m, effort: e }); } catch {}
      });
    return { id };
  }
  // the question waiting: allow (or a tool's no), the picks of AskUserQuestion's questions, or words typed instead: a
  // tool turned down with them (Claude reads why), a question answered with them
  function answer({ id, allow, answers, text }) {
    const a = runs.get(id)?.ask;
    if (!a) throw new Error('它现在没在问你');
    text = String(text ?? '').trim();
    if (a.tool === 'AskUserQuestion') {
      if (!allow && !text) a.answer({ behavior: 'deny', message: 'The user chose not to answer.' });
      else a.answer({ behavior: 'allow', updatedInput: { ...a.input, answers: answersOf(a.input, answers), ...(text && { response: text }) } });
    } else a.answer(allow && !text ? { behavior: 'allow', updatedInput: a.input } : { behavior: 'deny', message: text || 'The user said no.' });
    return {};
  }
  // 停止: its claude ended first, then the query aborted: a question waiting is turned down only once nothing is left to
  // ask the model again (5 s at most, whatever the kill did)
  function stop(id) {
    const r = runs.get(id);
    if (!r?.busy || r.stopping) return {};
    r.stopping = true;
    const p = r.proc, abort = () => r.ac.abort();
    if (!p || p.exitCode != null || p.signalCode != null) abort();
    else { p.once('exit', abort); setTimeout(abort, 5000).unref?.(); kill(p); }
    return {};
  }
  // for the page: how it stands (none: idle, nothing asked since the service started); later: sent after its input ended,
  // waiting here (what waits in claude's own queue is in its record)
  function view(id) {
    const r = runs.get(id);
    return r ? { busy: r.busy, since: r.since, model: r.model, effort: r.effort, err: r.err, note: r.note, ask: r.ask && askView(r.ask), later: r.busy ? r.later : [] } : { busy: false };
  }
  return { send, answer, stop, view, busy, waits: (id) => !!runs.get(id)?.ask };
}

module.exports = { createSdk, loader, askView, answersOf, tierEnv, MODELS, API, VER };
