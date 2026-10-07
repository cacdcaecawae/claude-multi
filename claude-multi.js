#!/usr/bin/env node
// claude-multi: one CLAUDE_CONFIG_DIR per Claude.ai account, shared settings via links.
// The registry and log never hold tokens, cookies, credentials or login URLs/codes.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const SHARED = path.join(HOME, '.claude');
const ROOT = path.join(HOME, '.claude-multi');
const ACCOUNTS = path.join(ROOT, 'accounts');
const REGISTRY = path.join(ROOT, 'profiles.json');
const LOG = path.join(ROOT, 'events.jsonl');
const INBOX = path.join(ROOT, 'inbox');
const ISLAND = path.join(ROOT, 'island.ps1');
const CLAUDE = 'claude';

const SHARED_FILES = ['settings.json', 'CLAUDE.md', 'keybindings.json'];
const SHARED_DIRS = ['hooks', 'rules', 'plugins', 'skills', 'agents', 'commands', 'output-styles', 'ide'];
// Non-identity .claude.json fields copied into a new profile; everything else stays per-profile.
const PREF_KEYS = ['hasCompletedOnboarding', 'lastOnboardingVersion', 'theme', 'editorMode',
  'installMethod', 'autoUpdates', 'autoUpdatesChannel', 'preferredNotifChannel'];
// Each of these overrides the profile's own credentials, so they never reach the child.
const AUTH_ENV = ['CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const label = (p) => `${p.label} (${p.subscriptionType})`;
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

function load() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return { active: null, profiles: [] };
    throw e;
  }
}

// ponytail: no lock; two claude-multi writing in the same instant can drop one update, add a lockfile if it bites
function update(fn) {
  const reg = load();
  fn(reg);
  const tmp = `${REGISTRY}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  fs.renameSync(tmp, REGISTRY);
  return reg;
}

function log(event, fields) {
  fs.appendFileSync(LOG, JSON.stringify({ timestamp: now(), event, ...fields }) + '\n');
}

// Idempotent: runs on every launch so shared items added later reach existing profiles.
function ensureLinks(dir) {
  for (const name of [...SHARED_FILES, ...SHARED_DIRS]) {
    const src = path.join(SHARED, name), dst = path.join(dir, name);
    if (!fs.existsSync(src)) continue;
    try { fs.lstatSync(dst); continue; } catch {} // already there: never clobber
    fs.symlinkSync(src, dst, SHARED_DIRS.includes(name) ? 'junction' : 'file');
  }
}

// What a running Claude hands everything it starts (its Bash tool, its hooks, so the island and the
// terminals the island opens). A Claude inheriting them takes itself for that one's sub-session: it
// stops saving its transcript and reports to the parent. claude-multi only starts top-level sessions.
const SESSION_ENV = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN'];

function childEnv(dir) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  for (const k of SESSION_ENV) delete env[k];
  for (const k of AUTH_ENV) {
    if (k in env) { delete env[k]; console.error(`已忽略环境变量 ${k}（它会覆盖账号身份）`); }
  }
  return env;
}

// Runs claude in the profile; Ctrl+C belongs to claude, we only wait for it to exit.
function run(dir, args) {
  const ignore = () => {};
  process.on('SIGINT', ignore);
  const r = spawnSync(CLAUDE, args, { stdio: 'inherit', env: childEnv(dir) });
  process.off('SIGINT', ignore);
  return r;
}

function authStatus(dir) {
  const r = spawnSync(CLAUDE, ['auth', 'status', '--json'], { env: childEnv(dir), encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return { loggedIn: false }; }
}

// Blocking line read from fd 0: consumes only the answer, leaves stdin untouched for claude.
// null = stdin ended without Enter, so a pipe or EOF never counts as "pressed Enter".
function ask(q) {
  process.stdout.write(q);
  const b = Buffer.alloc(1);
  let s = '';
  try {
    while (fs.readSync(0, b, 0, 1) === 1) {
      if (b[0] === 10) return s.trim();
      s += String.fromCharCode(b[0]);
    }
  } catch {}
  return null;
}

function newProfile() {
  console.log('正在创建新的 Claude 账号配置……');
  fs.mkdirSync(ACCOUNTS, { recursive: true });
  const day = new Date().toLocaleDateString('sv').replace(/-/g, ''); // local YYYYMMDD
  let id, dir;
  for (let n = 1; ; n++) { // mkdir without recursive is the uniqueness check, failed profiles keep their number
    id = `acct-${day}-${String(n).padStart(3, '0')}`;
    dir = path.join(ACCOUNTS, id);
    try { fs.mkdirSync(dir); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  ensureLinks(dir);
  const prefs = {};
  try {
    const g = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    for (const k of PREF_KEYS) if (k in g) prefs[k] = g[k];
  } catch {}
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(prefs, null, 2) + '\n');
  log('profile_created', { profile_id: id });

  console.log(`Profile：${id}`);
  console.log('正在登录新的 Claude 订阅账号。');
  console.log('浏览器完成回调后无需在终端输入。');
  run(dir, ['auth', 'login', '--claudeai']);

  console.log('正在验证登录状态……');
  const s = authStatus(dir); // the only source of truth, never the login command's output
  if (s.loggedIn !== true || !s.email) {
    log('profile_login_failed', { profile_id: id });
    console.log(`新 profile 已保留，但尚未检测到成功登录。\nProfile：${id}\n该 profile 未加入可用账号列表。`);
    return null;
  }
  // ponytail: dedupe by email only; one email in two orgs would need orgId, add if that case shows up
  const dup = load().profiles.find((q) => q.email === s.email);
  if (dup) {
    log('profile_duplicate', { profile_id: id, existing_profile_id: dup.id });
    console.log(`该账号已登记为 ${dup.id}，未重复登记。浏览器可能仍登录着同一个 claude.ai 账号，切换后重试。\nProfile：${id}（已保留）`);
    return null;
  }
  const p = { id, label: s.email, email: s.email, subscriptionType: s.subscriptionType || 'unknown',
    configDir: dir, createdAt: now(), lastUsedAt: null };
  update((reg) => { reg.profiles.push(p); });
  log('profile_registered', { profile_id: id, account: p.email, plan: p.subscriptionType });
  console.log(`已保存账号：${label(p)}\n当前默认账号未改变。`);
  return p;
}

function pick(header) {
  for (;;) {
    const reg = load();
    if (!reg.profiles.length) {
      console.log('没有已保存账号，请先运行 claude-multi new。');
      process.exit(1);
    }
    console.log(header);
    reg.profiles.forEach((p, i) => console.log(`  ${i + 1}. ${p.id === reg.active ? '*' : ' '} ${label(p)}`));
    console.log(`  ${reg.profiles.length + 1}. + 登录新账号\n`);
    const t = ask('请选择账号：');
    const n = /^\d+$/.test(t) ? Number(t) : 0;
    if (n !== reg.profiles.length + 1) return reg.profiles[n - 1] || null;
    newProfile(); // then show the menu again: adding an account never picks it implicitly
    console.log();
  }
}

function launch(args) {
  const p = pick('选择 Claude 账号：');
  if (!p) { console.log('无效选择，未启动 Claude。'); process.exit(1); }
  start(p, args, 'interactive_select');
}

// Verified start of one profile; shared by the menu and by `usage` (Enter on its recommendation).
function start(p, args, source) {
  const s = authStatus(p.configDir);
  if (s.loggedIn !== true || s.email !== p.email) {
    log('launch_refused', { profile_id: p.id, reason: s.loggedIn ? 'account_changed' : 'logged_out' });
    console.log(`Profile ${p.id} 当前不是已登录的 ${p.email}，未启动 Claude。`);
    process.exit(1);
  }
  ensureLinks(p.configDir);
  const reg = update((r) => {
    r.active = p.id;
    const q = r.profiles.find((x) => x.id === p.id);
    q.lastUsedAt = now();
    if (s.subscriptionType) q.subscriptionType = s.subscriptionType;
  });
  const q = reg.profiles.find((x) => x.id === p.id);
  log('account_activated', { profile_id: p.id, source });
  console.log(`使用账号：${label(q)}\nProfile：${p.id}\n正在启动 Claude Code……`);
  log('claude_started', { profile_id: p.id });
  const r = run(p.configDir, args);
  if (r.error) { console.error(`无法启动 claude：${r.error.message}`); process.exit(1); }
  process.exit(r.status ?? 1);
}

function switchDefault() {
  const p = pick('Claude 账号：');
  if (!p) { console.log('无效选择，默认账号未改变。'); process.exit(1); }
  update((reg) => { reg.active = p.id; });
  log('account_activated', { profile_id: p.id, source: 'switch' });
  console.log(`已切换默认账号：${label(p)}\n设置已保存；本次未启动 Claude。`);
}

function list() {
  const reg = load();
  if (!reg.profiles.length) return console.log('没有已保存账号，请先运行 claude-multi new。');
  const w = Math.max(7, ...reg.profiles.map((p) => p.label.length)) + 4;
  const row = (a, b, c, d) => `  ${a.padEnd(23)}${b.padEnd(w)}${c.padEnd(7)}${d}`;
  console.log(row('ID', 'ACCOUNT', 'PLAN', 'ACTIVE'));
  for (const p of reg.profiles) console.log(row(p.id, p.label, p.subscriptionType, p.id === reg.active ? '*' : ''));
}

// Same endpoint /usage uses (found in claude.exe, internal, may change). Token stays in memory,
// no refresh: refreshing would race a running Claude writing the same .credentials.json.
async function fetchUsage(p) {
  let c;
  try { c = JSON.parse(fs.readFileSync(path.join(p.configDir, '.credentials.json'), 'utf8')).claudeAiOauth; } catch {}
  if (!c?.accessToken) return { err: '未找到登录凭据' };
  if (c.expiresAt && c.expiresAt < Date.now()) return { err: 'token 已过期，用 claude-multi 启动一次该账号即可刷新' };
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${c.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10000) });
    if (r.status === 429) return { err: '用量接口限流，稍后再试' };
    if (!r.ok) return { err: `用量接口返回 HTTP ${r.status}` };
    return { u: await r.json() };
  } catch (e) { return { err: `网络错误：${e.message}` }; }
}

// Which account to start a session on. 5h allowance is plentiful across accounts, so for it only
// uninterrupted work time matters. Weekly allowance is scarce and lost at reset, so spend the one that
// expires first (earliest deadline first), as long as it still gives MIN_RUN hours of work.
const BURN = 0.5;        // ponytail: fixed guess (a full 5h window lasts ~2h of work); estimate from live windows if picks feel off
const WEEK_PER_5H = 0.1; // share of the weekly limit one full 5h window costs; unpublished, ~0.06-0.12 from Anthropic's 40-80h/week
const MIN_RUN = 1;       // hours of uninterrupted work an account must offer before its sooner weekly reset counts
const hoursTo = (w) => (w?.resets_at ? Math.max(0, (new Date(w.resets_at) - Date.now()) / 3.6e6) : Infinity);
// Hours until blocked: if what's left lasts to the reset, you get the reset plus one full fresh window.
const last = (w, rate) => { const r = 1 - (w?.utilization ?? 0) / 100, t = hoursTo(w); return r >= rate * t ? t + 1 / rate : r / rate; };
const runway = (u) => Math.min(last(u.five_hour, BURN), last(u.seven_day, BURN * WEEK_PER_5H));
function pickOpen(open) {
  // Longer runway (to 0.1h); on a tie the 5h window that resets sooner, so a block is shorter.
  const byRun = (a, b) => Math.round(runway(b.u) * 10) - Math.round(runway(a.u) * 10)
    || hoursTo(a.u.five_hour) - hoursTo(b.u.five_hour);
  const good = open.filter((r) => runway(r.u) >= MIN_RUN);
  if (!good.length) return [...open].sort(byRun)[0];
  const day = (r) => Math.round(hoursTo(r.u.seven_day) / 24); // weekly resets hours apart count as a tie
  return good.sort((a, b) => day(a) - day(b) || byRun(a, b))[0];
}

const width = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e7f ? 2 : 1), 0); // CJK = 2 cols
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const until = (t) => {
  const m = Math.max(0, Math.round((new Date(t) - Date.now()) / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}天${h}小时` : h ? `${h}小时${String(m % 60).padStart(2, '0')}分` : `${m}分`;
};

