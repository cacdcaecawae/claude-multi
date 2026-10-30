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

// The folder under projects\ where Claude keeps a working folder's records and notes: non-alphanumerics -> '-'.
const projectFolder = (d) => d.replace(/[^a-zA-Z0-9]/g, '-');
// What Claude remembers about a folder (projects\<folder>\memory) is kept per config dir, so a conversation continued
// on another account forgot all of it. One copy for every account: ~/.claude's, the one plain claude reads too; each
// account's is a junction to it. One still real (from before, or one Claude made meanwhile) is merged in first: notes
// the shared copy lacks are added, a note in both keeps its newest version, the MEMORY.md indexes are joined, and the
// originals (both sides) go to memory-backup\. extra: [config dir, folder] that Claude is about to start in.
function shareMemory(extra = [], roots = [SHARED, ...load().profiles.map((p) => p.configDir)], backup = path.join(ROOT, 'memory-backup')) {
  const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  const lines = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const note = (l) => /\]\(([^)]+)\)/.exec(l)?.[1] ?? l; // an index line's note file
  const [home, ...accts] = roots, keep = path.join(backup, String(Date.now()));
  for (const [d, f] of [...accts.flatMap((a) => ls(path.join(a, 'projects')).map((f) => [a, f])), ...extra]) {
    const m = path.join(d, 'projects', f, 'memory'), to = path.join(home, 'projects', f, 'memory');
    try {
      const st = fs.lstatSync(m, { throwIfNoEntry: false });
      if (st && (st.isSymbolicLink() || !st.isDirectory())) continue; // shared already
      fs.mkdirSync(to, { recursive: true });
      if (!st) fs.mkdirSync(path.dirname(m), { recursive: true });
      else if (!ls(m).length) fs.rmdirSync(m);
      else {
        const was = path.join(keep, 'shared', f);
        if (!fs.existsSync(was)) fs.cpSync(to, was, { recursive: true }); // the shared copy as it was, once
        for (const n of ls(m)) {
          const a = path.join(m, n), b = path.join(to, n);
          if (!fs.statSync(a).isFile()) continue;
          if (!fs.existsSync(b)) fs.copyFileSync(a, b);
          else if (n === 'MEMORY.md') { // the newer index's lines, then the older one's for notes it doesn't list
            const [nw, old] = fs.statSync(a).mtimeMs > fs.statSync(b).mtimeMs ? [a, b] : [b, a];
            const out = lines(nw), have = new Set(out.map(note));
            for (const l of lines(old)) if (!have.has(note(l))) { out.push(l); have.add(note(l)); }
            fs.writeFileSync(b, out.join('\n') + '\n');
          } else if (fs.statSync(a).mtimeMs > fs.statSync(b).mtimeMs) fs.copyFileSync(a, b);
        }
        fs.mkdirSync(path.join(keep, path.basename(d)), { recursive: true });
        fs.renameSync(m, path.join(keep, path.basename(d), f));
      }
      fs.symlinkSync(to, m, 'junction');
    } catch {} // ponytail: a note held open, or two starts at once: left as it is, the next start tries again
  }
}
// MCP servers added with `claude mcp add` live in each config's own .claude.json (beside its login and state), so
// one added in one account or in plain claude was missing in the others. Kept as one set: what was added, changed or
// removed in any of them since it was last seen there (mcp-shared.json: the set, and each file as last seen) goes
// into the set, which is written to ~/.claude.json and to the config about to start; the others get it when they start.
function shareMcp(dir, files = [path.join(HOME, '.claude.json'), ...load().profiles.map((p) => path.join(p.configDir, '.claude.json'))],
  stateFile = path.join(ROOT, 'mcp-shared.json')) {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const st = read(stateFile) ?? { set: {}, seen: {} }, set = st.set;
  for (const f of files) {
    const j = read(f), was = st.seen[f];
    if (!j) continue; // missing, or caught mid-write: not a removal
    const m = j.mcpServers ?? {};
    for (const [k, v] of Object.entries(m)) if (!was || !same(v, was[k])) set[k] = v; // new there, or changed
    if (was) for (const k of Object.keys(was)) if (!(k in m)) delete set[k];          // removed there
    st.seen[f] = m;
  }
  for (const f of [files[0], path.join(dir, '.claude.json')]) {
    const j = read(f);
    if (!j) continue;
    try {
      if (!same(j.mcpServers ?? {}, set)) { // written only on a change: a Claude running there rewrites this file too
        j.mcpServers = set;
        fs.writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(j, null, 2));
        fs.renameSync(`${f}.${process.pid}.tmp`, f);
      }
      st.seen[f] = set;
    } catch { fs.rmSync(`${f}.${process.pid}.tmp`, { force: true }); } // held open: the next start tries again
  }
  try { fs.writeFileSync(stateFile, JSON.stringify(st, null, 2)); } catch {}
}

// Each config keeps its own trusted folders (.claude.json projects[folder].hasTrustDialogAccepted), so a conversation
// continued on another account stopped at "Do you trust this folder?". Its Yes/No has no numbers, so the web page
// didn't show it as a choice, and a message typed there answered it with its default: No, exit. Trusted in one config
// is trusted in all: the config about to start gets every folder another one trusts.
function shareTrust(dir, files = [path.join(HOME, '.claude.json'), ...load().profiles.map((p) => path.join(p.configDir, '.claude.json'))]) {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const trusted = new Set(files.flatMap((f) => Object.entries(read(f)?.projects ?? {}).filter(([, v]) => v?.hasTrustDialogAccepted).map(([k]) => k)));
  const f = path.join(dir, '.claude.json'), j = read(f);
  const add = j ? [...trusted].filter((k) => !j.projects?.[k]?.hasTrustDialogAccepted) : [];
  if (!add.length) return; // written only on a change: a Claude running there rewrites this file too
  j.projects ??= {};
  for (const k of add) j.projects[k] = { ...j.projects[k], hasTrustDialogAccepted: true };
  try { fs.writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(j, null, 2)); fs.renameSync(`${f}.${process.pid}.tmp`, f); }
  catch { fs.rmSync(`${f}.${process.pid}.tmp`, { force: true }); } // held open: the next start tries again
}

// What a running Claude hands everything it starts (its Bash tool, its hooks, so the island and the
// terminals the island opens). A Claude inheriting them takes itself for that one's sub-session: it
// stops saving its transcript and reports to the parent. claude-multi only starts top-level sessions.
// NO_COLOR too: set for its tools' plain output, it turned every Claude the island opened black and white.
const SESSION_ENV = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'NO_COLOR'];