// Starts the 5h window where it isn't running, so it resets sooner. One "hi" to Haiku through the
// account's own claude (it refreshes its own token), stripped of tools, settings, plugins, MCP and the
// saved session. Running windows are skipped: a message there changes nothing.
async function warmup() {
  const reg = load();
  if (!reg.profiles.length) return console.log('没有已保存账号，请先运行 claude-multi new。');
  const running = (r) => r.u?.five_hour?.resets_at && new Date(r.u.five_hour.resets_at) > Date.now();
  const before = await Promise.all(reg.profiles.map(fetchUsage));
  const lw = Math.max(...reg.profiles.map((p) => width(p.label)));
  console.log(`\n  ${c(1, '预热 5 小时窗口')}\n`);
  for (const [i, p] of reg.profiles.entries()) {
    const head = `  ${i + 1}. ${pad(p.label, lw)}  `;
    if (running(before[i])) {
      console.log(`${head}${c(2, `已在计时，${until(before[i].u.five_hour.resets_at)}后重置，跳过`)}`);
      continue;
    }
    process.stdout.write(`${head}发送中…`);
    const r = spawnSync(CLAUDE, ['-p', 'hi', '--model', 'haiku', '--tools', '', '--setting-sources', '',
      '--strict-mcp-config', '--no-session-persistence'],
    { env: childEnv(p.configDir), cwd: os.tmpdir(), encoding: 'utf8', timeout: 120000 });
    let after = await fetchUsage(p);
    for (let k = 0; r.status === 0 && !running(after) && k < 5; k++) { // the usage endpoint lags a few seconds
      await new Promise((ok) => setTimeout(ok, 3000));
      after = await fetchUsage(p);
    }
    const why = r.error?.message || (r.stderr || r.stdout || '').trim().split('\n').pop() || `退出码 ${r.status}`;
    console.log(`\r${head}${r.status === 0 && running(after) ? c(32, `已预热，${until(after.u.five_hour.resets_at)}后重置`)
      : r.status === 0 ? c(33, `已发送，但还没查到窗口开始计时（${after.err ?? '稍后用 usage 再看'}）`)
        : c(31, `失败：${why}`)}`);
    log('warmup', { profile_id: p.id, ok: r.status === 0 });
  }
  console.log();
}

// Folders Claude was used in, newest first, for the island's launch list. Paths come from each config's
// .claude.json; age from the transcript folder Claude names after the path (non-alphanumerics -> '-').
function recentProjects(reg, max = 8) {
  const seen = new Map(), tmp = os.tmpdir().toLowerCase();
  const sources = [[path.join(HOME, '.claude.json'), path.join(SHARED, 'projects')],
    ...reg.profiles.map((p) => [path.join(p.configDir, '.claude.json'), path.join(p.configDir, 'projects')])];
  for (const [cfg, dir] of sources) {
    let keys = [];
    try { keys = Object.keys(JSON.parse(fs.readFileSync(cfg, 'utf8')).projects ?? {}); } catch {}
    for (const k of keys) {
      let t = 0;
      try { t = fs.statSync(path.join(dir, k.replace(/[^a-zA-Z0-9]/g, '-'))).mtimeMs; } catch {}
      const p = path.resolve(k);
      if (t > (seen.get(p) ?? -1)) seen.set(p, t);
    }
  }
  return [...seen].filter(([p]) => !p.toLowerCase().startsWith(tmp) && fs.existsSync(p))
    .sort((a, b) => b[1] - a[1]).slice(0, max).map(([p]) => p);
}

// Past conversations of the accounts (not the old ~/.claude), newest first, for the island's list. Each
// account keeps one .jsonl per session under projects/<folder>/; a session resumed with another account
// (see resume) has a copy in each, and the newest copy wins. Only each file's head (cwd) and tail (latest
// title and prompt) are read: transcripts run to hundreds of MB. Live sessions come from sessions/<pid>.json.
const slice = (fd, pos, len) => { const b = Buffer.alloc(len); return b.toString('utf8', 0, fs.readSync(fd, b, 0, len, pos)); };
const field = (s, key, lastOne) => { // raw "key":"value" scan of a transcript slice: robust to cut-off lines
  const re = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  let m, v;
  while ((m = re.exec(s))) { v = m[1]; if (!lastOne) break; }
  try { return v ? JSON.parse(`"${v}"`) : null; } catch { return null; }
};

// Start times (Windows FILETIME, as sessions/<pid>.json's procStart) of these pids; null if PowerShell failed.
function procStarts(pids) {
  if (!pids.length) return new Map();
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | `
    + '% { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  return new Map(r.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(' ')));
}

function listSessions(reg) {
  const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  const live = new Map(), found = new Map(), alive = [];
  for (const [acct, dir] of reg.profiles.map((p, i) => [i, p.configDir])) {
    for (const f of ls(path.join(dir, 'sessions'))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', f), 'utf8'));
        process.kill(j.pid, 0); // throws once that Claude has exited
        alive.push(j);
      } catch {}
    }
    for (const folder of ls(path.join(dir, 'projects'))) {
      for (const name of ls(path.join(dir, 'projects', folder))) {
        if (!/^[0-9a-f-]{36}\.jsonl$/.test(name)) continue;
        const file = path.join(dir, 'projects', folder, name), at = fs.statSync(file).mtimeMs, id = name.slice(0, -6);
        if ((found.get(id)?.at ?? -1) < at) found.set(id, { id, acct, file, at });
      }
    }
  }
  // a Claude that didn't exit cleanly leaves its file, and Windows soon gives its pid to another program:
  // running means that pid also started when Claude wrote down (without PowerShell, the pid alone)
  const starts = procStarts(alive.map((j) => j.pid));
  for (const j of alive) if (!starts || !j.procStart || starts.get(String(j.pid)) === String(j.procStart)) live.set(j.sessionId, j.pid);
  let webPids = new Set(); // the Claudes the web service runs (web-terms.json, written by it)
  try { webPids = new Set(JSON.parse(fs.readFileSync(WEB_TERMS, 'utf8'))); } catch {}
  const tmp = os.tmpdir().toLowerCase(), out = [];
  for (const s of found.values()) {
    const fd = fs.openSync(s.file, 'r'), size = fs.fstatSync(fd).size;
    const head = slice(fd, 0, 65536), tail = slice(fd, Math.max(0, size - 524288), 524288);
    fs.closeSync(fd);
    const cwd = field(head, 'cwd') ?? field(tail, 'cwd', true);
    // the last thing you said, not a teammate's or a background task's message delivered as a prompt
    const prompt = [...tail.matchAll(/"lastPrompt":"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return ''; } })
      .filter((p) => p && !/^(Another Claude session sent a message|<task-notification>)/.test(p)).pop() ?? null;
    let named = null; // /rename's sidecar: holds the name even once its transcript line is out of the tail
    try { named = JSON.parse(fs.readFileSync(path.join(s.file.slice(0, -6), 'custom-title.json'), 'utf8')).customTitle; } catch {}
    const title = named || field(tail, 'customTitle', true) || field(tail, 'aiTitle', true) || field(head, 'aiTitle') || prompt;
    if (!cwd || !title || cwd.toLowerCase().startsWith(tmp) || !fs.existsSync(cwd)) continue; // nothing to go back to
    const pid = live.get(s.id) ?? null;
    out.push({ ...s, cwd, title, prompt: prompt === title ? null : prompt, pid, web: !!pid && webPids.has(pid),
      who: reg.profiles[s.acct].label.split('@')[0] });
  }
  return out.sort((a, b) => b.at - a.at);
}

// The key the island presses to split a conversation's tab into its own window before tiling: Windows
// Terminal's built-in "move tab to new window" action, which has no key by default. Prints added / ok / fail.
// The island's window arranging presses these. Windows Terminal can only move a tab into another window by
// that window's name, so the target is named, filled, then unnamed again.
const WT_BINDS = [
  { id: 'Terminal.MoveTabToNewWindow', keys: 'ctrl+alt+shift+f12' },
  { id: 'User.claudeMulti.nameWindow', keys: 'ctrl+alt+shift+f11', command: { action: 'renameWindow', name: 'claude-multi' } },
  { id: 'User.claudeMulti.unnameWindow', keys: 'ctrl+alt+shift+f10', command: { action: 'renameWindow', name: '' } },
  { id: 'User.claudeMulti.moveTabHere', keys: 'ctrl+alt+shift+f9', command: { action: 'moveTab', window: 'claude-multi' } },
];
function wtBind() {
  const file = path.join(process.env.LOCALAPPDATA ?? '', 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')); // ponytail: a settings file with comments isn't touched: arranging then can't move tabs
    j.keybindings ??= []; j.actions ??= [];
    let added = false;
    for (const b of WT_BINDS) {
      if (b.command && !j.actions.some((a) => a.id === b.id)) { j.actions.push({ command: b.command, id: b.id }); added = true; }
      if (!j.keybindings.some((k) => k.id === b.id && k.keys === b.keys)) { j.keybindings.push({ id: b.id, keys: b.keys }); added = true; }
    }
    if (!added) return console.log('ok');
    if (!fs.existsSync(`${file}.before-claude-multi`)) fs.copyFileSync(file, `${file}.before-claude-multi`); // the untouched original, to undo by hand
    fs.writeFileSync(file, JSON.stringify(j, null, 4) + '\n');
    console.log('added');
  } catch { console.log('fail'); }
}

// rename ID NAME: for a conversation that isn't running, what Claude's own /rename writes: a custom-title
// line in its transcript and the custom-title.json beside it. A running one holds its name in memory and
// writes it back, so it can only be renamed from inside, with /rename.
function rename(id, name) {
  const s = listSessions(load()).find((x) => x.id === id);
  name = (name ?? '').trim();
  if (!s || !name) { console.log('用法：claude-multi rename <对话 id> <新名字>'); process.exit(1); }
  if (s.pid) { console.log(`这个对话正在运行，请在它的窗口里输入：/rename ${name}`); process.exit(1); }
  fs.appendFileSync(s.file, JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: id }) + '\n');
  fs.mkdirSync(s.file.slice(0, -6), { recursive: true });
  fs.writeFileSync(path.join(s.file.slice(0, -6), 'custom-title.json'), JSON.stringify({ customTitle: name }), { mode: 0o600 });
  console.log(`已改名：${name}`);
}

// resume ID N: continue a past conversation with account N, in its own folder. Claude only finds a
// transcript in its own config dir, so the newest copy (and its side folder of subagent and tool-output
// files) is copied into N's first when another account wrote it last.
function resume(id, n) {
  const reg = load(), s = listSessions(reg).find((x) => x.id === id);
  if (!s) { console.log(`找不到对话 ${id}。`); process.exit(1); }
  if (s.pid) { console.log(`这个对话正在运行（进程 ${s.pid}），直接切到它的窗口即可。`); process.exit(1); }
  const p = reg.profiles[Number(n) - 1] ?? reg.profiles[s.acct];
  if (!p) { console.log('请指定账号编号：claude-multi resume <对话 id> <账号编号>'); process.exit(1); }
  copyTo(s, p);
  process.chdir(s.cwd);
  start(p, ['--resume', id], 'resume');
}
// attach ID: this terminal joins a conversation running in the web service (one started or continued from
// the web page): the same screen on both sides, either one types. The size follows the side you type on;
// the other side scales to it. Closing this tab leaves the conversation running there.
async function attach(id) {
  const base = `http://127.0.0.1:${WEB_PORT}`;
  const headers = { 'tailscale-user-login': tailscaleMe()?.login ?? '', 'content-type': 'application/json' };
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.err || r.status);
    return j;
  };
  const size = () => ({ cols: process.stdout.columns || 100, rows: process.stdout.rows || 30 });
  let key;
  try {
    const r = await post('/api/open', { id, ...size() });
    if (r.kind !== 'pty') throw new Error('它在电脑的终端窗口里运行，直接切过去就行');
    key = r.key;
  } catch (e) { console.log(`接不上这个对话：${e.message}`); process.exit(1); }
  let pty = null; // its size, as the web service last said
  const claim = (force) => {
    const m = size();
    if (!force && pty && pty.w === m.cols && pty.h === m.rows) return Promise.resolve();
    pty = { w: m.cols, h: m.rows };
    return post('/api/resize', { key, ...m }).catch(() => {});
  };
  let q = Promise.resolve(); // keystrokes in order, each after a size claim if another side had it
  process.stdin.setRawMode(true);
  process.stdin.on('data', (d) => { const data = d.toString('utf8'); q = q.then(() => claim()).then(() => post('/api/input', { key, data })).catch(() => {}); });
  process.stdout.on('resize', () => claim(true));
  try {
    const r = await fetch(`${base}/api/term?key=${encodeURIComponent(key)}`, { headers });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).err || r.status);
    // a nudge to a size one row off and back: Claude redraws the whole screen for this tab
    post('/api/resize', { key, cols: size().cols, rows: Math.max(10, size().rows - 1) }).then(() => claim(true));
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      for (let k; (k = buf.indexOf('\n\n')) >= 0; buf = buf.slice(k + 2)) {
        const block = buf.slice(0, k), ev = /^event: (\w+)/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev === 'data') process.stdout.write(JSON.parse(data));
        else if (ev === 'size') pty = JSON.parse(data);
        else if (ev === 'gone') process.exit(0); // Claude exited: the tab closes, as for one run here
      }
    }
    throw new Error('网页服务断开了');
  } catch (e) { // exit code 1 keeps the tab open, so the reason stays readable
    process.stdout.write(`\r\n\x1b[0m和网页服务的连接断了（${e.message}）。对话记录还在，从对话列表里重新打开就行。\r\n`);
    process.exit(1);
  }
}
// Before account p continues conversation s: its newest record (and side folder) into p's config dir.
function copyTo(s, p) {
  const dst = path.join(p.configDir, 'projects', path.basename(path.dirname(s.file)));
  if (path.resolve(dst).toLowerCase() === path.resolve(path.dirname(s.file)).toLowerCase()) return;
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(s.file, path.join(dst, `${s.id}.jsonl`));
  const side = s.file.slice(0, -6);
  if (fs.existsSync(side)) fs.cpSync(side, path.join(dst, s.id), { recursive: true });
  log('session_copied', { profile_id: p.id, session_id: s.id });
}