function childEnv(dir) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  for (const k of SESSION_ENV) delete env[k];
  // our plugin (plugin\): the cache's countdown and the accounts above the prompt, a turn's cost on its closing line
  const plug = path.join(ROOT, 'plugin');
  if (!(env.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(path.delimiter).includes(plug)) env.CLAUDE_CODE_PLUGIN_DIRS = [env.CLAUDE_CODE_PLUGIN_DIRS, plug].filter(Boolean).join(path.delimiter);
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
  try { // the island reads the accounts again at once (its ＋ 添加账号 opened this)
    fs.mkdirSync(INBOX, { recursive: true });
    const f = path.join(INBOX, `${Date.now()}-${process.pid}`); // whole or not at all: the island reads the inbox every 300 ms
    fs.writeFileSync(`${f}.tmp`, JSON.stringify({ kind: 'accounts' })); fs.renameSync(`${f}.tmp`, `${f}.json`);
  } catch {}
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
  shareMemory([[p.configDir, projectFolder(process.cwd())]]);
  shareMcp(p.configDir); shareTrust(p.configDir);
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
  const sw = takeSwitch(r.pid); // ended by `claude-multi swap`: this tab goes on with the account picked
  // the terminal reset first: the Claude ended mid-draw can leave a control sequence half written (a title, say),
  // which swallowed the new one's output and left its screen drawn wrong. ESC \ ends one, ESC c resets the rest.
  if (sw) { process.stdout.write('\x1b\\\x1bc'); console.log(`换到账号 ${sw.n}，接着这段对话……\n`); return resume(sw.id, sw.n); }
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
  // temp: a failure that passes by itself (the network, rate limit, the server), see keepLast; a dropped
  // connection is tried once more first
  for (let k = 0; ; k++) {
    try {
      const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${c.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(10000) });
      if (r.status === 429) return { err: '用量接口限流，稍后再试', temp: true };
      if (!r.ok) return { err: `用量接口返回 HTTP ${r.status}`, temp: r.status >= 500 };
      return { u: await r.json() };
    } catch (e) {
      if (k) return { err: `网络错误：${e.message}`, temp: true };
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  }
}

// A read that failed for a while (temp) gives the account's last good one, up to 30 min old, so a blip doesn't
// blank the island and the page: windows reset since then count as fresh. cache: {profile id: {at, u}}, updated.
const USAGE_CACHE = path.join(ROOT, 'usage-cache.json');
function keepLast(profiles, res, cache, now = Date.now()) {
  return res.map((r, i) => {
    const id = profiles[i].id, old = cache[id];
    if (r.u) { cache[id] = { at: now, u: r.u }; return r; }
    if (!r.temp || !old || now - old.at > 1800000) return r;
    return { u: Object.fromEntries(Object.entries(old.u).map(([k, w]) =>
      [k, w?.resets_at && Date.parse(w.resets_at) < now ? { ...w, utilization: 0, resets_at: null } : w])) };
  });
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
      try { t = fs.statSync(path.join(dir, projectFolder(k))).mtimeMs; } catch {}
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

// When Claude's last model request began, in a transcript slice: right after its last user line (your message, or a
// tool's result: each is written, then the request goes). The prompt cache lives an hour from there.
const lastReq = (s) => {
  const ls = s.split('\n');
  for (let i = ls.length - 1; i >= 0; i--) {
    if (!ls[i].includes('"type":"user"') || ls[i].includes('"isSidechain":true')) continue;
    const t = Date.parse(field(ls[i], 'timestamp'));
    if (t) return t;
  }
  return null;
};

// Start times (Windows FILETIME, as sessions/<pid>.json's procStart) of these pids; null if PowerShell failed.
// The same pids within a minute: the last answer (PowerShell takes ~0.2 s, and the web service asks every few seconds).
let startsSeen = { key: '', at: 0, map: null };
function procStarts(pids) {
  if (!pids.length) return new Map();
  const key = [...pids].sort().join(',');
  if (startsSeen.key === key && Date.now() - startsSeen.at < 60000) return startsSeen.map;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | `
    + '% { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  startsSeen = { key, at: Date.now(), map: new Map(r.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(' '))) };
  return startsSeen.map;
}

const readHeads = new Map(); // record file -> { at: its mtime, cwd, title, prompt }
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
  for (const j of alive) if (!starts || !j.procStart || starts.get(String(j.pid)) === String(j.procStart)) live.set(j.sessionId, j);
  let webPids = new Set(); // the Claudes the web service runs (web-terms.json, written by it)
  try { webPids = new Set(JSON.parse(fs.readFileSync(WEB_TERMS, 'utf8'))); } catch {}
  const tmp = os.tmpdir().toLowerCase(), out = [];
  for (const s of found.values()) {
    let r = readHeads.get(s.file); // a record unchanged since the last look isn't read again (the web service asks every few seconds)
    if (r?.at !== s.at) {
      const fd = fs.openSync(s.file, 'r'), size = fs.fstatSync(fd).size;
      const head = slice(fd, 0, 65536), tail = slice(fd, Math.max(0, size - 524288), 524288);
      fs.closeSync(fd);
      // the last thing you said, not a teammate's or a background task's message delivered as a prompt
      const prompt = [...tail.matchAll(/"lastPrompt":"((?:[^"\\]|\\.)*)"/g)]
        .map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return ''; } })
        .filter((p) => p && !/^(Another Claude session sent a message|<task-notification>)/.test(p)).pop() ?? null;
      let named = null; // /rename's sidecar: holds the name even once its transcript line is out of the tail
      try { named = JSON.parse(fs.readFileSync(path.join(s.file.slice(0, -6), 'custom-title.json'), 'utf8')).customTitle; } catch {}
      r = { at: s.at, cwd: field(head, 'cwd') ?? field(tail, 'cwd', true), prompt, req: lastReq(tail),
        title: named || field(tail, 'customTitle', true) || field(tail, 'aiTitle', true) || field(head, 'aiTitle') || prompt };
      readHeads.set(s.file, r);
    }
    const { cwd, title, prompt, req } = r;
    if (!cwd || !title || cwd.toLowerCase().startsWith(tmp) || !fs.existsSync(cwd)) continue; // nothing to go back to
    const pid = live.get(s.id)?.pid ?? null, st = live.get(s.id)?.status;
    // busy: answering or running a command (its session file's status), for 换账号继续's 答完再换
    out.push({ ...s, cwd, title, prompt: prompt === title ? null : prompt, pid, req, web: !!pid && webPids.has(pid), busy: st === 'busy' || st === 'shell',
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

// --- 换账号继续: a running conversation goes on with the account you pick (the island, the page, `swap`) ------
// Its Claude is ended, once its answer is over unless you say now (or it only waits out a usage limit), and its own
// tab goes on with the other account: start() finds the request (switch\<pid>.json) when its Claude exits. A Claude
// running in no tab of ours leaves the request lying: a new tab opens the conversation instead.
const SWITCH = path.join(ROOT, 'switch');
function takeSwitch(pid) {
  const f = path.join(SWITCH, `${pid}.json`);
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); fs.rmSync(f, { force: true }); return j; } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
// At a usage limit, by the last quota read: a Claude there only waits for the reset, ending it cuts nothing.
function atLimit(p, now = Date.now()) {
  let u = null;
  try { u = JSON.parse(fs.readFileSync(USAGE_CACHE, 'utf8'))[p.id]?.u; } catch {}
  return WINDOWS.some(([k]) => u?.[k]?.utilization >= 100 && Date.parse(u[k].resets_at) > now);
}
// Until the Claude with this pid (of config dir) may be ended: at once with now; else once its session file says it
// isn't at work (busy, shell: answering, running a command; waiting on you or idle are fine).
// ponytail: an answer still going after 2 h is ended anyway
async function untilFree(dir, pid, now) {
  for (const end = Date.now() + 7200000; !now && Date.now() < end && alive(pid); await sleep(1000)) {
    let st = null;
    try { st = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${pid}.json`), 'utf8')).status; } catch {}
    if (st !== 'busy' && st !== 'shell') return;
  }
}
// Conversation s, running in a window here, to go on with account n; nothing is sent, it waits for you there.
// 'tab' or 'new': where it went on.
async function switchWindow(s, n, now) {
  const reg = load(), own = reg.profiles[s.acct];
  await untilFree(own.configDir, s.pid, now || atLimit(own));
  fs.mkdirSync(SWITCH, { recursive: true });
  const f = path.join(SWITCH, `${s.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ id: s.id, n: Number(n) }));
  try { process.kill(s.pid); } catch {}
  for (let k = 0; k < 50 && fs.existsSync(f); k++) await sleep(100); // its tab picks the request up
  if (!fs.existsSync(f)) return 'tab';
  fs.rmSync(f, { force: true });
  require('child_process').spawn('wt.exe', ['-d', s.cwd, process.execPath, __filename, 'resume', s.id, String(n)],
    { detached: true, stdio: 'ignore' }).unref();
  return 'new';
}
// swap ID N [--now]: what the island runs for a running conversation; one running in the web service is the
// service's to switch.
async function switchChat(id, n, now) {
  const reg = load(), s = listSessions(reg).find((x) => x.id === id);
  if (!s || !reg.profiles[n - 1]) return console.log(s ? '没有这个账号。' : `找不到对话 ${id}。`);
  if (!s.pid) return console.log(`这个对话没在运行，用 claude-multi resume ${id} ${n} 打开即可。`);
  if (s.web) {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/switch`, { method: 'POST', body: JSON.stringify({ id, acct: Number(n), now }),
      headers: { cookie: `cm=${webKey()}`, 'content-type': 'application/json', 'accept-encoding': 'identity' } });
    const j = await r.json().catch(() => ({}));
    return console.log(r.ok ? `网页上的这个对话会换到账号 ${n} 接着` : `没换成：${j.err ?? r.status}`);
  }
  const where = await switchWindow(s, n, now);
  console.log(where === 'tab' ? `已换到账号 ${n}，在原来的窗口里接着` : `已换到账号 ${n}，在新窗口里接着`);
}
// attach ID: this terminal joins a conversation running in the web service (one started or continued from
// the web page): the same screen on both sides, either one types. The size follows the side you type on;
// the other side scales to it. Closing this tab leaves the conversation running there.
async function attach(id) {
  const base = `http://127.0.0.1:${WEB_PORT}`;
  // on this computer: unpacked (the service gzips for the phone)
  const headers = { cookie: `cm=${webKey()}`, 'content-type': 'application/json', 'accept-encoding': 'identity' };
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
  const r = recycle(paths);
  if (r.status !== 0 || paths.some((f) => fs.existsSync(f))) { console.log(`删除失败：${(r.stderr || '').trim().split('\n')[0]}`); process.exit(1); }
  log('session_deleted', { session_id: id, files: paths.length });
  console.log(`已删除「${s.title}」，可以在回收站里找回。`);
}
const recycle = (paths) => spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName Microsoft.VisualBasic; '
  + 'foreach ($p in ($env:CM_DEL | ConvertFrom-Json)) { if (Test-Path -PathType Container $p) '
  + '{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, "OnlyErrorDialogs", "SendToRecycleBin") } '
  + 'else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, "OnlyErrorDialogs", "SendToRecycleBin") } }'],
{ env: { ...process.env, CM_DEL: JSON.stringify(paths) }, windowsHide: true, encoding: 'utf8' });
// Every link (symlink, junction) under d removed, never what it points to: an account's settings, skills, plugins and
// notes are links to ~/.claude's, which a folder deleted for good (one too big for the Recycle Bin) mustn't reach through.
function unlinkAll(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isSymbolicLink()) fs.unlinkSync(f); else if (e.isDirectory()) unlinkAll(f);
  }
}