// delete ID: a conversation that isn't running goes to the Recycle Bin: its transcript in every account
// (resume copies it) and the side folder beside each. Its tokens are counted first; the usage page keeps
// counting a record once it's gone.
function del(id) {
  const reg = load(), s = listSessions(reg).find((x) => x.id === id);
  if (!s) { console.log(`找不到对话 ${id}。`); process.exit(1); }
  if (s.pid) { console.log('这个对话正在运行，先关掉它的窗口再删。'); process.exit(1); }
  tokenStats();
  const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  const paths = reg.profiles.flatMap((p) => ls(path.join(p.configDir, 'projects')).flatMap((folder) =>
    [`${id}.jsonl`, id].map((n) => path.join(p.configDir, 'projects', folder, n)))).filter((f) => fs.existsSync(f));
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName Microsoft.VisualBasic; '
    + 'foreach ($p in ($env:CM_DEL | ConvertFrom-Json)) { if (Test-Path -PathType Container $p) '
    + '{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, "OnlyErrorDialogs", "SendToRecycleBin") } '
    + 'else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, "OnlyErrorDialogs", "SendToRecycleBin") } }'],
  { env: { ...process.env, CM_DEL: JSON.stringify(paths) }, windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0 || paths.some((f) => fs.existsSync(f))) { console.log(`删除失败：${(r.stderr || '').trim().split('\n')[0]}`); process.exit(1); }
  log('session_deleted', { session_id: id, files: paths.length });
  console.log(`已删除「${s.title}」，可以在回收站里找回。`);
}

// True while a helper the conversation started is still at work, read from its transcript's tail. With
// teammates or background tasks, Claude ends a turn each time one of them reports in, long before the job
// is done. A teammate ("Spawned successfully") works until its idle_notification, and again after each
// SendMessage to it; a background agent or command ("Async agent launched", "Command running in
// background") until a task-notification names its tool call.
// Helpers started before this Claude process (since) died with the previous one, when the conversation was
// closed and resumed. ponytail: ones over 6 h old count as gone too, in case their end fell outside the tail
function helpersBusy(tail, since = 0) {
  const busy = new Map(), spawns = new Map(), team = new Set();
  for (const line of tail.split('\n')) {
    if (line.length > 262144) continue; // an image or long output, never a marker: skipping keeps this fast
    let j;
    try { j = JSON.parse(line); } catch { continue; } // the slice's cut-off first line
    if (j.isSidechain) continue;
    const at = Date.parse(j.timestamp) || Date.now();
    const parts = Array.isArray(j.message?.content) ? j.message.content : [];
    let text = typeof j.message?.content === 'string' ? j.message.content : typeof j.content === 'string' ? j.content : '';
    for (const p of parts) {
      if (p.type === 'text') text += p.text;
      if (p.type === 'tool_use') {
        if (p.name === 'Agent' && p.input?.name) spawns.set(p.id, p.input.name);
        if (p.name === 'SendMessage' && team.has(p.input?.to)) busy.set(`@${p.input.to}`, at); // wakes it
      }
      if (p.type === 'tool_result') {
        const r = typeof p.content === 'string' ? p.content : (p.content ?? []).map((x) => x.text ?? '').join('');
        if (r.startsWith('Spawned successfully') && spawns.has(p.tool_use_id)) {
          team.add(spawns.get(p.tool_use_id));
          busy.set(`@${spawns.get(p.tool_use_id)}`, at);
        }
        else if (/^(Async agent launched|Command running in background)/.test(r)) busy.set(p.tool_use_id, at);
      }
    }
    for (const m of text.matchAll(/<teammate-message teammate_id="([^"]+)"[^>]*>(\s*\{"type":"(idle_notification|shutdown_approved)")?/g)) {
      team.add(m[1]); // also names teammates spawned before the tail
      if (m[2]) busy.delete(`@${m[1]}`);
    }
    for (const m of text.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) busy.delete(m[1]);
  }
  return [...busy.values()].some((at) => at >= since && Date.now() - at < 6 * 3600e3);
}

// Claude Code hook (Stop / Notification): drops the message in the island's inbox and makes sure the
// island runs. Written to .tmp then renamed, so the island never reads half a file.
function notify(kind) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
  // Only conversations you started notify. A Claude started by another one (its Bash tool, a script, a
  // teammate) never registers in sessions/, and its "done" is for that other Claude, not for you.
  const reg = path.join(process.env.CLAUDE_CONFIG_DIR || SHARED, 'sessions', `${process.env.CLAUDE_PID}.json`);
  let started = 0, home = '';
  try { const r = JSON.parse(fs.readFileSync(reg, 'utf8')); if (r.kind !== 'interactive') return; started = r.startedAt; home = r.cwd ?? ''; } catch { return; }
  const tool = /needs your permission to use (.+)$/.exec(j.message ?? '')?.[1];
  const msg = kind !== 'ask' ? '任务完成，等你下一步指示' : tool ? `想使用 ${tool}，等你确认` : j.message || '需要你确认一下';
  let tail = '';
  try {
    const fd = fs.openSync(j.transcript_path, 'r');
    tail = slice(fd, Math.max(0, fs.fstatSync(fd).size - 16777216), 16777216); // 16 MB: images make lines huge
    fs.closeSync(fd);
  } catch {}
  if (kind === 'done' && helpersBusy(tail, started)) return; // it only paused to read a helper's message; the job goes on
  // the conversation's title, which its terminal tab shows: lets the island drop it once you look
  const title = field(tail, 'customTitle', true) ?? field(tail, 'aiTitle', true);
  fs.mkdirSync(INBOX, { recursive: true });
  const f = path.join(INBOX, `${Date.now()}-${process.pid}`);
  // the folder the conversation was opened in: the hook's cwd is wherever Claude last cd'd (a .build inside it, say)
  const dir = home || j.cwd;
  fs.writeFileSync(`${f}.tmp`, JSON.stringify({ kind, project: dir ? path.basename(dir) : '', msg, title, id: j.session_id ?? null,
    pid: Number(process.env.CLAUDE_PID) || null })); // Claude's own pid: lets a click find its terminal window
  fs.renameSync(`${f}.tmp`, `${f}.json`);
  // and for the phone page, which lists the latest ones (the file is trimmed to its last 200 now and then)
  fs.appendFileSync(NOTES, JSON.stringify({ at: Date.now(), kind, project: dir ? path.basename(dir) : '', msg, title, id: j.session_id ?? null }) + '\n');
  try { if (fs.statSync(NOTES).size > 262144) fs.writeFileSync(NOTES, readNotes(200).reverse().map((x) => JSON.stringify(x)).join('\n') + '\n'); } catch {}
  island();
}

// chats [arrange|tokens]: opens the island's conversation window, its window-arranging board or its token
// page, through the inbox.
function chats(page) {
  fs.mkdirSync(INBOX, { recursive: true });
  const f = path.join(INBOX, `${Date.now()}-${process.pid}`);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify({ kind: 'chats', arrange: page === 'arrange', tokens: page === 'tokens' }));
  fs.renameSync(`${f}.tmp`, `${f}.json`);
  island();
}