// remove N: account N leaves the list (not while a conversation runs on it) and its folder goes to the Recycle Bin, its
// conversations with it. Its notes are merged into the shared copy first, and its tokens stay counted: the registry
// keeps it under removed for that alone.
// By its id too (the island's way): a number names whichever account is there now, and the island's list can be older.
function remove(x) {
  const reg = load(), i = /^\d+$/.test(x ?? '') ? Number(x) - 1 : reg.profiles.findIndex((q) => q.id === x), p = reg.profiles[i];
  if (!p) { console.log('用法：claude-multi remove <账号编号或 id，如 acct-20261010-002>'); process.exit(1); }
  if (listSessions(reg).some((s) => s.acct === i && s.pid)) { console.log('这个账号上有对话正在运行，先关掉再移除。'); process.exit(1); }
  tokenStats(); shareMemory(); // while it's still listed
  update((r) => {
    r.profiles = r.profiles.filter((q) => q.id !== p.id);
    (r.removed ??= []).push({ id: p.id, label: p.label, configDir: p.configDir });
    if (r.active === p.id) r.active = r.profiles[0]?.id ?? null;
  });
  log('profile_removed', { profile_id: p.id });
  try { unlinkAll(p.configDir); } catch {}
  const r = recycle([p.configDir]);
  if (fs.existsSync(p.configDir)) console.log(`已移除账号 ${p.label}，但文件夹没能放进回收站（${(r.stderr || '').trim().split('\n')[0] || '可能有程序开着里面的文件'}），可以之后手动删：${p.configDir}`);
  else console.log(`已移除账号 ${p.label}，文件夹在回收站里。`);
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
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(USAGE_CACHE, 'utf8')); } catch {}
  const [got, states] = await Promise.all([Promise.all(reg.profiles.map(fetchUsage)), Promise.all(reg.profiles.map((p) => subState(p, cache)))]);
  const res = keepLast(reg.profiles, got, cache);
  // counted only with an account at its limit (the island's notice is all that needs it): listing costs a PowerShell
  const running = res.some((r) => WINDOWS.some(([k]) => Math.round(r.u?.[k]?.utilization) >= 100)) ? listSessions(reg).filter((s) => s.pid) : [];
  // whole or not at all: the island and the web service both write it, and a half-written one read would lose them all
  try { fs.writeFileSync(`${USAGE_CACHE}.${process.pid}`, JSON.stringify(cache)); fs.renameSync(`${USAGE_CACHE}.${process.pid}`, USAGE_CACHE); } catch {}
  const ok = res.map((r, i) => ({ ...r, i })).filter((r) => r.u);
  const open = ok.filter((r) => runway(r.u) > 0);
  const rec = open.length ? pickOpen(open) : [...ok].sort((a, b) => readyAt(a.u) - readyAt(b.u))[0];
  // One column per window. Model windows get a column only once some account used them.
  const cols = WINDOWS.filter(([k]) => !k.startsWith('seven_day_') || ok.some((r) => r.u[k]?.utilization));
  const json = { rec: rec?.i ?? null, open: open.length > 0,
    ready: !open.length && rec ? until(readyAt(rec.u)) : null,
    accounts: reg.profiles.map((p, i) => ({ label: p.label, dir: p.configDir, err: res[i].err ?? null,
      runway: res[i].u ? Math.round(runway(res[i].u) * 10) / 10 : null,
      windows: cols.filter(([k]) => res[i].u?.[k]).map(([k]) => ({ k, pct: Math.round(res[i].u[k].utilization),
        reset: res[i].u[k].resets_at ? until(res[i].u[k].resets_at) : '' })), sub: subscription(p, states[i]),
      running: running.filter((s) => s.acct === i).length })), // conversations running on it: the island's notice at its limit
    projects: recentProjects(reg) };
  return { res, ok, open, rec, cols, json };
}