// Hidden and outliving us; island.ps1 holds a mutex, so a second start just exits. Via Start-Process
// because node's own children die with node (libuv's job) and `detached` ones get no console, where
// PowerShell quits at once; a grandchild started by Start-Process has neither problem.
function island() {
  // ponytail: a crashed island's pid reused by another process skips the start; the login shortcut recovers it
  try { process.kill(Number(fs.readFileSync(`${ISLAND}.pid`, 'utf8')), 0); return; } catch {} // already up: skip ~1.5 s
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '
    + `'-NoProfile -STA -ExecutionPolicy Bypass -File "${ISLAND}"'`], { stdio: 'ignore', windowsHide: true });
}

const WINDOWS = [['five_hour', '5 小时'], ['seven_day', '7 天'], ['seven_day_opus', 'Opus 7 天'], ['seven_day_sonnet', 'Sonnet 7 天']];
const readyAt = (u) => Math.max(0, ...WINDOWS.map(([k]) => u[k])
  .filter((w) => w && w.utilization >= 100 && w.resets_at).map((w) => +new Date(w.resets_at)));
// Every account's usage and the pick. json is what the island and the web page read.
async function usageState(reg = load()) {
  const res = await Promise.all(reg.profiles.map(fetchUsage));
  const ok = res.map((r, i) => ({ ...r, i })).filter((r) => r.u);
  const open = ok.filter((r) => runway(r.u) > 0);
  const rec = open.length ? pickOpen(open) : [...ok].sort((a, b) => readyAt(a.u) - readyAt(b.u))[0];
  // One column per window. Model windows get a column only once some account used them.
  const cols = WINDOWS.filter(([k]) => !k.startsWith('seven_day_') || ok.some((r) => r.u[k]?.utilization));
  const json = { rec: rec?.i ?? null, open: open.length > 0,
    ready: !open.length && rec ? until(readyAt(rec.u)) : null,
    accounts: reg.profiles.map((p, i) => ({ label: p.label, err: res[i].err ?? null,
      runway: res[i].u ? Math.round(runway(res[i].u) * 10) / 10 : null,
      windows: cols.filter(([k]) => res[i].u?.[k]).map(([k]) => ({ k, pct: Math.round(res[i].u[k].utilization),
        reset: res[i].u[k].resets_at ? until(res[i].u[k].resets_at) : '' })) })),
    projects: recentProjects(reg) };
  return { res, ok, open, rec, cols, json };
}

async function usage(args) {
  const reg = load();
  if (!reg.profiles.length) return console.log('没有已保存账号，请先运行 claude-multi new。');
  const bar = (pct) => {
    const n = Math.round(Math.min(100, pct) / 10);
    return c(pct >= 80 ? 31 : pct >= 50 ? 33 : 32, '█'.repeat(n)) + c(2, '░'.repeat(10 - n));
  };
  const { res, ok, open, rec, cols, json } = await usageState(reg);
  if (args.includes('--json')) return console.log(JSON.stringify(json)); // same numbers as the table below
  const lw = Math.max(...reg.profiles.map((p) => width(p.label)));
  const pw = Math.max(...reg.profiles.map((p) => width(p.subscriptionType ?? '')));
  const cell = (w) => (w ? `${bar(w.utilization)} ${String(Math.round(w.utilization)).padStart(3)}%  `
    + c(2, pad(w.resets_at ? until(w.resets_at) : '', 10)) : ' '.repeat(27)); // 10 + 1 + 4 + 2 + 10 cols
  console.log(`\n  ${c(1, 'Claude 账号用量')}  ${c(2, new Date().toLocaleString('zh-CN', { hour12: false }))}\n`);
  console.log(c(2, ' '.repeat(9 + lw + pw) + cols.map(([, name]) => '   ' + pad(name, 17) + pad('距重置', 10)).join('')));
  reg.profiles.forEach((p, i) => {
    const mark = p.id === reg.active ? '*' : ' ';
    const tag = rec?.i === i ? '  ' + c('1;32', open.length ? '← 推荐' : '← 最早恢复') : '';
    const cells = res[i].err ? c(33, res[i].err) : cols.map(([k]) => cell(res[i].u[k])).join('   ');
    console.log(`  ${i + 1}. ${mark} ${c(1, pad(p.label, lw))}  ${c(2, pad(p.subscriptionType ?? '', pw))}   ${cells}${tag}`);
  });
  console.log();

  if (!rec) return console.log(`  ${c(33, '无法获取任何账号的用量，暂不推荐。')}\n`);
  const p = reg.profiles[rec.i], u = rec.u;
  if (!open.length) {
    const who = ok.length < res.length ? '查到的账号都已达到上限' : '所有账号都已达到上限';
    console.log(`  ${c('1;31', who)}  最早恢复：${rec.i + 1}. ${p.label}  ${c(2, `${until(readyAt(u))}后`)}\n`);
    return;
  }
  const left = (w) => `${100 - Math.round(w?.utilization ?? 0)}%`;
  console.log(`  ${c('1;32', '推荐')}  ${rec.i + 1}. ${p.label}  ${c(36, `约可连续用 ${runway(u).toFixed(1)} 小时`)}`);
  console.log(`        ${c(2, `5 小时剩 ${left(u.five_hour)}，7 天剩 ${left(u.seven_day)}`)}\n`);
  // Enter is the user's explicit choice of the shown recommendation; anything else (or EOF) just exits.
  if (ask(`  按回车用 ${rec.i + 1} 启动 Claude，输入其他内容退出：`) !== '') return console.log();
  start(p, args, 'usage_recommended');
}

// --- web: the phone page --------------------------------------------------------------------------
// claude-multi web: a page for the phone with what the island shows (usage, conversations, notifications,
// tokens) and the conversations themselves, as real terminals: one started or continued from the page runs
// in a pseudo-terminal here (node-pty) sized to the phone; one already open in a terminal window on this
// computer is mirrored by console-bridge.ps1 (its screen, typing into it), so both sides use the same one.
// Listens on 127.0.0.1 only. `tailscale serve` publishes it to the tailnet over HTTPS and names the visitor
// in Tailscale-User-Login; only this machine's own Tailscale user gets in, as the page runs Claude here.
const NOTES = path.join(ROOT, 'notes.jsonl');
const WEB_TERMS = path.join(ROOT, 'web-terms.json'); // pids of the Claudes running in the web service
const WEB_PORT = 7788;
const TAILSCALE = 'C:\\Program Files\\Tailscale\\tailscale.exe';

function tailscaleMe() {
  const r = spawnSync(fs.existsSync(TAILSCALE) ? TAILSCALE : 'tailscale', ['status', '--json'], { encoding: 'utf8', windowsHide: true });
  try { const j = JSON.parse(r.stdout); return { login: j.User[j.Self.UserID].LoginName, host: j.Self.DNSName.replace(/\.$/, '') }; } catch { return null; }
}
function readNotes(n = 30) {
  try {
    const fd = fs.openSync(NOTES, 'r'), size = fs.fstatSync(fd).size, t = slice(fd, Math.max(0, size - 65536), 65536);
    fs.closeSync(fd);
    return t.split('\n').slice(-n - 1).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}

// Read marks, shared by the island and every browser: a line {id, at} = that conversation's notifications
// up to at are done; id '*' = all of them. The island appends its own (you went to the tab, clicked, cleared).
const READ = path.join(ROOT, 'notes-read.jsonl');
function readMarks() {
  const m = new Map();
  try { for (const l of fs.readFileSync(READ, 'utf8').split('\n')) { try { const j = JSON.parse(l); if (j.at > (m.get(j.id) ?? 0)) m.set(j.id, j.at); } catch {} } } catch {}
  return m;
}
function markRead(id) {
  fs.appendFileSync(READ, JSON.stringify({ id, at: Date.now() }) + '\n');
  try { if (fs.statSync(READ).size > 65536) fs.writeFileSync(READ, [...readMarks()].map(([i, at]) => JSON.stringify({ id: i, at })).join('\n') + '\n'); } catch {}
}
// When you last said something in a conversation (a prompt, a slash command), not counting what Claude
// hands itself as a prompt (a background task's or a teammate's message). Cached until the file changes.
const saidCache = new Map();
function lastSaid(file) {
  try {
    const mt = fs.statSync(file).mtimeMs, c = saidCache.get(file);
    if (c?.mt === mt) return c.at;
    const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size;
    const lines = slice(fd, Math.max(0, size - 4194304), 4194304).split('\n');
    fs.closeSync(fd);
    let at = 0;
    for (let i = lines.length - 1; i >= 0 && !at; i--) {
      if (!lines[i].includes('"type":"user"')) continue;
      try {
        const j = JSON.parse(lines[i]), m = j.message?.content;
        if (j.type !== 'user' || j.isMeta || j.isCompactSummary) continue;
        const t = typeof m === 'string' ? m : Array.isArray(m) ? m.find((x) => x.type === 'text')?.text : null;
        if (t && !/^<(task-notification|teammate-message)/.test(t.trimStart())) at = Date.parse(j.timestamp) || 0;
      } catch {}
    }
    saidCache.set(file, { mt, at });
    return at;
  } catch { return 0; }
}
// The notifications still waiting for you: the latest per conversation, unless it was marked read (here,
// in the island, on another device) or you've said something in that conversation since.
function unreadNotes(list, notes = readNotes(60), marks = readMarks()) {
  const all = marks.get('*') ?? 0, files = new Map(list.map((s) => [s.id, s.file])), seen = new Set();
  return notes.filter((n) => {
    const k = n.id ?? n.at;
    if (seen.has(k)) return false;
    seen.add(k);
    return n.at > all && n.at > (marks.get(n.id) ?? 0) && !(files.has(n.id) && lastSaid(files.get(n.id)) > n.at);
  }).slice(0, 10);
}

// A conversation's record as readable messages, for the page's 记录 view (a window here only shows its
// current screen): what you said, Claude's replies, one line per tool call. Tool output, thinking and
// Claude's own bookkeeping (reminders, background-task notices) are left out. The last 16 MB, last 600 items.
function history(file, max = 600) {
  const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size;
  const lines = slice(fd, Math.max(0, size - 16777216), 16777216).split('\n');
  fs.closeSync(fd);
  const out = [];
  const add = (role, text, at) => {
    text = String(text ?? '').trim();
    if (text) out.push({ role, text: text.length > 20000 ? text.slice(0, 20000) + '…' : text, at });
  };
  for (const l of lines) {
    if (!l.includes('"type":"user"') && !l.includes('"type":"assistant"')) continue;
    if (l.includes('"type":"tool_result"')) continue; // tool output, often huge (screenshots): not shown, not parsed
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (j.isMeta || j.isSidechain) continue;
    const at = Date.parse(j.timestamp) || 0, c = j.message?.content;
    if (j.type === 'user') {
      if (j.isCompactSummary) { add('note', '更早的内容已压缩', at); continue; }
      for (const p of typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []) {
        if (p.type === 'image') add('user', '[图片]', at);
        if (p.type !== 'text') continue;
        let t = p.text.trim();
        if (/^<(task-notification|teammate-message|local-command-stdout|local-command-caveat|system-reminder)/.test(t)) continue;
        const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
        if (cmd) t = `${cmd[1]} ${/<command-args>([^<]*)<\/command-args>/.exec(t)?.[1] ?? ''}`; // a slash command, as typed
        add('user', t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ''), at);
      }
    } else if (Array.isArray(c)) {
      for (const p of c) {
        if (p.type === 'text') add('claude', p.text, at);
        else if (p.type === 'tool_use') {
          const i = p.input ?? {}, what = i.description ?? i.command ?? i.file_path ?? i.pattern ?? i.query ?? i.url ?? i.skill ?? i.prompt ?? '';
          add('tool', `${p.name}  ${String(what).split('\n')[0].slice(0, 160)}`, at);
        }
      }
    }
  }
  return out.slice(-max);
}

async function web() {
  const http = require('http'), pty = require('@lydell/node-pty');
  const me = tailscaleMe();
  if (!me) { console.log('读不到 Tailscale 的登录信息：先在这台电脑上登录 Tailscale。'); process.exit(1); }
  const claudeExe = spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/)[0].trim() || CLAUDE;
  const terms = new Map(); // key -> { kind: 'pty' | 'pc', sid, pid, proc, clients: Set, buf, w, h, gone }
  let usageCache = null, usageAt = 0, sessCache = null, sessAt = 0;

  const send = (t, ev, data) => { for (const res of t.clients) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
  const sessions = () => {
    if (!sessCache || Date.now() - sessAt > 3000) { sessCache = listSessions(load()); sessAt = Date.now(); }
    return sessCache;
  };
  // a conversation started or continued here: claude in a pseudo-terminal, its output kept (last 256 KB) for
  // whoever opens it later
  function startPty(p, cwd, args, cols = 100, rows = 30) {
    const key = `p${Date.now().toString(36)}`;
    const proc = pty.spawn(claudeExe, args, { name: 'xterm-256color', cols, rows, cwd, env: childEnv(p.configDir) });
    // pid read live: node-pty only knows it once the pseudo-terminal is ready (it is 0 right after spawn)
    const t = { kind: 'pty', key, get pid() { return proc.pid; }, proc, clients: new Set(), buf: '', w: cols, h: rows, cwd };
    proc.onData((d) => {
      if (!t.listed && proc.pid) { t.listed = true; saveTerms(); }
      t.buf = (t.buf + d).slice(-262144); send(t, 'data', d);
    });
    proc.onExit(() => { t.gone = true; saveTerms(); send(t, 'gone', {}); setTimeout(() => terms.delete(key), 60000); });
    terms.set(key, t);
    log('web_session', { profile_id: p.id, cwd, args: args.join(' ') });
    return t;
  }
  // a conversation open in a terminal window here: its screen through the console bridge, while anyone watches
  function mirror(pid) {
    const key = `w${pid}`;
    if (terms.has(key) && !terms.get(key).gone) return terms.get(key);
    const proc = require('child_process').spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(ROOT, 'console-bridge.ps1'), String(pid)], { windowsHide: true });
    const t = { kind: 'pc', key, pid, proc, clients: new Set(), frame: null, w: 0, h: 0 };
    let line = '';
    proc.stdout.on('data', (d) => {
      line += d;
      for (let k; (k = line.indexOf('\n')) >= 0; line = line.slice(k + 1)) {
        let m; try { m = JSON.parse(line.slice(0, k)); } catch { continue; }
        if (m.gone) { t.gone = true; send(t, 'gone', {}); continue; }
        // lines scrolled off the window's top: the page scrolls its screen as far, so they go to its history
        if (m.s) { if (t.h) send(t, 'data', `\x1b[${t.h};1H` + '\n'.repeat(m.s)); continue; }
        if (m.w !== t.w || m.h !== t.h) { t.w = m.w; t.h = m.h; send(t, 'size', { w: m.w, h: m.h }); }
        t.frame = m.f; send(t, 'data', m.f);
      }
    });
    proc.on('exit', () => { t.gone = true; send(t, 'gone', {}); terms.delete(key); });
    setTimeout(() => { if (!t.clients.size) proc.kill(); }, 30000); // opened but nobody came to watch: not left running
    terms.set(key, t);
    return t;
  }
  const where = (s) => [...terms.values()].find((t) => !t.gone && t.pid === s.pid); // ours, or a window here
  // for the island and `claude-multi attach`: which running conversations are ours
  function saveTerms() {
    try { fs.writeFileSync(WEB_TERMS, JSON.stringify([...terms.values()].filter((t) => t.kind === 'pty' && !t.gone && t.pid).map((t) => t.pid))); } catch {}
  }

  const api = {
    'GET /api/state': async (q) => {
      if (!usageCache || Date.now() - usageAt > 60000 || q.has('fresh')) { usageCache = (await usageState()).json; usageAt = Date.now(); }
      const all = sessions(), list = all.map(({ file, ...s }) => ({ ...s, where: !s.pid ? null : where(s)?.kind === 'pty' ? 'web' : 'pc' }));
      return { usage: usageCache, sessions: list, notes: unreadNotes(all), me: me.login };
    },
    'GET /api/tokens': () => tokenStats(),
    'GET /api/history': (q) => { // asked every 4 s while shown: the cached list gives the file, read fresh below
      const s = sessions().find((x) => x.id === q.get('id'));
      if (!s) throw new Error('找不到这个对话');
      return { items: history(s.file) };
    },
    'POST /api/read': (q, b) => { // {id} one conversation's notifications, {all: true} every one; the island drops them too
      const id = b.all ? '*' : /^[\w-]{1,80}$/.test(b.id ?? '') ? b.id : null;
      if (!id) throw new Error('缺少对话 id');
      markRead(id);
      fs.mkdirSync(INBOX, { recursive: true });
      const f = path.join(INBOX, `${Date.now()}-read`);
      fs.writeFileSync(`${f}.tmp`, JSON.stringify({ kind: 'read', id }));
      fs.renameSync(`${f}.tmp`, `${f}.json`);
      return {};
    },
    'POST /api/warmup': () => new Promise((ok) => { // not spawnSync: the terminals keep streaming meanwhile
      require('child_process').execFile(process.execPath, [__filename, 'warmup'], { env: { ...process.env, NO_COLOR: '1' }, windowsHide: true },
        (e, stdout) => { usageCache = null; ok({ out: String(stdout || e?.message || '').trim() }); });
    }),
    // open a conversation's terminal: {id, acct?} continues one (its window here if it runs in one),
    // {dir, acct} starts one. acct is 1-based; the page proposes it like the island does.
    'POST /api/open': (q, b) => {
      const reg = load(), cols = Math.max(40, Math.min(300, b.cols | 0 || 100)), rows = Math.max(10, Math.min(200, b.rows | 0 || 30));
      if (b.id) {
        sessCache = null;
        const s = sessions().find((x) => x.id === b.id);
        if (!s) throw new Error('找不到这个对话');
        if (s.pid) { const t = where(s) ?? mirror(s.pid); return { key: t.key, kind: t.kind }; }
        const p = reg.profiles[b.acct - 1] ?? reg.profiles[s.acct];
        copyTo(s, p);
        return { key: startPty(p, s.cwd, ['--resume', s.id], cols, rows).key, kind: 'pty' };
      }
      const p = reg.profiles[b.acct - 1];
      if (!p) throw new Error('没有这个账号');
      if (!b.dir || !fs.statSync(b.dir).isDirectory()) throw new Error('文件夹不存在');
      sessCache = null;
      return { key: startPty(p, b.dir, [], cols, rows).key, kind: 'pty' };
    },
    'POST /api/input': (q, b) => {
      const t = terms.get(b.key);
      if (!t || t.gone) throw new Error('这个终端已经结束');
      if (t.kind === 'pty') t.proc.write(String(b.data)); else t.proc.stdin.write(JSON.stringify({ k: String(b.data) }) + '\n');
      return {};
    },
    'POST /api/resize': (q, b) => { // phone-sized for our own terminals; a window here keeps its own size
      const t = terms.get(b.key);
      if (t?.kind === 'pty' && !t.gone && b.cols > 0 && b.rows > 0) {
        t.w = Math.min(300, b.cols | 0); t.h = Math.min(200, b.rows | 0);
        t.proc.resize(t.w, t.h);
        send(t, 'size', { w: t.w, h: t.h }); // the side you use last decides; the others scale to it
      }
      return {};
    },
  };

  const server = http.createServer(async (req, res) => {
    const out = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      if (req.headers['tailscale-user-login'] !== me.login) return out(403, { err: `只有 ${me.login} 能打开` });
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/') return out(200, fs.readFileSync(path.join(ROOT, 'web.html'), 'utf8'), 'text/html; charset=utf-8');
      const icon = { '/favicon.ico': ['island.ico', 'image/x-icon'], '/icon-180.png': ['icon-180.png', 'image/png'] }[url.pathname]; // the island's
      if (req.method === 'GET' && icon) { res.writeHead(200, { 'content-type': icon[1], 'cache-control': 'max-age=86400' }); return res.end(fs.readFileSync(path.join(ROOT, icon[0]))); }
      if (req.method === 'GET' && url.pathname === '/api/term') { // the terminal's output, as server-sent events
        const t = terms.get(url.searchParams.get('key'));
        if (!t) return out(404, { err: '这个终端已经结束' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        t.clients.add(res);
        res.write(`event: size\ndata: ${JSON.stringify({ w: t.w, h: t.h, kind: t.kind })}\n\n`);
        const past = t.kind === 'pty' ? t.buf : t.frame;
        if (past) res.write(`event: data\ndata: ${JSON.stringify(past)}\n\n`);
        if (t.gone) res.write('event: gone\ndata: {}\n\n');
        const beat = setInterval(() => res.write(': \n\n'), 20000);
        req.on('close', () => {
          clearInterval(beat); t.clients.delete(res);
          if (t.kind === 'pc') setTimeout(() => { if (!t.clients.size) t.proc.kill(); }, 30000); // nobody watching
        });
        return;
      }
      const fn = api[`${req.method} ${url.pathname}`];
      if (!fn) return out(404, { err: '没有这个地址' });
      let body = {};
      if (req.method === 'POST') {
        // only from our own page: JSON from the same origin (another site's page can't send that cross-origin)
        if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return out(415, { err: '只收 JSON' });
        if (req.headers.origin && new URL(req.headers.origin).host !== me.host) return out(403, { err: '来源不对' });
        let raw = ''; for await (const ch of req) { raw += ch; if (raw.length > 1 << 20) return out(413, { err: '太大' }); }
        body = JSON.parse(raw || '{}');
      }
      out(200, await fn(url.searchParams, body));
    } catch (e) { out(500, { err: e.message }); }
  });
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') process.exit(0); throw e; }); // already running
  server.listen(WEB_PORT, '127.0.0.1', () => saveTerms() || console.log(`手机页面：https://${me.host}/  （只有 ${me.login} 能打开）`));
}