// The subscription as Claude Code keeps it from the account's profile (.claude.json oauthAccount): since when, how it's
// paid (apple_subscription: through the App Store, stripe_subscription: a card on claude.ai, google_play_subscription),
// and the next renewal, guessed: monthly, on the day it began; canceled (from subState): the day it ends instead.
// ponytail: an annual plan would be guessed wrong; the profile doesn't say which, the store (or claude.ai) does
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// The subscription's start doesn't move when the store's billing day does (a resubscription, a late payment): account 1
// began on the 7th and the App Store bills it on the 28th. A day you set (renewOn, `claude-multi renew`) wins.
function subscription(p, status = null) {
  let o = null;
  try { o = JSON.parse(fs.readFileSync(path.join(p.configDir, '.claude.json'), 'utf8')).oauthAccount; } catch {}
  const since = new Date(o?.subscriptionCreatedAt ?? NaN);
  if (isNaN(since)) return null; // no subscription (and nextRenewal would never find an anniversary of no date)
  const renew = p.renewOn ? nextRenewal(new Date(`${p.renewOn}T00:00:00`), new Date(), true) : nextRenewal(since);
  return { since: ymd(since), renew: ymd(renew), billing: o.billingType ?? null, canceled: status === 'canceled' };
}
// Whether the subscription still renews: Claude Code's copy of the profile leaves that out, Anthropic's profile has it
// (subscription_status, 'canceled' once renewal is turned off). Read every 6 h, kept in the quota cache.
async function subState(p, cache, now = Date.now()) {
  const k = `${p.id}:sub`;
  if (now - (cache[k]?.at ?? 0) < 21600000) return cache[k].status;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(p.configDir, '.credentials.json'), 'utf8')).claudeAiOauth;
    const r = await fetch('https://api.anthropic.com/api/oauth/profile', {
      headers: { Authorization: `Bearer ${c.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10000) });
    if (r.ok) cache[k] = { at: now, status: (await r.json()).organization?.subscription_status ?? null };
  } catch {} // the network or a stale login: the last one known, if any
  return cache[k]?.status ?? null;
}
// The first monthly anniversary of since, today or later (a day the month lacks, like the 31st: its last day). since
// itself counts only when it's a billing day (onIt), not the day the subscription began.
function nextRenewal(since, now = new Date(), onIt = false) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()), first = new Date(since.getFullYear(), since.getMonth(), since.getDate());
  for (let m = now.getMonth(); ; m++) {
    const d = new Date(now.getFullYear(), m, Math.min(since.getDate(), new Date(now.getFullYear(), m + 1, 0).getDate()));
    if (d >= today && (onIt ? d >= first : d > first)) return d;
  }
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
// Listens on 127.0.0.1 only. The way in from outside is an SSH tunnel this service keeps up to the server
// (TUNNEL.ssh, a host in ~/.ssh/config), whose nginx serves TUNNEL.url over HTTPS and passes it all to the tunnel's
// end there. The page runs Claude here, so it opens only with the key (web-key): `claude-multi web-link` prints a
// link with it, and a browser that opened the link keeps it as a cookie. `web-link new` makes a new key: every
// browser that had the old one is out.
const NOTES = path.join(ROOT, 'notes.jsonl');
const WEB_TERMS = path.join(ROOT, 'web-terms.json'); // pids of the Claudes running in the web service
const WEB_USAGE = path.join(ROOT, 'web-usage.json'); // the quota as the page last got it
const WEB_PORT = 7788;
const TUNNEL = { ssh: 'huawei', sock: '/run/claude-multi.sock', url: 'https://your-server:8443' }; // sock: its end on the server
const WEB_KEY = path.join(ROOT, 'web-key');

function webKey(fresh = false) { // made on first use; in the user's own folder, as each account's login is
  if (!fresh) try { const k = fs.readFileSync(WEB_KEY, 'utf8').trim(); if (k.length >= 32) return k; } catch {}
  const k = require('crypto').randomBytes(32).toString('base64url');
  fs.writeFileSync(WEB_KEY, k);
  return k;
}
// true when given (from the link or the cookie) is the key; in constant time
function keyMatch(given, key) {
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(key);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}
const keyCookie = (cookie) => /(?:^|;\s*)cm=([^;]+)/.exec(cookie ?? '')?.[1];
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
// Claude's own bookkeeping (reminders, background-task notices) are left out. Read in pieces, as byte ranges of
// the file that start at a line: no range given, the last 16 MB; {end}, the 16 MB before end (scrolling back);
// {from}, from there to the end (the newest piece, read again as it grows). start comes back for the next ask.
function history(file, { from, end } = {}) {
  const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size;
  let a, b;
  if (from != null) { a = Math.min(+from, size); b = size; }
  else { b = end != null ? Math.min(+end, size) : size; a = Math.max(0, b - 16777216); }
  const buf = Buffer.alloc(b - a);
  fs.readSync(fd, buf, 0, b - a, a);
  fs.closeSync(fd);
  const skip = a === 0 || from != null ? 0 : buf.indexOf(10) + 1; // a piece cut mid-line starts at its next line
  const last = buf.lastIndexOf(10); // a line still being written waits for the next read (from: end)
  const lines = last < skip ? [] : buf.toString('utf8', skip, last + 1).split('\n');
  const out = [];
  const add = (role, text, at) => {
    text = String(text ?? '').trim();
    if (text) out.push({ role, text: text.length > 20000 ? text.slice(0, 20000) + '…' : text, at });
  };
  let next = a + skip; // where each line starts in the file: a picture in it is fetched from there (recordImage)
  for (const l of lines) {
    const pos = next;
    next += Buffer.byteLength(l) + 1;
    if (!l.includes('"type":"user"') && !l.includes('"type":"assistant"') && !l.includes('"queued_command"') && !l.includes('"turn_duration"')) continue;
    if (l.includes('"type":"tool_result"')) continue; // tool output, often huge (screenshots): not shown, not parsed
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (j.isMeta || j.isSidechain) continue;
    const at = Date.parse(j.timestamp) || 0, c = j.message?.content;
    if (j.type === 'attachment') { // what you sent while Claude was at work, where it took it in
      if (j.attachment?.type === 'queued_command' && j.attachment.origin?.kind === 'human') add('user', j.attachment.prompt, at);
    } else if (j.type === 'system') { // Claude's turn over: how long it took, in ms
      if (j.subtype === 'turn_duration' && j.durationMs > 0) add('done', String(j.durationMs), at);
    } else if (j.type === 'user') {
      if (j.isCompactSummary) { add('note', '更早的内容已压缩', at); continue; }
      const parts = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
      // your pictures (pasted, dragged in, sent from the page) above what you wrote: "line.k", the line's place and
      // which picture in it. The text has an [Image #N] for each, the page leaves those out.
      parts.filter((p) => p.type === 'image').forEach((p, k) => add('img', `${pos}.${k}`, at));
      for (const p of parts) {
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
  return { items: out, start: a + skip, end: last < skip ? a + skip : a + last + 1 };
}
// The k-th picture of the record's line at byte pos, as history() names it ("pos.k"): its type and bytes.
function recordImage(file, pos, k) {
  const fd = fs.openSync(file, 'r'), parts = [];
  try { // the line: read on to its end (a picture makes it megabytes long)
    for (let at = pos, nl = -1; nl < 0 && at - pos < 64 << 20;) {
      const b = Buffer.alloc(1 << 20), got = fs.readSync(fd, b, 0, b.length, at);
      if (!got) break;
      nl = b.subarray(0, got).indexOf(10); parts.push(b.subarray(0, nl < 0 ? got : nl)); at += got;
    }
  } finally { fs.closeSync(fd); }
  const p = JSON.parse(Buffer.concat(parts).toString('utf8')).message?.content?.filter?.((x) => x.type === 'image')[k];
  if (!/^image\/(png|jpeg|gif|webp)$/.test(p?.source?.media_type ?? '')) throw new Error('没有这张图片'); // never served as anything else
  return { type: p.source.media_type, data: Buffer.from(p.source.data, 'base64') };
}
// A picture sent from the page, kept for Claude to take in by its path: the page pastes the path, as dragging the file
// into a terminal does, and Claude attaches it ([Image #1]) and copies it into its record. Kept a week.
const UPLOADS = path.join(ROOT, 'uploads');
function saveUpload(data, ext, dir = UPLOADS) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) try { if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 7 * 864e5) fs.unlinkSync(path.join(dir, f)); } catch {}
  const file = path.join(dir, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${require('crypto').randomBytes(3).toString('hex')}.${ext}`);
  fs.writeFileSync(file, data);
  return file;
}

// The start of a window's history: the reader keeps only what scrolls by from where it began (the screen then),
// and the window's own history can't be read. So that it starts at a question of yours, the record fills in
// what came between the question and the first message the lines show (a row starting ❯ or ●, found by its
// first words), drawn the way Claude Code draws a conversation. skip: the lines before that message.
function lead(items, lines, more = false) { // more: the record goes back further than items
  const key = (t) => String(t).split('\n')[0].replace(/[\s*`#>]/g, '').slice(0, 16);
  let cut = -1, skip = 0;
  for (let r = 0; r < lines.length && cut < 0; r++) {
    const m = /^[❯●]\s+(.*)/.exec(lines[r].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')), k = m && key(m[1]);
    if (!k || k.length < 4) continue;
    for (let i = items.length - 1; i >= 0 && cut < 0; i--) if (items[i].role !== 'tool' && items[i].role !== 'img' && key(items[i].text) === k) { cut = i; skip = r; }
  }
  if (cut < 0) { cut = items.length; skip = lines.length; } // not found: from your latest question, no kept lines (the screen stays)
  let start = cut; // the screen starts at a question: nothing before it
  if (items[cut]?.role !== 'user') for (start = cut - 1; start > 0 && items[start].role !== 'user';) start--;
  while (start > 0 && items[start - 1].role === 'img') start--; // the question's pictures with it (they come just before its words)
  if (start < 0 || start >= cut) return { text: '', skip };
  const draw = (it) => {
    if (it.role === 'img') return '\x1b[90m❯ [图片]\x1b[39m'; // its text is where it sits in the record, for the page
    const t = it.text.replace(/\*\*([^*\n]+)\*\*/g, '\x1b[1m$1\x1b[22m').split('\n').join('\r\n  ');
    return it.role === 'user' ? `\x1b[90m❯\x1b[39m ${t}` : it.role === 'claude' ? `● ${t}`
      : it.role === 'tool' ? `\x1b[32m●\x1b[39m \x1b[90m${t}\x1b[39m` : it.role === 'done' ? '\x1b[90m✓ 回复完成\x1b[39m' : `\x1b[90m── ${t} ──\x1b[39m`;
  };
  const part = items.slice(start, cut); // a blank line between messages, tool calls in a row packed together
  const body = part.map((it, i) => (i && (it.role !== 'tool' || part[i - 1].role !== 'tool') ? '\r\n' : '') + draw(it)).join('\r\n');
  const text = [start > 0 || more ? '\x1b[90m── 更早的在「记录」里 ──\x1b[39m' : '', body, '\x1b[90m── 以上是对话记录，下面是电脑窗口里的画面 ──\x1b[39m'];
  return { text: text.filter(Boolean).join('\r\n\r\n'), skip };
}

async function web() {
  const http = require('http'), pty = require('@lydell/node-pty');
  const claudeExe = spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/)[0].trim() || CLAUDE;
  const terms = new Map(); // key -> { kind: 'pty' | 'pc', sid, pid, proc, clients: Set, buf, w, h, gone }
  // the quota as the page last got it, kept on disk: after a restart the page shows it at once (read again behind it)
  let usageCache = (() => { try { return JSON.parse(fs.readFileSync(WEB_USAGE, 'utf8')); } catch { return null; } })();
  let usageAt = 0, usageNow = null, sessCache = null, sessAt = 0;

  const send = (t, ev, data) => { for (const res of t.clients) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
  const sessions = () => {
    if (!sessCache || Date.now() - sessAt > 3000) { sessCache = listSessions(load()); sessAt = Date.now(); }
    return sessCache;
  };
  // a conversation started or continued here: claude in a pseudo-terminal, its output kept (last 256 KB) for
  // whoever opens it later
  function startPty(p, cwd, args, cols = 100, rows = 30) {
    const key = `p${Date.now().toString(36)}`;
    shareMemory([[p.configDir, projectFolder(cwd)]]);
    shareMcp(p.configDir); shareTrust(p.configDir);
    const proc = pty.spawn(claudeExe, args, { name: 'xterm-256color', cols, rows, cwd, env: childEnv(p.configDir) });
    // pid read live: node-pty only knows it once the pseudo-terminal is ready (it is 0 right after spawn)
    const t = { kind: 'pty', key, get pid() { return proc.pid; }, proc, clients: new Set(), buf: '', w: cols, h: rows, cwd, dir: p.configDir };
    proc.onData((d) => {
      if (!t.listed && proc.pid) { t.listed = true; saveTerms(); }
      t.buf = (t.buf + d).slice(-262144); send(t, 'data', d);
    });
    // ended to go on with another account (switching): its pages are sent to the new one instead of told it's gone
    proc.onExit(() => { t.gone = true; saveTerms(); if (!t.switching) send(t, 'gone', {}); setTimeout(() => terms.delete(key), 60000); });
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
    const t = { kind: 'pc', key, pid, proc, clients: new Set(), frame: null, w: 0, h: 0, hist: [], waiting: [] }; // hist: lines scrolled off, colored
    let line = '';
    proc.stdout.on('data', (d) => {
      line += d;
      for (let k; (k = line.indexOf('\n')) >= 0; line = line.slice(k + 1)) {
        let m; try { m = JSON.parse(line.slice(0, k)); } catch { continue; }
        if (m.gone) { t.gone = true; send(t, 'gone', {}); t.waiting.splice(0).forEach((f) => f()); continue; }
        // lines scrolled off the window's top: kept here (the last 5000, for whoever opens it later or comes
        // back), and an open page scrolls its screen as far, so they go to its history
        if (m.s) {
          if (t.frame) t.hist.push(...t.frame.replace(/^\x1b\[H/, '').split('\r\n').slice(0, m.s));
          if (t.hist.length > 5000) t.hist.splice(0, t.hist.length - 5000);
          if (t.h) send(t, 'data', `\x1b[${t.h};1H` + '\n'.repeat(m.s));
          continue;
        }
        if (m.w !== t.w || m.h !== t.h) { t.w = m.w; t.h = m.h; send(t, 'size', { w: m.w, h: m.h }); }
        // Claude drawing the whole screen anew (the conversation compacted, the window resized): nothing scrolled,
        // so the kept lines have a hole. They're dropped, the record has it all; once it settles, open pages
        // get everything again (ESC c clears theirs first).
        if (t.frame) {
          const plain = (x) => x.replace(/^\x1b\[H/, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\r\n'), now = new Set(plain(m.f));
          if (plain(t.frame).slice(0, -8).filter((r) => r.trim() && !now.has(r)).length > Math.max(10, m.h / 3)) {
            t.hist = [];
            clearTimeout(t.redo); t.redo = setTimeout(() => send(t, 'data', '\x1bc' + replay(t)), 2000);
          }
        }
        t.frame = m.f; send(t, 'data', m.f);
        t.waiting.splice(0).forEach((f) => f()); // pages that opened before the first frame
      }
    });
    proc.on('exit', () => { t.gone = true; send(t, 'gone', {}); t.waiting.splice(0).forEach((f) => f()); terms.delete(key); });
    setTimeout(() => { if (!t.clients.size) proc.kill(); }, 30000); // opened but nobody came to watch: not left running
    terms.set(key, t);
    return t;
  }
  const where = (s) => [...terms.values()].find((t) => !t.gone && t.pid === s.pid); // ours, or a window here
  // what a page gets first: our terminal's output; for a window here, the record before what its reader kept,
  // the kept lines, then pushed off the screen (a newline per row) so the frame doesn't cover them, and the frame
  function replay(t) {
    if (t.kind === 'pty') return t.buf;
    let l = { text: '', skip: 0 };
    const rows = (t.frame ?? '').replace(/^\x1b\[H/, '').split('\r\n');
    try { if (t.file && t.w) { const h = history(t.file); l = lead(h.items, [...t.hist, ...rows], h.start > 0); } } catch {}
    const above = (l.text ? [l.text] : []).concat(t.hist.slice(l.skip)).join('\r\n');
    return (above ? above + '\r\n'.repeat(t.h) : '') + (t.frame ?? '');
  }
  // for the island and `claude-multi attach`: which running conversations are ours
  function saveTerms() {
    try { fs.writeFileSync(WEB_TERMS, JSON.stringify([...terms.values()].filter((t) => t.kind === 'pty' && !t.gone && t.pid).map((t) => t.pid))); } catch {}
  }

  // the record of the conversation asked for (?key, ?id): by the open terminal's key, else by its id
  function recordOf(q) {
    const t = terms.get(q.get('key') ?? '');
    if (t?.dir && !t.file && t.pid) try {
      const id = JSON.parse(fs.readFileSync(path.join(t.dir, 'sessions', `${t.pid}.json`), 'utf8')).sessionId;
      for (const d of fs.readdirSync(path.join(t.dir, 'projects'))) if (fs.existsSync(path.join(t.dir, 'projects', d, `${id}.jsonl`))) t.file = path.join(t.dir, 'projects', d, `${id}.jsonl`);
    } catch {}
    return { t, file: t?.file ?? sessions().find((x) => x.id === q.get('id'))?.file };
  }

  const api = {
    // the quota as last read, at once: reading it again (each account's, over the network) takes a second or
    // more, so one over a minute old is read again in the background, for the next look. That read goes abroad
    // through this computer's proxy, and hung the page for up to 20 s while its node was bad: 刷新 (?fresh) waits
    // 3 s at most, then shows the last numbers; the page's next look (10 s) has the new ones.
    'GET /api/state': async (q) => {
      if (!usageCache || q.has('fresh') || Date.now() - usageAt > 60000) usageNow ??= usageState().then((r) => {
        usageCache = r.json; usageAt = Date.now();
        fs.writeFile(WEB_USAGE, JSON.stringify(r.json), () => {});
      }, () => {}).finally(() => { usageNow = null; });
      if (!usageCache) await usageNow; // nothing read ever: nothing to show before it
      if (!usageCache) throw new Error('额度读取失败，稍后再试'); // the page can't draw without it
      else if (q.has('fresh')) await Promise.race([usageNow, sleep(3000)]);
      // a running one with what its terminal's status line shows (model, effort, context used), for the page's status bar
      const all = sessions(), list = all.map(({ file, ...s }) => ({ ...s, where: !s.pid ? null : where(s)?.kind === 'pty' ? 'web' : 'pc', line: s.pid ? readLine(s.id) : null }));
      return { usage: usageCache, sessions: list, notes: unreadNotes(all), me: os.hostname() };
    },
    'GET /api/tokens': () => tokenStats(),
    // asked every second while shown, mostly from where the last answer ended. By the open terminal's key: one
    // started here has a record once Claude wrote the first message (its session file, named by its pid, says
    // which conversation it is), until then none.
    'GET /api/history': (q) => {
      const { t, file } = recordOf(q);
      if (!file) { if (t) return { items: [], start: 0, end: 0 }; throw new Error('找不到这个对话'); }
      return { ...history(file, { from: q.get('from') || undefined, end: q.get('end') || undefined }), id: path.basename(file, '.jsonl') };
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
        (e, stdout) => { usageAt = 0; ok({ out: String(stdout || e?.message || '').trim() }); }); // read again on the page's next look
    }),
    // open a conversation's terminal: {id, acct?} continues one (its window here if it runs in one),
    // {dir, acct} starts one. acct is 1-based; the page proposes it like the island does.
    'POST /api/open': (q, b) => {
      const reg = load(), cols = Math.max(40, Math.min(300, b.cols | 0 || 100)), rows = Math.max(10, Math.min(200, b.rows | 0 || 30));
      if (b.id) {
        sessCache = null;
        const s = sessions().find((x) => x.id === b.id);
        if (!s) throw new Error('找不到这个对话');
        if (s.pid) { const t = where(s) ?? mirror(s.pid); t.file = s.file; return { key: t.key, kind: t.kind }; }
        if (b.live) throw new Error('这个对话已经不在运行了'); // the page reconnecting: an ended one isn't started anew
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
    // 换账号继续 {id, acct, now}: the conversation goes on with account acct (nothing sent: it waits for you).
    // Not running: started here like a continued one. Running here: ended once its answer is over (now: at once; at a
    // usage limit: at once), started again on acct, and its pages moved to it (event switched). In a window: switchWindow.
    // Answers at once; the switch itself happens when it can.
    'POST /api/switch': (q, b) => {
      sessCache = null;
      const reg = load(), s = sessions().find((x) => x.id === b.id), p = reg.profiles[b.acct - 1];
      if (!s) throw new Error('找不到这个对话');
      if (!p) throw new Error('没有这个账号');
      const args = ['--resume', s.id];
      if (!s.pid) { copyTo(s, p); return { key: startPty(p, s.cwd, args, b.cols | 0 || 100, b.rows | 0 || 30).key, kind: 'pty' }; }
      const t = where(s);
      if (t?.kind !== 'pty') { switchWindow(s, b.acct, !!b.now).catch(() => {}); return { window: true }; }
      (async () => {
        await untilFree(t.dir, t.pid, b.now || atLimit(reg.profiles[s.acct]));
        if (t.gone || t.switching) return; // a second request (the island and the page both): one new Claude, not two
        t.switching = true;
        t.proc.kill();
        while (!t.gone) await sleep(100); // it has stopped writing its record: the copy is whole
        copyTo(s, p);
        send(t, 'switched', { key: startPty(p, s.cwd, args, t.w, t.h).key });
      })().catch(() => {});
      return { pty: true };
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

  const zlib = require('zlib');
  const server = http.createServer(async (req, res) => {
    // gzipped when the browser takes it: a phone on mobile data comes through a relay abroad, slow, and the
    // terminal's output packs to a fiftieth (a window's kept lines: ~330 KB, ~7 KB)
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    const reply = (code, head, body) => {
      const zip = gz && body.length > 1024;
      res.writeHead(code, zip ? { ...head, 'content-encoding': 'gzip', vary: 'accept-encoding' } : head);
      res.end(zip ? zlib.gzipSync(body) : body);
    };
    const out = (code, body, type = 'application/json; charset=utf-8') =>
      reply(code, { 'content-type': type, 'cache-control': 'no-store' }, Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    try {
      const url = new URL(req.url, 'http://x'), text = 'text/plain; charset=utf-8';
      // the island's logo, to anyone: a phone adding the page to its home screen fetches it without the cookie
      const icon = { '/favicon.ico': ['island.ico', 'image/x-icon'], '/icon-180.png': ['icon-180.png', 'image/png'] }[url.pathname];
      if (req.method === 'GET' && icon) { res.writeHead(200, { 'content-type': icon[1], 'cache-control': 'max-age=86400' }); return res.end(fs.readFileSync(path.join(ROOT, icon[0]))); }
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('key')) { // the link: kept as a cookie, a year
        if (!keyMatch(url.searchParams.get('key'), webKey())) return out(403, '这个链接的钥匙不对，或者已经换了新的。在电脑上运行 claude-multi web-link 拿新链接。', text);
        res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'set-cookie': `cm=${webKey()}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` });
        return res.end();
      }
      if (!keyMatch(keyCookie(req.headers.cookie), webKey())) return out(403, '要用链接打开：在电脑上运行 claude-multi web-link。', text);
      if (req.method === 'GET' && url.pathname === '/') return out(200, fs.readFileSync(path.join(ROOT, 'web.html'), 'utf8'), 'text/html; charset=utf-8');
      // the terminal's files, from our node_modules: from the CDN abroad they took 7-8 s, and the page waits for
      // them. Kept a year: the page asks with the version, ?6.0.0, so a new one is a new address.
      const lib = /^\/lib\/(@xterm\/[\w-]+\/(?:lib|css)\/[\w.-]+\.(js|css))$/.exec(url.pathname);
      if (req.method === 'GET' && lib) {
        const type = lib[2] === 'css' ? 'text/css' : 'text/javascript';
        return reply(200, { 'content-type': type, 'cache-control': 'max-age=31536000, immutable' }, fs.readFileSync(path.join(ROOT, 'node_modules', lib[1])));
      }
      if (req.method === 'GET' && url.pathname === '/api/term') { // the terminal's output, as server-sent events
        const t = terms.get(url.searchParams.get('key'));
        if (!t) return out(404, { err: '这个终端已经结束' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', ...(gz && { 'content-encoding': 'gzip' }) });
        const z = gz ? zlib.createGzip() : null; // gzipped too, each event sent on at once
        if (z) { z.on('error', () => {}); z.pipe(res); } // a page gone mid-write: dropped, never the service down
        const sse = z ? { write: (s) => { z.write(s); z.flush(zlib.constants.Z_SYNC_FLUSH); } } : res;
        let closed = false;
        const begin = () => { // a window's reader: once it has the first frame, the record before it is found from it
          if (closed) return;
          sse.write(`event: size\ndata: ${JSON.stringify({ w: t.w, h: t.h, kind: t.kind })}\n\n`);
          const past = replay(t);
          if (past) sse.write(`event: data\ndata: ${JSON.stringify(past)}\n\n`);
          if (t.gone) sse.write('event: gone\ndata: {}\n\n');
          t.clients.add(sse);
        };
        if (t.kind === 'pc' && !t.frame && !t.gone) t.waiting.push(begin); else begin();
        const beat = setInterval(() => sse.write('event: ping\ndata: {}\n\n'), 15000); // a named event: the page sees it and knows the stream lives
        req.on('close', () => {
          closed = true; clearInterval(beat); t.clients.delete(sse); z?.destroy();
          // nobody watching: the reader stays 20 min, still keeping what scrolls by, for when you come back
          if (t.kind === 'pc') setTimeout(() => { if (!t.clients.size) t.proc.kill(); }, 1200000);
        });
        return;
      }
      // a picture in a conversation's record (?ref "line.k" from the history), for the page's 对话 view
      if (req.method === 'GET' && url.pathname === '/api/image') {
        const ref = /^(\d+)\.(\d+)$/.exec(url.searchParams.get('ref') ?? ''), { file } = recordOf(url.searchParams);
        if (!ref || !file) return out(404, { err: '没有这张图片' });
        const img = recordImage(file, +ref[1], +ref[2]);
        res.writeHead(200, { 'content-type': img.type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
        return res.end(img.data);
      }
      // only from our own page: from the same origin, as JSON or a picture's own type (another site's page can't send
      // either cross-origin without asking first, and nothing here answers that)
      if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return out(403, { err: '来源不对' });
      if (req.method === 'POST' && url.pathname === '/api/upload') { // a picture's bytes: saved, its path back for the page to paste
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[req.headers['content-type']];
        if (!ext) return out(415, { err: '只能发 png、jpg、gif、webp 图片' });
        const parts = []; let size = 0;
        for await (const ch of req) { if ((size += ch.length) > 20 << 20) return out(413, { err: '图片太大了（最大 20 MB）' }); parts.push(ch); }
        return out(200, { path: saveUpload(Buffer.concat(parts), ext) });
      }
      const fn = api[`${req.method} ${url.pathname}`];
      if (!fn) return out(404, { err: '没有这个地址' });
      let body = {};
      if (req.method === 'POST') {
        if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return out(415, { err: '只收 JSON' });
        let raw = ''; for await (const ch of req) { raw += ch; if (raw.length > 1 << 20) return out(413, { err: '太大' }); }
        body = JSON.parse(raw || '{}');
      }
      out(200, await fn(url.searchParams, body));
    } catch (e) { out(500, { err: e.message }); }
  });
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') process.exit(0); throw e; }); // already running
  server.listen(WEB_PORT, '127.0.0.1', () => { saveTerms(); tunnel(); console.log(`网页：${TUNNEL.url}/  （第一次用 claude-multi web-link 给的链接打开）`); });
  // the way in from outside, kept up: dialed again 5 s after a drop, waiting longer (up to a minute) while each try
  // fails at once (the server or the network down). A connection the network swallowed (a proxy's TUN switched on or
  // off moves it to another interface) is found dead within 15 s, by either side. On the server its end is a socket
  // file, not a port: the next tunnel replaces it at once (StreamLocalBindUnlink), where a port stayed taken until the
  // server gave up on the dead one, and every try in between failed.
  let tun = null, wait = 5000;
  process.on('exit', () => tun?.kill());
  function tunnel() {
    const at = Date.now();
    tun = require('child_process').spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=5',
      '-o', 'ServerAliveCountMax=3', '-R', `${TUNNEL.sock}:127.0.0.1:${WEB_PORT}`, TUNNEL.ssh], { windowsHide: true, stdio: 'ignore' });
    let again = () => { again = () => {}; wait = Date.now() - at > 30000 ? 5000 : Math.min(wait * 2, 60000); setTimeout(tunnel, wait); };
    tun.on('exit', () => again()); tun.on('error', () => again()); // error: no ssh to start (unhandled, it took the service down)
  }
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
  return [...reg.profiles, ...(reg.removed ?? []).map((p) => ({ ...p, label: `${p.label}（已移除）` }))]
    .map((p) => ({ id: p.id, label: p.label, dir: path.join(p.configDir, 'projects') }));
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
function tokenStats(roots = tokenRoots(), cacheFile = path.join(ROOT, 'tokens-cache.json'), logFile = LOG) {
  let cache = { v: 3, files: {} };
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') try { fs.copyFileSync(cacheFile, `${cacheFile}.bad`); } catch {} // unreadable: keep it for a hand rescue
  }
  // replies now carry their time (who made one goes by it): the records read again; deleted ones keep theirs, without
  if (cache.v !== 3) cache = { v: 3, files: Object.fromEntries(Object.entries(cache.files ?? {}).filter(([f]) => !fs.existsSync(f))) };
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
  // Which account ran a conversation when: going on with another account copies its whole record there (logged as
  // session_copied), so a reply is that account's when it came after the copy, before any other.
  const moves = new Map(); // conversation id -> [[ms, profile id]], oldest first
  try {
    for (const l of fs.readFileSync(logFile, 'utf8').split('\n')) {
      if (!l.includes('"session_copied"')) continue;
      const j = JSON.parse(l);
      if (!moves.has(j.session_id)) moves.set(j.session_id, []);
      moves.get(j.session_id).push([Date.parse(j.timestamp), j.profile_id]);
    }
  } catch {}
  const ranBy = (sid, ts) => { let o = null; for (const [t, id] of moves.get(sid) ?? []) if (t <= ts) o = id; return o; };
  // A reply found in several files counts at its largest; on a tie, in the file of the account it was made on, and
  // before any copy (or with no time) in the oldest file: the first account's, a copy being newer.
  const count = (c, ri, sid) => {
    for (const x of c.recs) {
      const b = best.get(x[0]), by = x[9] && ranBy(sid, x[9]), rank = by && roots[ri].id !== by ? 1 : 0, born = c.born ?? Infinity;
      if (!b || sum(x) > sum(b.x) || (sum(x) === sum(b.x) && (rank < b.rank || (rank === b.rank && born < b.born)))) best.set(x[0], { x, ri, born, rank });
    }
  };
  // its conversation, under projects\<folder>\: <id>.jsonl, or a subagent's record in the side folder <id>\
  const sidOf = (ri, f) => path.relative(roots[ri].dir, f).split(path.sep)[1]?.replace(/\.jsonl$/, '');
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
              w - w1, w1, num(u, 'cache_read_input_tokens'), l.match(/"model":"([^"]+)"/)?.[1] ?? '', +/"speed":"fast"/.test(u), Date.parse(ts)];
            const i = at.get(x[0]);
            if (i === undefined) { at.set(x[0], c.recs.length); c.recs.push(x); } else if (sum(x) > sum(c.recs[i])) c.recs[i] = x;
          }
          c.size += end;
        }
        fs.closeSync(fd);
      }
      next[f] = c;
      count(c, ri, sidOf(ri, f));
    }
  });
  // Claude Code deletes records older than 30 days (cleanupPeriodDays): their replies stay counted from here.
  // ponytail: the cache keeps every reply forever (~2 MB per busy fortnight); fold old files into day totals if it gets slow
  for (const [f, c] of Object.entries(cache.files)) {
    const ri = roots.findIndex((r) => f.startsWith(r.dir + path.sep));
    if (next[f] || ri < 0 || fs.existsSync(f)) continue;
    next[f] = c;
    count(c, ri, sidOf(ri, f));
  }
  // whole or not at all: this cache is the only record left of deleted transcripts, so a cut-off write must
  // never replace it (two runs at once: the later rename wins, each file whole)
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 3, files: next }));
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

// What the terminal's status line knows of a conversation, for the web page's status bar: model, effort, context used.
// Claude Code hands it to the status line on each update: kept in status/<session>.json, written when it changes.
const LINES = path.join(ROOT, 'status');
function saveLine(input, dir = LINES) {
  const id = input.session_id;
  if (!/^[\w-]{1,80}$/.test(id ?? '')) return;
  const line = JSON.stringify({ model: input.model?.display_name ?? null, effort: input.effort?.level ?? null, ctx: input.context_window?.used_percentage ?? null });
  const f = path.join(dir, `${id}.json`);
  try { if (fs.readFileSync(f, 'utf8') === line) return; } catch { // a conversation new here: ones untouched for a month go
    fs.mkdirSync(dir, { recursive: true });
    for (const x of fs.readdirSync(dir)) try { if (Date.now() - fs.statSync(path.join(dir, x)).mtimeMs > 30 * 864e5) fs.unlinkSync(path.join(dir, x)); } catch {}
  }
  fs.writeFileSync(`${f}.tmp`, line); fs.renameSync(`${f}.tmp`, f); // whole, for the service reading it meanwhile
}
const readLine = (id, dir = LINES) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')); } catch { return null; } };

module.exports = { pickOpen, keyMatch, keyCookie, shareTrust, childEnv, helpersBusy, statusline, saveLine, readLine, lastReq, tokenStats, tokenRoots, unlinkAll, unreadNotes, history, recordImage, saveUpload, lead, keepLast, shareMemory, shareMcp, nextRenewal, untilFree, takeSwitch };
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
  else if (cmd === 'swap') switchChat(process.argv[3], Number(process.argv[4]), process.argv.includes('--now'));
  else if (cmd === 'attach') attach(process.argv[3]);
  else if (cmd === 'delete') del(process.argv[3]);
  else if (cmd === 'remove') remove(process.argv[3]);
  else if (cmd === 'web') web();
  else if (cmd === 'web-link') console.log(`${TUNNEL.url}/?key=${webKey(process.argv[3] === 'new')}`); // new: the old key's browsers are out
  else if (cmd === 'rename') rename(process.argv[3], process.argv.slice(4).join(' '));
  else if (cmd === 'wt-bind') wtBind();
  else if (cmd === 'renew') { // renew N M-D: the day account N renews (or ends) as the store shows it; renew N auto: guessed again
    const [n, v] = process.argv.slice(3), m = /^(?:(\d{4})\D)?(\d{1,2})\D(\d{1,2})\D?$/.exec(v ?? '');
    if (!load().profiles[n - 1] || (v !== 'auto' && !m)) { console.log('用法：claude-multi renew <账号编号> <月-日，如 10-28；auto 改回推算>'); process.exit(1); }
    update((r) => { const p = r.profiles[n - 1]; if (v === 'auto') delete p.renewOn; else p.renewOn = `${m[1] ?? new Date().getFullYear()}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; });
    console.log(v === 'auto' ? `账号 ${n} 改回按订阅开始时间推算` : `已记下：账号 ${n} 每月 ${+m[3]} 号续费（取消续订的，这天到期）`);
  }
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
    try { saveLine(input); } catch {} // the line is what counts
  }
  else launch(process.argv.slice(2));
}