// Claude Code's status line: the account (bold, in its own color), model and effort, the conversation's folder
// (and where it works now, when that's elsewhere), context used. Claude Code draws the ANSI colors.
// Identity comes from this process's own CLAUDE_CONFIG_DIR, never from the global "active".
// tokens [--json]: tokens used per day, read from the registered accounts' conversation records (not the
// old ~/.claude from before claude-multi).
// A reply's usage sits on its assistant lines. Claude Code writes one line per content block, and rewrites
// (compaction, a resume copied to another account) repeat lines, some with the usage zeroed, so each
// message id + request id counts once, at its largest. Total = input + output + cache writes + cache reads.
// A reply is [key, day, input, output, 5-min cache writes, 1-h cache writes, cache reads, model, fast].
// tokens-cache.json keeps each file's replies and how far it was read: a run reads only what was appended.
function tokenRoots(reg = load()) {
  return reg.profiles.map((p) => ({ label: p.label, dir: path.join(p.configDir, 'projects') }));
}
// What the tokens would cost on the API: $ per million [input, output, cache read]; cache writes are 1.25x
// input (5 min) or 2x (1 h), fast mode doubles it all. The longest matching name wins (opus-5 vs opus-5-5).
// ponytail: copied by hand from Anthropic's price list (2026-06); a model not
// listed is priced as Opus 5.5, so add a row when a new one shows up
const PRICES = { 'claude-fable-5-1': [10, 50, 0.25], 'claude-fable-5': [10, 50, 1], 'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5], 'claude-opus-4': [5, 25, 0.5], 'claude-sonnet-5': [2, 10, 0.2], 'claude-sonnet-4': [3, 15, 0.3],
  'claude-haiku-4': [1, 5, 0.1], '<synthetic>': [0, 0, 0] };
function replyCost([, , i, o, w5, w1, r, model, fast]) {
  const k = Object.keys(PRICES).filter((p) => (model ?? '').startsWith(p)).sort((a, b) => b.length - a.length)[0];
  const [pi, po, pr] = PRICES[k ?? 'claude-opus-5-5'];
  return ((i + w5 * 1.25 + w1 * 2) * pi + o * po + r * pr) / 1e6 * (fast ? 2 : 1);
}
function tokenStats(roots = tokenRoots(), cacheFile = path.join(ROOT, 'tokens-cache.json')) {
  let cache = { v: 2, files: {} };
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') try { fs.copyFileSync(cacheFile, `${cacheFile}.bad`); } catch {} // unreadable: keep it for a hand rescue
  }
  if (cache.v !== 2) { // the first format had no model or cache-write kind: read the records again; for
    const files = {};  // deleted ones keep the counts, with the commonest kind (1 h) and price (Opus 5.5)
    for (const [f, c] of Object.entries(cache)) if (c?.recs && !fs.existsSync(f)) files[f] = { size: c.size, recs: c.recs.map(([k, d, i, o, w, r]) => [k, d, i, o, 0, w, r, '', 0]) };
    cache = { v: 2, files };
  }
  const num = (s, k) => +(s.match(new RegExp(`"${k}":(\\d+)`))?.[1] ?? 0);
  const two = (n) => String(n).padStart(2, '0');
  const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
  const sum = (x) => x[2] + x[3] + x[4] + x[5] + x[6];
  const walk = (d, out = []) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch {}
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.jsonl')) out.push(p); }
    return out;
  };
  const next = {}, best = new Map();
  // A reply found in several files counts at its largest; on a tie, in the oldest file: a resume copies the
  // whole record into the other account (a newer file), and the replies belong to the account that made them.
  const count = (c, ri) => {
    for (const x of c.recs) {
      const b = best.get(x[0]);
      if (!b || sum(x) > sum(b.x) || (sum(x) === sum(b.x) && (c.born ?? Infinity) < b.born)) best.set(x[0], { x, ri, born: c.born ?? Infinity });
    }
  };
  roots.forEach((r, ri) => {
    for (const f of walk(r.dir)) {
      const st = fs.statSync(f), size = st.size;
      let c = cache.files[f] ?? { size: 0, recs: [] };
      c.born ??= st.birthtimeMs;
      if (size < c.size) c.size = 0; // rewritten shorter: read it all again, keeping what it had
      if (size > c.size) {
        const fd = fs.openSync(f, 'r'), at = new Map(c.recs.map((x, i) => [x[0], i]));
        // in pieces: one string can't pass ~512 MB; a piece ends at its last full line, a line still being
        // written waits for the next run, and a line longer than a piece gets a bigger piece
        for (let step = 32 << 20; c.size < size;) {
          const buf = Buffer.alloc(Math.min(step, size - c.size));
          fs.readSync(fd, buf, 0, buf.length, c.size);
          const end = buf.lastIndexOf(10) + 1;
          if (!end) { if (c.size + buf.length >= size) break; step *= 2; continue; }
          for (const l of buf.toString('utf8', 0, end).split('\n')) {
            if (!l.includes('"type":"assistant"') || !l.includes('"usage":')) continue;
            const id = l.match(/"id":"(msg_[^"]+)"/)?.[1], ts = l.match(/"timestamp":"([^"]+)"/)?.[1];
            if (!id || !ts) continue;
            const u = l.slice(l.indexOf('"usage":')), w = num(u, 'cache_creation_input_tokens'), w1 = Math.min(w, num(u, 'ephemeral_1h_input_tokens'));
            const x = [`${id}:${l.match(/"requestId":"([^"]+)"/)?.[1] ?? ''}`, day(ts), num(u, 'input_tokens'), num(u, 'output_tokens'),
              w - w1, w1, num(u, 'cache_read_input_tokens'), l.match(/"model":"([^"]+)"/)?.[1] ?? '', +/"speed":"fast"/.test(u)];
            const i = at.get(x[0]);
            if (i === undefined) { at.set(x[0], c.recs.length); c.recs.push(x); } else if (sum(x) > sum(c.recs[i])) c.recs[i] = x;
          }
          c.size += end;
        }
        fs.closeSync(fd);
      }
      next[f] = c;
      count(c, ri);
    }
  });
  // Claude Code deletes records older than 30 days (cleanupPeriodDays): their replies stay counted from here.
  // ponytail: the cache keeps every reply forever (~2 MB per busy fortnight); fold old files into day totals if it gets slow
  for (const [f, c] of Object.entries(cache.files)) {
    const ri = roots.findIndex((r) => f.startsWith(r.dir + path.sep));
    if (next[f] || ri < 0 || fs.existsSync(f)) continue;
    next[f] = c;
    count(c, ri);
  }
  // whole or not at all: this cache is the only record left of deleted transcripts, so a cut-off write must
  // never replace it (two runs at once: the later rename wins, each file whole)
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 2, files: next }));
  try { fs.renameSync(tmp, cacheFile); } catch { fs.rmSync(tmp, { force: true }); } // held open by another run: it saves
  // per day, and inside each day per account (by[n]); usd is the API price of the same tokens
  const zero = () => ({ i: 0, o: 0, cw: 0, cr: 0, usd: 0 });
  const add = (t, x, usd) => { t.i += x[2]; t.o += x[3]; t.cw += x[4] + x[5]; t.cr += x[6]; t.usd += usd; };
  const days = {}, accounts = roots.map((r) => ({ label: r.label, total: 0, usd: 0 }));
  for (const { x, ri } of best.values()) {
    const usd = replyCost(x), t = (days[x[1]] ??= { d: x[1], ...zero(), by: roots.map(zero) });
    add(t, x, usd); add(t.by[ri], x, usd);
    accounts[ri].total += sum(x); accounts[ri].usd += usd;
  }
  return { days: Object.values(days).sort((a, b) => (a.d < b.d ? -1 : 1)), accounts, total: accounts.reduce((s, a) => s + a.total, 0),
    usd: accounts.reduce((s, a) => s + a.usd, 0), today: day(Date.now()) };
}

const ACCOUNT_COLORS = ['38;2;10;132;255', '38;2;255;159;10', '38;2;191;90;242', '38;2;48;209;88']; // the island's blue, orange, purple, green
function statusline(input = {}) {
  const paint = (code, s) => (process.env.NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`);
  const dir = process.env.CLAUDE_CONFIG_DIR;
  const key = (d) => (process.platform === 'win32' ? path.resolve(d).toLowerCase() : path.resolve(d));
  const profiles = load().profiles;
  const i = dir ? profiles.findIndex((q) => key(q.configDir) === key(dir)) : -1;
  const who = i >= 0 ? `${paint(2, `账号 ${i + 1}`)} ${paint(`1;${ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]}`, profiles[i].label)}`
    : paint(1, dir ? '未登记的账号' : '~/.claude');
  const parts = [who];
  const model = [input.model?.display_name, input.effort?.level].filter(Boolean).join(' · ');
  if (model) parts.push(model);
  // The folder the conversation was opened in (where resume works). current_dir is just where Claude's shell happens to be.
  const proj = input.workspace?.project_dir ?? input.cwd;
  if (proj) parts.push(proj);
  const pct = input.context_window?.used_percentage;
  if (pct != null) parts.push(pct >= 50 ? paint(pct >= 80 ? 31 : 33, `context ${Math.round(pct)}%`) : `context ${Math.round(pct)}%`);
  return parts.join(paint(2, '  │  '));
}

module.exports = { pickOpen, childEnv, helpersBusy, statusline, tokenStats, unreadNotes, history };
if (require.main === module) {
  fs.mkdirSync(ROOT, { recursive: true });
  const [cmd] = process.argv.slice(2);
  if (cmd === 'new') process.exitCode = newProfile() ? 0 : 1;
  else if (cmd === 'switch') switchDefault();
  else if (cmd === 'list') list();
  else if (cmd === 'usage') usage(process.argv.slice(3));
  else if (cmd === 'warmup') warmup();
  else if (cmd === 'notify') notify(process.argv[3]);
  else if (cmd === 'notes') { // the unread notifications, for the island: the same list the web page shows
    const list = listSessions(load()), pid = new Map(list.map((x) => [x.id, x.pid]));
    console.log(JSON.stringify(unreadNotes(list).map((n) => ({ ...n, pid: pid.get(n.id) ?? null }))));
  }
  else if (cmd === 'island') island();
  else if (cmd === 'chats') chats(process.argv[3]);
  else if (cmd === 'resume') resume(process.argv[3], process.argv[4]);
  else if (cmd === 'attach') attach(process.argv[3]);
  else if (cmd === 'delete') del(process.argv[3]);
  else if (cmd === 'web') web();
  else if (cmd === 'rename') rename(process.argv[3], process.argv.slice(4).join(' '));
  else if (cmd === 'wt-bind') wtBind();
  else if (cmd === 'sessions') {
    const all = listSessions(load());
    if (process.argv.includes('--json')) console.log(JSON.stringify(all));
    else for (const s of all) console.log(`${s.pid ? '●' : ' '} ${new Date(s.at).toLocaleString('zh-CN', { hour12: false })}  ${pad(s.who, 16)} ${s.id}  ${path.basename(s.cwd)} · ${s.title}`);
  }
  else if (cmd === 'start') { // start N [claude args]: no menu, used by the island
    const p = load().profiles[Number(process.argv[3]) - 1];
    if (!p) { console.log('没有这个账号编号。'); process.exit(1); }
    start(p, process.argv.slice(4), 'island');
  }
  else if (cmd === 'tokens') {
    const t = tokenStats();
    if (process.argv.includes('--json')) console.log(JSON.stringify(t));
    else {
      const all = (d) => d.i + d.o + d.cw + d.cr, yi = (n) => `${(n / 1e8).toFixed(2)} 亿`, money = (u) => `$${u.toFixed(2)}`;
      console.log(`累计 ${yi(t.total)}  按 API 价格约 ${money(t.usd)}`);
      for (const d of t.days.slice(-7)) console.log(`${d.d}  ${yi(all(d)).padStart(10)}  ${money(d.usd)}`);
    }
  }
  else if (cmd === 'statusline') {
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
    console.log(statusline(input));
  }
  else launch(process.argv.slice(2));
}
