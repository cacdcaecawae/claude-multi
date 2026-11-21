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
// the island switched off in the page's settings: not started (not by a note, not by the CLI; at login island.ps1
// only starts the web service), and nothing put in its inbox. The web pages and phones get their notes as ever.
const ISLAND_OFF = path.join(ROOT, 'island-off');
// macOS: the web page only (its conversations, 申请接入's accounts); no island, terminal windows, Recycle Bin or PowerShell
const WIN = process.platform === 'win32';
const islandOff = () => !WIN || fs.existsSync(ISLAND_OFF);
const TRASH = WIN ? '回收站' : '废纸篓';
// where a command is on the PATH ('' if not)
const whereIs = (c) => spawnSync(WIN ? 'where' : 'which', [c], { encoding: 'utf8', windowsHide: true }).stdout?.split(/\r?\n/).find(Boolean)?.trim() ?? '';
// the 管家, a 开发功能: off till it's switched on in the page's settings (then this file is there)
const BUTLER_ON = path.join(ROOT, 'butler-on');
const butlerOn = () => fs.existsSync(BUTLER_ON), BUTLER_SHUT = '管家没有开启：在设置的「开发功能」里打开';
const CLAUDE = 'claude';
// claude's own program. npm's on Windows is a shim only a shell starts, and where lists its sh script first: the page's
// pseudo-terminal got error 193 (no pid, every conversation ended at once), spawn without a shell no claude at all.
// So the claude.exe its claude.cmd runs.
function claudeCmd(at = whereIs('claude')) {
  const npm = WIN && at && !/\.exe$/i.test(at) && path.join(path.dirname(at), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return npm && fs.existsSync(npm) ? npm : at || CLAUDE;
}

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
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }; // null: none, or not JSON
function shareMcp(dir, files = [path.join(HOME, '.claude.json'), ...load().profiles.map((p) => path.join(p.configDir, '.claude.json'))],
  stateFile = path.join(ROOT, 'mcp-shared.json')) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const st = readJson(stateFile) ?? { set: {}, seen: {} }, set = st.set;
  for (const f of files) {
    const j = readJson(f), was = st.seen[f];
    if (!j) continue; // missing, or caught mid-write: not a removal
    const m = j.mcpServers ?? {};
    for (const [k, v] of Object.entries(m)) if (!was || !same(v, was[k])) set[k] = v; // new there, or changed
    if (was) for (const k of Object.keys(was)) if (!(k in m)) delete set[k];          // removed there
    st.seen[f] = m;
  }
  for (const f of [files[0], path.join(dir, '.claude.json')]) {
    const j = readJson(f);
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
// extra: folders (as C:/a/b) trusted besides, as clicking Yes on their trust question does
function shareTrust(dir, files = [path.join(HOME, '.claude.json'), ...load().profiles.map((p) => path.join(p.configDir, '.claude.json'))], extra = []) {
  const trusted = new Set([...extra, ...files.flatMap((f) => Object.entries(readJson(f)?.projects ?? {}).filter(([, v]) => v?.hasTrustDialogAccepted).map(([k]) => k))]);
  const f = path.join(dir, '.claude.json'), j = readJson(f);
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
  const r = spawnSync(claudeCmd(), args, { stdio: 'inherit', env: childEnv(dir) });
  process.off('SIGINT', ignore);
  return r;
}

function authStatus(dir) {
  const r = spawnSync(claudeCmd(), ['auth', 'status', '--json'], { env: childEnv(dir), encoding: 'utf8' });
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

// A new account's folder, acct-<day>-<n>: the shared files linked in, your preferences (theme, onboarding) copied.
// settings(id): its own settings.json (an API account's), written first so the shared one isn't linked in its place.
function accountDir(settings) {
  fs.mkdirSync(ACCOUNTS, { recursive: true });
  const day = new Date().toLocaleDateString('sv').replace(/-/g, ''); // local YYYYMMDD
  let id, dir;
  for (let n = 1; ; n++) { // mkdir without recursive is the uniqueness check, failed profiles keep their number
    id = `acct-${day}-${String(n).padStart(3, '0')}`;
    dir = path.join(ACCOUNTS, id);
    try { fs.mkdirSync(dir); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings(id), null, 2) + '\n');
  ensureLinks(dir);
  const prefs = {};
  try {
    const g = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    for (const k of PREF_KEYS) if (k in g) prefs[k] = g[k];
  } catch {}
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(prefs, null, 2) + '\n');
  return { id, dir };
}

// 申请接入: your applications to a gateway's apply service, in join.json (never in git: each keeps its ticket, the
// secret the service knows it by). Approved, one becomes an API account: your settings (the shared settings.json) with
// the gateway's address and the key it gave. Once per application (api.join), however often it's asked.
const JOINS = path.join(ROOT, 'join.json');
const readJoins = () => { try { return JSON.parse(fs.readFileSync(JOINS, 'utf8')); } catch { return []; } };
const saveJoins = (js) => { fs.writeFileSync(JOINS + '.tmp', JSON.stringify(js, null, 2)); fs.renameSync(JOINS + '.tmp', JOINS); };
const editJoin = (id, fn) => saveJoins(readJoins().flatMap((j) => (j.id === id ? fn(j) : [j])));
const joinsShown = () => readJoins().map(({ ticket, ...j }) => j);
// such an account's base URL: delta.js send, run by the web service, which sends each request to its gateway as what
// changed since the last (the conversation whole every request, megabytes), whole to a gateway that can't rebuild it
const viaDelta = (id) => `http://127.0.0.1:${WEB_PORT + 1}/j/${id}`;
// such accounts' base URL: through delta.js send (via: it said it listens), else straight to their gateway (it won't
// start: its port taken), so none points at a send that isn't there
function pointJoins(via) {
  for (const p of load().profiles.filter((x) => x.api?.join)) try {
    const f = path.join(p.configDir, 'settings.json'), s = JSON.parse(fs.readFileSync(f, 'utf8')), to = via ? viaDelta(p.id) : p.api.baseURL;
    if (s.env?.ANTHROPIC_BASE_URL === to) continue;
    fs.writeFileSync(`${f}.tmp`, JSON.stringify({ ...s, env: { ...s.env, ANTHROPIC_BASE_URL: to } }, null, 2) + '\n'); fs.renameSync(`${f}.tmp`, f);
    log('profile_base', { profile_id: p.id, via });
  } catch (e) { log('profile_base_fail', { profile_id: p.id, err: e.message }); }
}
// 代理额度 (quota-panel.js): the quotas behind a proxy. Yours, when profiles.json's localQuota.source names an adapter (a
// file of your own, outside the repo: { read, refresh(target) }); else what each gateway 申请接入 joined lets its key see
// (<its address>/_quota). A gateway that says no (none there, 401, 403) adds nothing; all of them unreachable is an
// error, as an adapter's is.
const quotaOn = (reg = load()) => !!reg.localQuota?.source || reg.profiles.some((p) => p.api?.join); // its view shown
function quotaSource() {
  const f = load().localQuota?.source;
  if (f) { if (!path.isAbsolute(f)) throw Error('localQuota.source 要写绝对路径'); return require(f); }
  const read = async () => {
    const got = await Promise.allSettled(load().profiles.filter((p) => p.api?.join).map(async (p) => {
      const key = JSON.parse(fs.readFileSync(path.join(p.configDir, 'settings.json'), 'utf8')).env?.ANTHROPIC_AUTH_TOKEN;
      const r = await fetch(`${p.api.baseURL}/_quota`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) { await r.body?.cancel(); if ([401, 403, 404].includes(r.status)) return []; throw Error(`_quota ${r.status}`); }
      return jsonBody(r.body, 1 << 20);
    }));
    if (got.length && got.every((g) => g.status === 'rejected')) throw got[0].reason;
    return { quotas: got.flatMap((g) => (g.status === 'fulfilled' && Array.isArray(g.value) ? g.value : [])) };
  };
  return { read, refresh: read }; // a gateway's reading is its own: asked again, not refreshed
}
async function askApply(url, what, body) {
  const r = await fetch(`${url}/${what}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (!j || (!r.ok && r.status !== 404)) throw Error(j?.err ?? `接入地址答 ${r.status}`);
  return { status: r.status, ...j };
}
function joinAccount(j, key) {
  const reg = load(), had = reg.profiles.find((p) => p.api?.join === j.id);
  if (had) return had;
  // the same address again (its key taken back, applied anew): that account takes the new key, no second one
  const same = reg.profiles.find((p) => p.api?.join && p.api.baseURL === j.url), own = same && path.join(same.configDir, 'settings.json');
  if (same && fs.existsSync(own)) {
    const s = JSON.parse(fs.readFileSync(own, 'utf8'));
    fs.writeFileSync(own, JSON.stringify({ ...s, env: { ...s.env, ANTHROPIC_AUTH_TOKEN: key } }, null, 2) + '\n');
    update((r) => { r.profiles.find((p) => p.id === same.id).api.join = j.id; });
    log('profile_rejoined', { profile_id: same.id, base_url: j.url });
    return same;
  }
  let mine = {};
  try { mine = JSON.parse(fs.readFileSync(path.join(SHARED, 'settings.json'), 'utf8')); } catch {}
  const env = { ...mine.env, ANTHROPIC_AUTH_TOKEN: key, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' };
  delete env.ANTHROPIC_API_KEY; delete mine.apiKeyHelper; // the gateway's key only
  const { id, dir } = accountDir(() => ({ ...mine, env: { ...env, ANTHROPIC_BASE_URL: j.url } })); // pointJoins moves it to delta.js
  // no sign-in to walk through: Claude's first-run screens (its theme, its notes) skipped, the page has no cards for them.
  // A Claude Code just installed, never run, stopped there.
  const cj = path.join(dir, '.claude.json');
  fs.writeFileSync(cj, JSON.stringify({ ...JSON.parse(fs.readFileSync(cj, 'utf8')), hasCompletedOnboarding: true }, null, 2) + '\n');
  const p = { id, label: new URL(j.url).host, subscriptionType: 'API', configDir: dir, createdAt: now(), lastUsedAt: null, api: { baseURL: j.url, join: j.id } };
  update((reg) => { reg.profiles.push(p); });
  log('profile_joined', { profile_id: id, base_url: j.url });
  return p;
}
async function joinApply(b) {
  const url = String(b.url ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw Error('地址要以 https:// 或 http:// 开头');
  const r = await askApply(url, 'apply', { name: b.name, note: b.note });
  if (!r.ticket) throw Error(r.status === 404 ? '这个地址不收申请' : '接入地址没给回执');
  saveJoins([...readJoins().filter((j) => j.url !== url), // one per address: a new one replaces the last
    { id: require('crypto').randomBytes(6).toString('hex'), url, name: String(b.name ?? ''), ticket: r.ticket, state: 'pending', at: now() }]);
  return joinsShown();
}
// each one waiting, asked once; approved: its account, then the record dropped, then the service told it can forget the
// key. How many became accounts.
async function checkJoins() {
  let made = 0;
  for (const j of readJoins().filter((x) => x.state === 'pending')) {
    let r;
    try { r = await askApply(j.url, 'apply/status', { ticket: j.ticket }); } catch { continue; } // away: asked again later
    if (r.state === 'approved' && r.key) {
      joinAccount(j, r.key); made++;
      editJoin(j.id, () => []);
      askApply(j.url, 'apply/done', { ticket: j.ticket }).catch(() => {});
    } else if (r.state !== 'pending') editJoin(j.id, (x) => [{ ...x, state: r.status === 404 || r.state === 'approved' ? 'gone' : r.state }]);
  }
  return made;
}

function newProfile() {
  console.log('正在创建新的 Claude 账号配置……');
  const { id, dir } = accountDir();
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

// gpt: the GPT accounts listed too, G1, G2… (typed g1): one picked comes back as { gpt: account }
function pick(header, gpt = false) {
  for (;;) {
    const reg = load(), gs = gpt ? gptAccounts(reg) : [];
    if (!reg.profiles.length && !gs.length) {
      console.log('没有已保存账号，请先运行 claude-multi new。');
      process.exit(1);
    }
    console.log(header);
    reg.profiles.forEach((p, i) => console.log(`  ${i + 1}. ${p.id === reg.active ? '*' : ' '} ${label(p)}`));
    gs.forEach((g, i) => console.log(`  G${i + 1}.  ${g.label} (GPT${g.plan ? ` · ${g.plan}` : ''})`));
    console.log(`  ${reg.profiles.length + 1}. + 登录新账号\n`);
    const t = ask('请选择账号：');
    if (/^g\d+$/i.test(t)) { const g = gs[Number(t.slice(1)) - 1]; return g ? { gpt: g } : null; }
    const n = /^\d+$/.test(t) ? Number(t) : 0;
    if (n !== reg.profiles.length + 1) return reg.profiles[n - 1] || null;
    newProfile(); // then show the menu again: adding an account never picks it implicitly
    console.log();
  }
}

function launch(args) {
  const p = pick('选择账号：', true);
  if (!p) { console.log('无效选择，未启动。'); process.exit(1); }
  if (p.gpt) return runGpt(p.gpt, args);
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
  const reg = load(), gpt = gptAccounts(reg), gem = geminiAccounts(reg);
  if (!reg.profiles.length && !gpt.length && !gem.length) return console.log('没有已保存账号，请先运行 claude-multi new（GPT：claude-multi new gpt；Gemini：claude-multi new gemini）。');
  const w = Math.max(7, ...[...reg.profiles, ...gpt, ...gem].map((p) => p.label.length)) + 4;
  const row = (a, b, c, d) => `  ${a.padEnd(23)}${b.padEnd(w)}${c.padEnd(7)}${d}`;
  console.log(row('ID', 'ACCOUNT', 'PLAN', 'ACTIVE'));
  for (const p of reg.profiles) console.log(row(p.id, p.label, p.subscriptionType, p.id === reg.active ? '*' : ''));
  gpt.forEach((g, i) => console.log(row(g.id, g.label, g.plan ?? '', `G${i + 1}`))); // GPT accounts: G1, G2…
  gem.forEach((g, i) => console.log(row(g.id, g.label, '', `A${i + 1}${g.id === reg.geminiOn ? ' 在线' : ''}`))); // Gemini: A1, A2…
}

// Same endpoint /usage uses (found in claude.exe, internal, may change). Token stays in memory,
// no refresh: refreshing would race a running Claude writing the same .credentials.json.
async function fetchUsage(p) {
  if (p.api) { // an API account (本地代理, or one 申请接入 got): billed by what it uses, no 5-hour or weekly window to read
    if (p.api.join) try { // the gateway took its key back: 401
      const key = JSON.parse(fs.readFileSync(path.join(p.configDir, 'settings.json'), 'utf8')).env?.ANTHROPIC_AUTH_TOKEN;
      const r = await fetch(`${p.api.baseURL}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      if (r.status === 401) return { api: true, err: '接入已失效，可在设置里重新申请' };
    } catch {}
    return { api: true };
  }
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
  const macs = macList(reg);
  if (!reg.profiles.length && !macs.length) return console.log('没有已保存账号，请先运行 claude-multi new。');
  const running = (r) => r.u?.five_hour?.resets_at && new Date(r.u.five_hour.resets_at) > Date.now();
  const before = await Promise.all(reg.profiles.map(fetchUsage));
  const lw = Math.max(...reg.profiles.map((p) => width(p.label)), ...macs.map((m) => width(m.label)));
  console.log(`\n  ${c(1, '预热 5 小时窗口')}\n`);
  for (const [i, p] of reg.profiles.entries()) {
    const head = `  ${i + 1}. ${pad(p.label, lw)}  `;
    if (before[i].api) { console.log(`${head}${c(2, 'API 账号，没有 5 小时窗口，跳过')}`); continue; }
    if (running(before[i])) {
      console.log(`${head}${c(2, `已在计时，${until(before[i].u.five_hour.resets_at)}后重置，跳过`)}`);
      continue;
    }
    process.stdout.write(`${head}发送中…`);
    const r = spawnSync(claudeCmd(), ['-p', 'hi', '--model', 'haiku', '--tools', '', '--setting-sources', '',
      '--strict-mcp-config', '--no-session-persistence'],
    { env: childEnv(p.configDir), cwd: os.tmpdir(), encoding: 'utf8', timeout: 120000 });
    let after = await fetchUsage(p);
    for (let k = 0; r.status === 0 && !running(after) && k < 5; k++) { // the usage endpoint lags a few seconds
      await new Promise((ok) => setTimeout(ok, 3000));
      after = await fetchUsage(p);
    }
    // claude -p says why on stdout (a weekly limit hit, say); stderr's warnings (a plugin's) would hide it
    const why = r.error?.message || (r.stdout?.trim() || r.stderr?.trim() || '').split('\n').pop() || `退出码 ${r.status}`;
    console.log(`\r${head}${r.status === 0 && running(after) ? c(32, `已预热，${until(after.u.five_hour.resets_at)}后重置`)
      : r.status === 0 ? c(33, `已发送，但还没查到窗口开始计时（${after.err ?? '稍后用 usage 再看'}）`)
        : c(31, `失败：${why}`)}`);
    log('warmup', { profile_id: p.id, ok: r.status === 0 });
  }
  for (const m of macs) { // a Mac's account, the same way, there (in its /tmp: nothing kept)
    const head = `  ${pad(m.label, lw + 3)}  `;
    let after = await macUsage(m);
    if (running(after)) { console.log(`${head}${c(2, `已在计时，${until(after.u.five_hour.resets_at)}后重置，跳过`)}`); continue; }
    process.stdout.write(`${head}发送中…`);
    const r = await macRun(m, `security unlock-keychain -p "$LC_MACKC" >/dev/null 2>&1; unset LC_MACKC; cd /tmp && ${macEnv(m)}~/.local/bin/claude -p hi --model haiku --tools '' --setting-sources '' --strict-mcp-config --no-session-persistence`);
    after = await macUsage(m);
    for (let k = 0; r.status === 0 && !running(after) && k < 5; k++) { await new Promise((ok) => setTimeout(ok, 3000)); after = await macUsage(m); }
    const why = (r.err || r.out).trim().split('\n').pop() || `退出码 ${r.status}`;
    console.log(`\r${head}${r.status === 0 && running(after) ? c(32, `已预热，${until(after.u.five_hour.resets_at)}后重置`)
      : r.status === 0 ? c(33, `已发送，但还没查到窗口开始计时（${after.err ?? '稍后用 usage 再看'}）`) : c(31, `失败：${why}`)}`);
    log('warmup', { profile_id: m.id, ok: r.status === 0 });
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
// What set a conversation's latest turn going, in a transcript slice: the last thing typed into it (a message, or one sent
// while Claude was at work), unwrapped, from before `before`. Not Claude Code's last-prompt line: that's written only now
// and then (with its title, after a tool call), so a turn that only answered still had the prompt before it there (a
// [系统通知] the 管家 answered in a line read as yours: noted, pushed). A background task's or a teammate's message, a
// command, isn't typed: the one before counts. A picture alone: '[Image]'. null: none in the slice.
function lastTyped(tail, before = Infinity) {
  const ls = tail.split('\n');
  for (let i = ls.length - 1; i >= 0; i--) {
    const l = ls[i];
    if ((!l.includes('"type":"user"') && !l.includes('"queued_command"')) || l.includes('"type":"tool_result"')) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.isMeta || j.isSidechain || j.isCompactSummary || Date.parse(j.timestamp) > before) continue;
    if (j.type !== 'user' && !(j.attachment?.type === 'queued_command' && j.attachment.origin?.kind === 'human')) continue;
    const parts = said(j), t = parts.find((p) => p.type === 'text')?.text?.trim() || (parts.some((p) => p.type === 'image') ? '[Image]' : '');
    if (!t || /^(?:Another Claude session sent a message|<(?:task-notification|teammate-message|local-command|command-|system-reminder))/.test(t)) continue;
    return unwrapPaste(t);
  }
  return null;
}

// Start times of these pids, as sessions/<pid>.json's procStart has them: Windows' FILETIME (PowerShell), a Mac's ps's
// lstart in UTC and C's words (as Claude Code writes it there, whatever your language); null if that failed.
// The same pids within a minute: the last answer (PowerShell takes ~0.2 s, and the web service asks every few seconds).
// The web service sets procStarts.beside: there it runs beside, never waited on (waiting froze the service, and every
// terminal with it, once a minute); till it answers, or for a minute after it failed, null: the pid alone.
let startsSeen = { key: '', at: 0, map: null }, startsRun = null;
function procStarts(pids) {
  if (!pids.length) return new Map();
  const key = [...pids].sort().join(',');
  if (startsSeen.key === key && Date.now() - startsSeen.at < 60000) return startsSeen.map;
  const [exe, args, env] = WIN ? ['powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | `
    + '% { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }'], process.env] : ['ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { ...process.env, LC_ALL: 'C', TZ: 'UTC' }];
  const took = (out) => (startsSeen = { key, at: Date.now(), map: out == null ? null
    : new Map(out.split(/\r?\n/).flatMap((l) => { const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(l); return m ? [[m[1], m[2]]] : []; })) }).map;
  // a Mac's ps exits 1 when one of them is gone, the others said all the same
  const failed = (status, err) => (WIN ? status !== 0 : !!err);
  if (!procStarts.beside) { const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, env }); return failed(r.status, r.error) ? null : took(r.stdout); }
  startsRun ??= require('child_process').execFile(exe, args, { encoding: 'utf8', windowsHide: true, env }, (err, out) => {
    startsRun = null; took(failed(err ? 1 : 0, err && typeof err.code !== 'number') ? null : out);
  });
  return startsSeen.key === key ? startsSeen.map : null;
}
// the same start: Windows' FILETIME as written; a Mac's the same second (ps's, and Claude's, a date in UTC with no zone
// said; one with its zone, as it says). One that can't be read as a date: not told apart, the pid alone
const utcTime = (s) => { const t = Date.parse(`${s} UTC`); return Number.isFinite(t) ? t : Date.parse(s); };
const sameStart = (now, was, win = WIN) => win ? now === String(was)
  : !Number.isFinite(utcTime(was)) || Math.abs(utcTime(now) - utcTime(was)) < 2000;

const readHeads = new Map(); // record file -> { at: its mtime, cwd, title, prompt }
// The session files (sessions/<pid>.json) of a config dir whose pid still runs: each Claude started on it writes one.
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
function sessionFiles(dir) {
  const out = [];
  for (const f of ls(path.join(dir, 'sessions'))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', f), 'utf8'));
      process.kill(j.pid, 0); // throws once that Claude has exited
      out.push(j);
    } catch {}
  }
  return out;
}
// a Claude that didn't exit cleanly leaves its file, and the system soon gives its pid to another program:
// running means that pid also started when Claude wrote down (without PowerShell or ps, the pid alone)
const stillClaude = (js) => { const starts = procStarts(js.map((j) => j.pid)); return js.filter((j) => !starts || !j.procStart || sameStart(starts.get(String(j.pid)), j.procStart)); };
// Whether any Claude runs on an account, for removing it: from its session files, not the conversation list, which
// leaves out one with nothing said yet (no record), no title, or its folder gone.
// ponytail: one the web service has just spawned writes its file within a moment; that moment isn't covered
const runsOn = (dir) => stillClaude(sessionFiles(dir)).length > 0;
function listSessions(reg) {
  const live = new Map(), found = new Map(), alive = [];
  // and the Macs', as the web service copies them here (acct -1: none of this PC's accounts; mac: which one's)
  const macs = macList(reg), macBy = new Map(macs.map((m) => [m.id, m]));
  for (const [acct, dir, mac] of [...reg.profiles.map((p, i) => [i, p.configDir]), ...macs.map((m) => [-1, macHome(m), m.id])]) {
    if (acct >= 0) alive.push(...sessionFiles(dir));
    for (const folder of ls(path.join(dir, 'projects'))) {
      for (const name of ls(path.join(dir, 'projects', folder))) {
        if (!/^[0-9a-f-]{36}\.jsonl$/.test(name)) continue;
        const file = path.join(dir, 'projects', folder, name), id = name.slice(0, -6);
        let at; try { at = fs.statSync(file).mtimeMs; } catch { continue; } // deleted (or moved to the Recycle Bin) since the folder was read
        if ((found.get(id)?.at ?? -1) < at) found.set(id, { id, acct, file, at, ...(mac && { mac }) });
      }
    }
  }
  for (const j of stillClaude(alive)) live.set(j.sessionId, j);
  // a Mac's pid negative: never one of this PC's. shortcut: two Macs' Claudes with one pid would be taken for each other; give an entry its own sign if that bites
  for (const m of macs) for (const j of macLive(m)) live.set(j.sessionId, { ...j, pid: -j.pid });
  const macTo = Object.fromEntries(macs.map((m) => [m.id, macFolders(m)])); // a Mac project folder's folder here
  let webPids = new Set(); // the Claudes the web service runs (web-terms.json, written by it)
  try { webPids = new Set(JSON.parse(fs.readFileSync(WEB_TERMS, 'utf8'))); } catch {}
  const tmp = os.tmpdir().toLowerCase(), out = [];
  for (const s of found.values()) {
    let r = readHeads.get(s.file); // a record unchanged since the last look isn't read again (the web service asks every few seconds)
    if (r?.at !== s.at) {
      // one that can't be read now (gone a moment after its stat, held open): left out of this look, never the whole list
      // thrown away (the web service's timers list them: one throw there ended the service, its conversations with it)
      let head, tail;
      try {
        const fd = fs.openSync(s.file, 'r');
        try { const size = fs.fstatSync(fd).size; head = slice(fd, 0, 65536); tail = slice(fd, Math.max(0, size - 524288), 524288); } finally { fs.closeSync(fd); }
      } catch { continue; }
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
    if (!cwd || !title || (!s.mac && (cwd.toLowerCase().startsWith(tmp) || !fs.existsSync(cwd)))) continue; // nothing to go back to (a Mac's folder is there)
    const pid = live.get(s.id)?.pid ?? null, st = live.get(s.id)?.status;
    // busy: answering or running a command (its session file's status), for 换账号继续's 答完再换; wait: on a question for you
    // a Mac one: shown in the folder here its project folder is for (macCwd: where it runs there)
    out.push({ ...s, cwd: (s.mac && macPcOf(cwd, macBy.get(s.mac), macTo[s.mac])) || cwd, ...(s.mac && { macCwd: cwd }), title, prompt: prompt === title ? null : prompt, pid, req, web: !!pid && webPids.has(pid), busy: st === 'busy' || st === 'shell', wait: st === 'waiting',
      who: s.mac ? macBy.get(s.mac).label : reg.profiles[s.acct].label.split('@')[0] });
  }
  return out.sort((a, b) => b.at - a.at);
}

// --- Mac mini: Claude Code on a Mac (signed in there, its own account), over ssh: the registry's mac {host, dir,
// label?}. Its conversations run there, in one folder (dir). The web service keeps a copy of their records and of which
// of them run (accounts\mac: projects\<folder>\ as a config dir's, live.json), so the list, the record and the notes
// read them as an account's here. The Mac's password, saved encrypted (DPAPI, this Windows user) in mac-password.dpapi,
// unlocks its keychain, where its sign-in is, in each ssh connection: an ssh session finds it locked. It goes as LC_MACKC
// (the Mac's sshd takes LC_*), never on this PC's command line. On the Mac, `security unlock-keychain -p` has it on its
// own for that moment, where that Mac's other users could see it with ps (none so far: each Mac has the one user).
// Beside it, macs [{id, host, dir, config, label?}]: more of them, each a Mac and a config dir there (config: its
// CLAUDE_CONFIG_DIR, written as the Mac's own launcher sets it: Claude keeps its sign-in under a name made from that very
// string). Each entry is one account, as the Mac mini is: its copy here (accounts\<id>), its watcher, its live and
// folders; per Mac (host): the password (mac-password-<host>.dpapi beside the Mac mini's) and the CPU and memory.
const MAC_PW = path.join(ROOT, 'mac-password.dpapi');
// (an id names a folder under accounts\: none of an account's, a GPT one's or the Mac mini's)
const MAC_ID = /^[a-z0-9][a-z0-9-]{0,30}$/, MAC_HOST = /^[\w.-]+$/;
function macList(reg = load()) {
  return [...(reg.mac ? [{ ...reg.mac, id: 'mac', config: null, label: reg.mac.label || 'Mac mini' }] : []),
    ...(reg.macs ?? []).filter((m) => MAC_ID.test(m?.id ?? '') && !/^(mac|acct-.*|gpt-.*)$/.test(m.id) && MAC_HOST.test(m.host ?? '') && m.dir)
      .map((m) => ({ ...m, config: m.config || null, label: m.label || m.id }))];
}
const macOf = (id, reg) => macList(reg).find((m) => m.id === id);
const macHome = (m) => path.join(ACCOUNTS, m.id); // accounts\mac: the Mac mini's, as before
const macLive = (m) => { try { return JSON.parse(fs.readFileSync(path.join(macHome(m), 'live.json'), 'utf8')); } catch { return []; } };
// a path there for sh, its ~ as $HOME (a config dir's string has to be the very one its sign-in is filed under)
const macSh = (p) => p.startsWith('~/') ? `"$HOME"/${sq(p.slice(2))}` : sq(p);
const macEnv = (m) => m.config ? `CLAUDE_CONFIG_DIR=${macSh(m.config)} ` : '';
// A folder here has its project folder on the Mac, in its folder: named after it (F:\demo-sim → demo-sim, a drive's root
// its letter), a name as safe for sh as for a path; folders.json says which folder here each one is for (added to when
// one is made), so the list shows it there, among that folder's conversations here.
// ponytail: two folders here with one name (F:\a\x, D:\x) share one there; give one of them another name if that bites
const macName = (pc) => { const n = (path.win32.basename(pc) || pc.replace(/[:\\/]/g, '')).replace(/[\\/:*?"<>|'`$\s]+/g, '-').replace(/^[-.]+/, ''); return n || 'root'; };
function macFolders(m, add) {
  const f = path.join(macHome(m), 'folders.json');
  let o = {}; try { o = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  if (add && Object.entries(add).some(([k, v]) => o[k] !== v)) { o = { ...o, ...add }; fs.mkdirSync(macHome(m), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1)); }
  return o;
}
// the folder here a Mac one's folder there is for: by its name, when it's right in the Mac's folder (one in a project's
// subfolder isn't another project's that has the subfolder's name)
const macPcOf = (cwd, m, to = macFolders(m)) => path.posix.dirname(cwd).endsWith(m.dir.replace(/^~|\/+$/g, '')) ? to[path.posix.basename(cwd)] : undefined;
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // a word for sh, as it is
// Run on the Mac (python3 -, after DIR, CFG and HAVE: the folder, the config dir (None: ~/.claude), the record sizes copied here): one JSON line per change, for
// that folder and each one in it (a project's: mine/demo-sim), a record named by its project folder (folder/id.jsonl).
// A record's bytes past what's here, 512 KB a line ({f, at, d}: at 0 and nothing, rewritten); a /rename title ({t, d});
// one gone ({gone}); the Claudes running in them ({live}) when that changes; a beat every 15 s. Every 5 s, the Mac's CPU and
// memory in use and Claude Code's part ({sys}: its claude processes; CPU as ps has it, an average of late, for both).
// ponytail: a folder named like it (mine-old beside mine) is taken as one in it; Claude's own folder names can't tell them apart
const MAC_WATCH = String.raw`
import base64, json, os, re, subprocess, time
cwd = os.path.realpath(os.path.expanduser(DIR))
base = re.sub(r'[^a-zA-Z0-9]', '-', cwd)
cfg = os.path.expanduser(CFG or '~/.claude')
root = os.path.join(cfg, 'projects')
sess = os.path.join(cfg, 'sessions')
def out(o): print(json.dumps(o), flush=True)
def names(d):
    try: return os.listdir(d)
    except OSError: return []
seen, live_was, beat, sys_at = dict(HAVE), None, 0, 0
def feed(p, key, now): # a record's bytes past what's there; True: more of it left for the next round
    try: size = os.path.getsize(p)
    except OSError: return False
    now.add(key)
    k = seen.get(key, 0)
    if size < k: out({'f': key, 'at': 0, 'd': ''}); k = 0
    if size > k:
        with open(p, 'rb') as fh: fh.seek(k); d = fh.read(min(size - k, 524288))
        out({'f': key, 'at': k, 'd': base64.b64encode(d).decode()})
        k += len(d)
    seen[key] = k
    return k < size
# The Mac's other folders (not ours: whoever else uses Claude Code there): what their replies cost, from when our folder
# was made, and nothing said in them: of each reply only its id, model, time and token counts go out
OSEEN, _st = dict(OTHER), os.stat(cwd)
SINCE = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(getattr(_st, 'st_birthtime', _st.st_ctime)))
def lean(p, key):
    try: size = os.path.getsize(p)
    except OSError: return False
    k = OSEEN.get(key, 0)
    if size < k: k = 0
    if size > k:
        rows, n = [], 0
        with open(p, 'rb') as fh:
            fh.seek(k)
            for l in fh:
                if not l.endswith(b'\n'): break # still being written
                n += len(l)
                if b'"type":"assistant"' in l and b'"usage":' in l:
                    try:
                        j = json.loads(l); m = j['message']
                        if j['timestamp'] >= SINCE: rows.append(json.dumps({'type': 'assistant', 'timestamp': j['timestamp'], 'requestId': j.get('requestId') or '',
                            'message': {'id': m['id'], 'model': m.get('model') or '', 'usage': m['usage']}}, separators=(',', ':')))
                    except Exception: pass
                if n >= 8 << 20: break
        if not n: return False
        out({'o': key, 'at': k, 'to': k + n, 'd': base64.b64encode(('\n'.join(rows) + '\n').encode() if rows else b'').decode()})
        k += n
    OSEEN[key] = k
    return k < size
def run(*a): return subprocess.run(a, capture_output=True, text=True).stdout
def sysnow():
    k, cpu, mine, mem_mine, n = os.cpu_count() or 1, 0.0, 0.0, 0, 0
    for l in run('ps', '-A', '-o', '%cpu=,rss=,comm=').splitlines():
        f = l.split(None, 2)
        if len(f) < 3: continue
        c = float(f[0].replace(',', '.')); cpu += c
        if os.path.basename(f[2]) == 'claude': mine += c; mem_mine += int(f[1]) * 1024; n += 1
    vm = run('vm_stat')
    def g(name):
        m = re.search(name + r':\s+(\d+)', vm)
        return int(m.group(1)) if m else 0
    page = int(re.search(r'page size of (\d+)', vm).group(1))
    # as Activity Monitor's Memory Used: app memory, wired, compressed
    used = ((g('Anonymous pages') or g('Pages active')) - g('Pages purgeable') + g('Pages wired down') + g('Pages occupied by compressor')) * page
    return {'cpu': round(min(100, cpu / k)), 'cpuClaude': round(min(100, mine / k)), 'mem': used, 'memClaude': mem_mine, 'memAll': int(run('sysctl', '-n', 'hw.memsize')), 'n': n}
while True:
    more, now = False, set()
    for g in [x for x in names(root) if x == base or x.startswith(base + '-')]:
        for n in names(os.path.join(root, g)):
            p, key = os.path.join(root, g, n), g + '/' + n
            if n.endswith('.jsonl'): more = feed(p, key, now) or more
            elif os.path.isdir(p):
                for a in names(os.path.join(p, 'subagents')): # its subagents' records: their tokens are counted too
                    if a.endswith('.jsonl'): more = feed(os.path.join(p, 'subagents', a), key + '/subagents/' + a, now) or more
                t = os.path.join(p, 'custom-title.json')
                try: m = os.path.getmtime(t)
                except OSError: continue
                now.add(key + '/')
                if seen.get(key + '/') != m:
                    with open(t, 'rb') as fh: out({'t': key, 'd': base64.b64encode(fh.read()).decode()})
                    seen[key + '/'] = m
    for g in [x for x in names(root) if not (x == base or x.startswith(base + '-'))]:
        for n in names(os.path.join(root, g)):
            p, key = os.path.join(root, g, n), g + '/' + n
            if n.endswith('.jsonl'): more = lean(p, key) or more
            else:
                for a in names(os.path.join(p, 'subagents')):
                    if a.endswith('.jsonl'): more = lean(os.path.join(p, 'subagents', a), key + '/subagents/' + a) or more
    for n in [x for x in seen if x not in now]:
        out({'gone': n}); del seen[n]
    live = []
    for n in names(sess):
        try:
            with open(os.path.join(sess, n)) as fh: j = json.load(fh)
            c = os.path.realpath(j.get('cwd', ''))
            if c != cwd and not c.startswith(cwd + '/'): continue
            os.kill(j['pid'], 0)
            live.append({k: j.get(k) for k in ('pid', 'sessionId', 'status', 'kind')})
        except Exception: pass
    live.sort(key=lambda j: j['pid'])
    if live != live_was: out({'live': live}); live_was = live
    beat += 1
    if beat >= 50: out({'hb': 1}); beat = 0 # ~15 s
    if time.time() - sys_at >= 5:
        sys_at = time.time()
        try: out({'sys': sysnow()})
        except Exception: pass
    if not more: time.sleep(0.3) # an answer here within a second of its end (the page waits on it)
`;
// A file ConvertFrom-SecureString wrote (DPAPI, this Windows user, as hex) read back by .NET alone, no PowerShell module:
// a 预热 started by the web service once found ConvertTo-SecureString's module failing to load ("The member AuditToString
// is already present"), the Mac skipped
const dpapiRead = (file) => spawnSync('powershell.exe', ['-NoProfile', '-Command', "[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'); "
  + `$h = [IO.File]::ReadAllText('${file}').Trim(); [Text.Encoding]::Unicode.GetString([Security.Cryptography.ProtectedData]::Unprotect([byte[]]($h -split '(..)' -ne '' | ForEach-Object { [Convert]::ToByte($_, 16) }), $null, 'CurrentUser'))`],
{ encoding: 'utf8', windowsHide: true });
const macPwFile = (m) => m.id === 'mac' ? MAC_PW : path.join(ROOT, `mac-password-${m.host}.dpapi`);
// a Mac's password, read once it reads (null: not saved, or not read this time: tried again the next); why not
const macPws = new Map(), macPwWhy = new Map();
function macPassword(m) {
  const f = macPwFile(m);
  if (macPws.has(f) || !fs.existsSync(f)) return macPws.get(f) ?? null;
  const r = dpapiRead(f), pw = r.stdout?.replace(/\r?\n$/, '') || null;
  macPwWhy.set(f, (r.error?.message || r.stderr || '').trim().split('\n')[0].trim());
  if (pw) macPws.set(f, pw);
  return pw;
}
const macNoPw = (m, f = macPwFile(m)) => fs.existsSync(f) ? `没读出 ${m.label} 的密码（${f}${macPwWhy.get(f) ? `：${macPwWhy.get(f)}` : ''}），再试一次` : `还没保存 ${m.label} 的密码（${f}）`;
// The Mac account's usage, read there (python3 -): its sign-in never leaves the Mac. As fetchUsage's: {u} or {err, temp?}.
const MAC_USAGE = String.raw`
import hashlib, json, os, subprocess, sys, time, urllib.request, urllib.error
subprocess.run(['security', 'unlock-keychain', '-p', os.environ.pop('LC_MACKC', '')], capture_output=True)
def out(o): print(json.dumps(o)); sys.exit()
# a config dir's sign-in is filed under its own name: the first 8 of its string's sha256 (as Claude Code names it)
svc = 'Claude Code-credentials' + ('-' + hashlib.sha256(os.path.expanduser(CFG).encode()).hexdigest()[:8] if CFG else '')
r = subprocess.run(['security', 'find-generic-password', '-s', svc, '-w'], capture_output=True, text=True)
try: c = json.loads(r.stdout)['claudeAiOauth']
except Exception: out({'err': '未找到登录凭据'})
if c.get('expiresAt') and c['expiresAt'] < time.time() * 1000: out({'err': 'token 已过期：在 Mac 上用一次 Claude 就会刷新'})
q = urllib.request.Request('https://api.anthropic.com/api/oauth/usage', headers={'Authorization': 'Bearer ' + c['accessToken'], 'anthropic-beta': 'oauth-2025-04-20'})
try: out({'u': json.load(urllib.request.urlopen(q, timeout=10)), 'sub': c.get('subscriptionType')})
except urllib.error.HTTPError as e: out({'err': '用量接口返回 HTTP %d' % e.code, 'temp': e.code >= 500 or e.code == 429})
except Exception as e: out({'err': '网络错误：%s' % e, 'temp': True})
`;
// A Claude on the Mac runs in a tmux of ours there (-L cm, apart from any of the Mac's own; no config of the Mac's): a
// link dropped (this service restarted, the network, this PC asleep) leaves it working, and it's joined again. Run by sh
// (the Mac's login shell is zsh): the keychain unlocked (a Claude that tmux starts later keeps the login of the one that
// started it, its link gone or not), into its folder; resume: one running in that tmux joined (one in a terminal there
// refused), else a new one; its pid and tmux session said in an OSC, then joined. {sess}: that session joined again.
// Its tmux: Homebrew's, else one built into ~/.local (a Mac without Homebrew: a MacBook's), as $T.
// shortcut: Homebrew's on Apple silicon only; an Intel Mac's is /usr/local/bin/tmux
const MAC_TMUX = 'T=/opt/homebrew/bin/tmux; [ -x "$T" ] || T="$HOME"/.local/bin/tmux';
// config: the config dir there (null: ~/.claude), set in the command tmux runs (its server, one per Mac, keeps the
// environment of whoever started it)
function macCmd({ into = '', resume = null, sess = null, name = '', cols = 100, rows = 30, config = null }) {
  const tm = '"$T" -u -f /dev/null -L cm';
  if (sess) return `${MAC_TMUX}; exec ${tm} attach -t ${sq(sess)}`;
  const env = config ? `env CLAUDE_CONFIG_DIR=${macSh(config)} ` : '';
  const sh = [
    'security unlock-keychain -p "$LC_MACKC" >/dev/null 2>&1; unset LC_MACKC',
    `${into} || exit`,
    MAC_TMUX,
    `[ -x "$T" ] || { echo 'Mac 上没有 tmux：在 Mac 上运行 brew install tmux'; exit 3; }`,
    `t() { ${tm} "$@"; }`,
    'S= P=',
    ...(resume ? [`for f in $(grep -l ${sq(resume)} ${config ? macSh(config) : '~/.claude'}/sessions/*.json 2>/dev/null); do`,
      '  p=$(basename "$f" .json); kill -0 "$p" 2>/dev/null || continue',
      `  S=$(t list-panes -a -F '#{pane_pid} #{session_name}' 2>/dev/null | awk -v p="$p" '$1==p{print $2; exit}')`,
      '  [ -n "$S" ] && { P=$p; break; }',
      "  echo '它在 Mac 上的终端里运行，不在网页里：在那边接着用'; exit 3",
      'done'] : []),
    'if [ -z "$S" ]; then',
    `  S=${sq(name)}`,
    '  t start-server \\; set -g default-terminal xterm-256color \\; set -g status off \\; set -g escape-time 0 \\; set -g set-clipboard on \\;'
      + ` set -g allow-passthrough on \\; set -g window-size latest \\; new-session -d -s "$S" -x ${cols} -y ${rows} -c "$PWD"`
      + ` ${sq(`exec ${env}~/.local/bin/claude${resume ? ` --resume ${resume}` : ''}`)} || exit`,
    `  P=$(t display -p -t "$S" '#{pane_pid}')`,
    'fi',
    `printf '\\033]1337;cmpid=%s;%s\\007' "$P" "$S"`,
    `exec ${tm} attach -t "$S"`].join('\n');
  return `exec /bin/sh -c "$(echo ${Buffer.from(sh).toString('base64')} | base64 -D)"`;
}
// The PC project's own CLAUDE.md, kept after the Mac folder's (from a mark line on: put again at each start, gone when
// it's gone there): loaded with it, where "read the one there" was only asked, and forgotten. sh, run in the Mac
// folder; never what stops a start.
// shortcut: one that packs to over 12 K isn't copied (the whole command has to fit Windows' 32 K line), the note above it still says to read it there
function macRules(pc) {
  let md = '';
  try { md = fs.readFileSync(path.join(pc, 'CLAUDE.md'), 'utf8').replace(/^\uFEFF/, '').trim(); } catch {}
  const b = md && require('zlib').gzipSync(`<!-- cm-pc-rules: 以下是电脑上 ${pc.replace(/\\/g, '/')}/CLAUDE.md 的内容，每次从网页开这个对话时更新；要改去电脑上改 -->\n\n${md}\n`).toString('base64');
  // (T: this start's own; two starts in a folder at once sharing one lost the Mac folder's part)
  return `{ T=CLAUDE.md.cm.$$; [ -f CLAUDE.md ] && awk '/^<!-- cm-pc-rules/{exit}{print}' CLAUDE.md > $T${b && b.length <= 12000 ? ` && echo ${b} | base64 -D | gunzip >> $T` : ''} && mv $T CLAUDE.md || rm -f $T; }`;
}
// a command on the Mac, its keychain unlocked first (sh: what runs; input: python3 - reads it), tried again when the
// link to the server drops (ssh's 255); resolves to {status, out, err}
function macRun(m, cmd, input) {
  const pw = macPassword(m);
  if (!pw) return Promise.resolve({ status: 1, out: '', err: macNoPw(m) });
  const once = () => new Promise((ok) => {
    const p = require('child_process').execFile('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'SendEnv=LC_MACKC', m.host, cmd],
      { env: { ...process.env, LC_MACKC: pw }, encoding: 'utf8', windowsHide: true, timeout: 150000 },
      (e, out, err) => ok({ status: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(out ?? ''), err: String(err || e?.message || '') }));
    p.stdin.on('error', () => {}); p.stdin.end(input ?? '');
  });
  return (async () => { let r; for (let k = 0; k < 3 && (!r || r.status === 255); k++) r = await once(); return r; })();
}
// An upload for a conversation on the Mac: copied there (its folder's .uploads, a week kept as here), its path there what
// Claude is given: one here it can't open
async function macPut(file, m) {
  if (!m) throw new Error('没有这台 Mac');
  const name = sq(path.basename(file));
  const r = await macRun(m, `cd ${macSh(m.dir)} && mkdir -p .uploads && { find .uploads -type f -mtime +7 -delete; cat > .uploads/${name}; } && printf %s "$PWD/.uploads/"${name}`, fs.readFileSync(file));
  if (r.status || !r.out) throw new Error(`没传到 ${m.label} 上：${r.err.trim().split('\n').pop() || r.status}`);
  return r.out;
}
const pyVal = (v) => (v == null ? 'None' : JSON.stringify(v)); // a value for Python (JSON's strings are its own too)
const macUsage = (m) => macRun(m, 'python3 -', `CFG = ${pyVal(m.config)}\n${MAC_USAGE}`).then((r) => {
  try { return JSON.parse(r.out.trim().split('\n').pop()); } catch { return { err: `没连上 Mac：${r.err.trim().split('\n').pop()}`, temp: true }; }
});

// --- GPT: Codex (OpenAI's coding agent, signed in with a ChatGPT plan) as a second kind of conversation. Its accounts are
// the registry's gpt list, apart from the Claude ones (profiles): nothing written for Claude meets them. Each has its own
// CODEX_HOME under accounts\ (gpt-YYYYMMDD-NNN), as a Claude account its own config dir; ~/.codex is left as it is (its
// settings copied into a new account once, its own conversations stay there).
const CODEX_SHARED = path.join(HOME, '.codex');
const gptAccounts = (reg = load()) => reg.gpt ?? [];
const longPath = (p) => String(p ?? '').replace(/^\\\\\?\\/, ''); // Codex keeps paths as \\?\C:\…
// codex.exe as npm put it, with the two variables its launcher (bin/codex.js) sets: on Windows the launcher starts it as a
// child, which under a pseudo-terminal left Codex a grandchild, running on when its terminal was ended. The launcher
// itself once that layout changes.
function codexCmd() {
  const shim = WIN && whereIs('codex'); // GPT: Windows only
  if (!shim) return null;
  const pkg = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex');
  const exe = path.join(pkg, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  if (fs.existsSync(exe)) return { file: exe, pre: [], env: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: pkg } };
  const js = path.join(pkg, 'bin', 'codex.js');
  return fs.existsSync(js) ? { file: process.execPath, pre: [js], env: {} } : null;
}
// what Codex runs with in a GPT account: its CODEX_HOME, and no API key of yours in the way of its ChatGPT login
function codexEnv(codex, home) {
  const env = { ...process.env, ...codex.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  return env;
}
// its turns' ends and its questions told as Claude's hooks tell them (claude-multi notify gpt <its CODEX_HOME>), in place
// of the notify the account's config may name (a copy of ~/.codex's, for Codex's own app)
const gptNotifyArgs = (home) => ['-c', `notify=${JSON.stringify([process.execPath, __filename, 'notify', 'gpt', home].map((p) => p.split(path.sep).join('/')))}`];
// The GPT conversations running (Codex writes no session file, as Claude does): a marker for each Codex, gpt-live\<pid>.json
// {pid, home, cwd, since, id, web}, from whoever started it (claude-multi start Gn in a terminal, or the web service), gone
// when it ends. Its thread id once known: resumed, at once; new, bound by account, folder and time, or by its first
// notify. One whose Codex is gone (a terminal closed under it, the service stopped) is dropped when read.
// ponytail: a pid reused after a crash reads as that conversation running; Claude's session files carry the process's start time for this
const GPT_LIVE = path.join(ROOT, 'gpt-live');
function gptMark(m) {
  fs.mkdirSync(GPT_LIVE, { recursive: true });
  const f = path.join(GPT_LIVE, `${m.pid}.json`);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(m)); fs.renameSync(`${f}.tmp`, f);
}
const gptUnmark = (pid) => { try { fs.unlinkSync(path.join(GPT_LIVE, `${pid}.json`)); } catch {} };
// what the page and the 管家 type, as a Codex (0.166, Windows) takes it: it has no paste marks (they arrive as plain
// keys and nothing gets sent), and takes a new line inside the words as Enter (the first line would go alone) — so the
// words without the marks, each new line as Shift+Enter in win32-input-mode (the pty and console-bridge.ps1 both turn
// that into the key). Words: anything printable besides escape sequences.
const SHIFT_ENTER = '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_';
function codexKeys(raw) {
  let data = String(raw).replace(/\x1b\[20[01]~/g, '');
  const words = /[^\x00-\x1f\x7f]/.test(data.replace(/\x1b(\[[0-9;?]*[A-Za-z~_]|O.)/g, ''));
  if (words) data = data.replace(/\r\n?|\n/g, SHIFT_ENTER);
  return { data, words };
}
function gptMarks() {
  const out = [];
  for (const f of ls(GPT_LIVE).filter((x) => x.endsWith('.json'))) {
    let m; try { m = JSON.parse(fs.readFileSync(path.join(GPT_LIVE, f), 'utf8')); } catch { continue; }
    if (m.pid && alive(m.pid)) out.push(m); else gptUnmark(m.pid ?? f.slice(0, -5));
  }
  return out;
}
// claude-multi start Gn (or the menu's Gn, or resume): Codex on GPT account g in this terminal, as Claude is started, the
// folder trusted in that account first; its marker kept while it runs. Ctrl+C is Codex's: this process waits for it.
function runGpt(g, args = []) {
  const codex = codexCmd();
  if (!codex) { console.log('没找到 codex，先装好 Codex：npm i -g @openai/codex'); process.exit(1); }
  gptTrust(g.home, process.cwd());
  log('gpt_started', { profile_id: g.id });
  console.log(`使用 GPT 账号：${g.label}\n正在启动 Codex……`);
  process.on('SIGINT', () => {});
  const child = require('child_process').spawn(codex.file, [...codex.pre, ...gptNotifyArgs(g.home), ...args], { stdio: 'inherit', env: codexEnv(codex, g.home) });
  if (child.pid) gptMark({ pid: child.pid, home: g.home, cwd: process.cwd(), since: Date.now(), id: args[0] === 'resume' ? args[1] ?? null : null, web: false });
  child.on('error', (e) => { gptUnmark(child.pid); console.error(`无法启动 codex：${e.message}`); process.exit(1); });
  child.on('exit', (code) => { gptUnmark(child.pid); process.exit(code ?? 1); });
}
// a GPT account by its G name (g1, G2): null if there's none
const gptByName = (x, reg) => (/^g\d+$/i.test(x ?? '') ? gptAccounts(reg)[Number(x.slice(1)) - 1] ?? null : null);
// who a GPT account is, from its login (the ChatGPT id token's email and plan): read, never kept
function gptWho(home) {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).tokens.id_token, p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url'));
    return { email: p.email ?? null, plan: p['https://api.openai.com/auth']?.chatgpt_plan_type ?? null };
  } catch { return { email: null, plan: null }; }
}
// new gpt: a GPT account, signed in with ChatGPT in the browser (codex login in its CODEX_HOME). Your settings now (model,
// MCP servers, trusted folders: config.toml; AGENTS.md) copied in, not linked: Codex writes its config itself (a folder
// trusted); skills, rules and prompts linked, as a Claude account's are.
function newGpt() {
  const codex = codexCmd();
  if (!codex) { console.log('没找到 codex，先装好 Codex：npm i -g @openai/codex'); return null; }
  fs.mkdirSync(ACCOUNTS, { recursive: true });
  const day = new Date().toLocaleDateString('sv').replace(/-/g, '');
  let id, home;
  for (let n = 1; ; n++) { // mkdir without recursive is the uniqueness check, as newProfile's
    id = `gpt-${day}-${String(n).padStart(3, '0')}`; home = path.join(ACCOUNTS, id);
    try { fs.mkdirSync(home); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  for (const f of ['config.toml', 'AGENTS.md']) try { fs.copyFileSync(path.join(CODEX_SHARED, f), path.join(home, f)); } catch {}
  for (const d of ['skills', 'rules', 'prompts']) if (fs.existsSync(path.join(CODEX_SHARED, d))) try { fs.symlinkSync(path.join(CODEX_SHARED, d), path.join(home, d), 'junction'); } catch {}
  log('gpt_created', { profile_id: id });
  console.log(`GPT 账号目录：${id}\n正在用 ChatGPT 登录（会打开浏览器，登录完回到这里）……`);
  const env = codexEnv(codex, home);
  spawnSync(codex.file, [...codex.pre, 'login'], { stdio: 'inherit', env });
  if (spawnSync(codex.file, [...codex.pre, 'login', 'status'], { env, encoding: 'utf8', windowsHide: true }).status !== 0) {
    log('gpt_login_failed', { profile_id: id });
    console.log(`还没检测到登录成功，目录先留着：${id}（没有加进账号列表）`);
    return null;
  }
  const who = gptWho(home), dup = who.email && gptAccounts().find((g) => g.email === who.email);
  if (dup) {
    log('gpt_duplicate', { profile_id: id, existing_profile_id: dup.id });
    console.log(`这个 ChatGPT 账号已经登记过了（${dup.id}），没有重复登记。目录留着：${id}`);
    return null;
  }
  const reg = update((r) => { (r.gpt ??= []).push({ id, label: who.email || 'ChatGPT', email: who.email, plan: who.plan, home, createdAt: now() }); });
  log('gpt_registered', { profile_id: id, account: who.email, plan: who.plan });
  console.log(`已保存 GPT 账号 G${reg.gpt.length}：${who.email || 'ChatGPT'}${who.plan ? `（${who.plan}）` : ''}`);
  return true;
}
// remove Gn: GPT account n leaves the list (not while a Codex runs on it: its marker, there from its start, before it has a
// conversation), its folder (its login, its conversations) to the Recycle Bin; 用量 keeps what it used, as a removed
// Claude account's (counted first: its records go with the folder)
function removeGpt(n) {
  const g = gptAccounts()[n - 1];
  if (!g) { console.log('没有这个 GPT 账号：用 claude-multi list 看编号（G1、G2…）'); process.exit(1); }
  if (gptMarks().some((m) => sameDir(m.home, g.home))) { console.log('这个 GPT 账号上有 Codex 正在运行，先关掉再移除。'); process.exit(1); }
  canRecycle();
  tokenStats();
  update((r) => { r.gpt = (r.gpt ?? []).filter((x) => x.id !== g.id); (r.removedGpt ??= []).push({ id: g.id, label: g.label, home: g.home }); });
  log('gpt_removed', { profile_id: g.id });
  let r = {}; // as remove: never deleted with a link still in it
  try { unlinkAll(g.home); r = recycle([g.home]); } catch {}
  if (fs.existsSync(g.home)) console.log(`已移除 GPT 账号 ${g.label}，但文件夹没能放进回收站（${(r.stderr || '').trim().split('\n')[0] || '可能有 Codex 开着里面的文件'}），可以之后手动删：${g.home}`);
  else console.log(`已移除 GPT 账号 ${g.label}，文件夹在回收站里。`);
}
// Codex asks before working in a folder it doesn't trust yet: a GPT account trusts the ones it's started in from here, in
// its own config.toml (a copy: yours in ~/.codex isn't touched). A path with ' in it can't be such a key: asked then.
function gptTrust(home, dir) {
  const f = path.join(home, 'config.toml'), p = path.resolve(dir);
  if (p.includes("'")) return;
  let s = '';
  try { s = fs.readFileSync(f, 'utf8'); } catch {}
  const lower = s.toLowerCase();
  if (lower.includes(`[projects.'${p.toLowerCase()}']`) || lower.includes(`[projects."${p.replace(/\\/g, '\\\\').toLowerCase()}"]`)) return;
  fs.appendFileSync(f, `${s && !s.endsWith('\n') ? '\n' : ''}\n[projects.'${p}']\ntrust_level = "trusted"\n`);
}
// Codex's SQLite (its conversation list, state_5.sqlite; their records, thread_history_1.sqlite), read only: node:sqlite,
// Node 22.13 and later (its "experimental" warning kept off the 管家's command output)
let sqlite = null;
function codexDb(home, name) {
  if (!sqlite) {
    const warn = process.emitWarning;
    process.emitWarning = () => {};
    try { sqlite = require('node:sqlite'); } catch { throw new Error('读 GPT 对话要 Node 22.13 或更新的版本'); } finally { process.emitWarning = warn; }
  }
  return new sqlite.DatabaseSync(path.join(home, name), { readOnly: true });
}
// The GPT conversations: each account's threads (Codex's list), the ones something was said in (a first message: its
// has_user_event column is left 0), not archived, not a helper agent's, their folder still there; newest first. An account's read again only once its list changed (the database or
// its write-ahead log written); a read that fails (a write in flight) keeps the last one.
const gptHeads = new Map();
function listGpt(reg = load()) {
  const out = [], marks = gptMarks();
  gptAccounts(reg).forEach((g, acct) => {
    const f = path.join(g.home, 'state_5.sqlite'), at = Math.max(0, ...['', '-wal'].map((x) => { try { return fs.statSync(f + x).mtimeMs; } catch { return 0; } }));
    let r = gptHeads.get(f);
    if (at && r?.at !== at) try {
      const d = codexDb(g.home, 'state_5.sqlite');
      try {
        r = { at, rows: d.prepare(`select id, cwd, title, name, preview, first_user_message first, updated_at_ms up, created_at_ms made, model, reasoning_effort effort from threads
          where archived = 0 and first_user_message != '' and source not like '%subagent%' order by updated_at_ms desc`).all() };
      } finally { d.close(); }
      gptHeads.set(f, r);
    } catch {}
    // its running ones: a marker not bound yet takes the first thread, in its folder, made since it started, or opened since
    // (Codex's own resume list): Codex holds a thread through thread-writer-locks/<id>.lock, made when it takes it and
    // gone when it lets go
    // ponytail: bound once; a Codex that opens another conversation from its resume list later keeps the first one's
    const mine = marks.filter((m) => sameDir(m.home, g.home)), taken = new Set(mine.map((m) => m.id).filter(Boolean));
    const lockAt = (id) => { try { return fs.statSync(path.join(g.home, 'thread-writer-locks', `${id}.lock`)).mtimeMs; } catch { return 0; } };
    for (const m of mine.filter((x) => !x.id)) {
      const since = (at) => (at >= m.since - 5000 ? at : 0);
      const t = (r?.rows ?? []).filter((x) => !taken.has(x.id) && sameDir(longPath(x.cwd), m.cwd))
        .map((x) => ({ x, at: since(x.made) || since(lockAt(x.id)) })).filter((c) => c.at).sort((a, b) => a.at - b.at)[0]?.x;
      if (t) { m.id = t.id; taken.add(t.id); gptMark(m); }
    }
    for (const t of r?.rows ?? []) {
      const cwd = longPath(t.cwd), title = String(t.name || t.title || t.first || t.preview || '').split('\n')[0].trim().slice(0, 100);
      if (!cwd || !title || !fs.existsSync(cwd)) continue;
      const prompt = String(t.preview ?? '').split('\n')[0].trim().slice(0, 200), m = mine.find((x) => x.id === t.id);
      out.push({ id: t.id, gpt: true, acct, home: g.home, cwd, title, prompt: prompt && prompt !== title ? prompt : null, at: t.up,
        model: t.model, effort: t.effort, pid: m?.pid ?? null, web: !!m?.web, since: m?.since ?? null, busy: false, wait: false });
    }
  });
  return out.sort((a, b) => b.at - a.at);
}
// A GPT conversation's record as the page's messages (as history() makes Claude's): Codex's items in the order it wrote
// them, by their place in its rollout (rollout_ordinal, as history's byte offsets): what you said, its replies (the ones on
// the way too: the page folds those into 过程), a line per tool call named as Claude's are (the page counts them by
// name); thinking and helper agents' doings left out. A turn's end, with how long it took, at its own place. In pieces as
// history's: {from} the newest, {end} what's before; the last `keep` messages first. One running (live): read up to an item
// of its turn in progress still being written (a reply mid-stream), which waits for the next read; one that died mid-turn
// left items unfinished for good, shown as they are. start 0: nothing before it.
const GPT_TOOL = { commandExecution: 'Bash', fileChange: 'Edit', webSearch: 'WebSearch', imageView: 'Read', mcpToolCall: 'MCP', dynamicToolCall: 'Tool', collabAgentToolCall: 'Agent' };
function gptHistory(home, id, { from, end, keep = 120, live = false } = {}) {
  const d = codexDb(home, 'thread_history_1.sqlite');
  let rows, turns, first, going;
  try {
    const shown = `item_type in ('userMessage', 'agentMessage', 'contextCompaction', ${Object.keys(GPT_TOOL).map((k) => `'${k}'`).join(', ')})`;
    const pick = `select rollout_ordinal o, turn_id tu, item_type k, created_at_ms at, completed_at_ms done, case item_type
      when 'userMessage' then json_extract(item_json, '$.content') when 'agentMessage' then json_extract(item_json, '$.text')
      when 'commandExecution' then json_extract(item_json, '$.command') when 'webSearch' then json_extract(item_json, '$.query')
      when 'fileChange' then item_json
      when 'imageView' then json_extract(item_json, '$.path') when 'mcpToolCall' then json_extract(item_json, '$.server') || '.' || json_extract(item_json, '$.tool')
      when 'dynamicToolCall' then json_extract(item_json, '$.tool') when 'collabAgentToolCall' then json_extract(item_json, '$.tool') end v
      from thread_items where thread_id = ? and ${shown}`;
    rows = from != null ? d.prepare(`${pick} and rollout_ordinal >= ? order by rollout_ordinal`).all(id, Number(from))
      : end != null ? d.prepare(`${pick} and rollout_ordinal < ? order by rollout_ordinal desc limit 1000`).all(id, Number(end)).reverse()
      : d.prepare(`${pick} order by rollout_ordinal desc limit 1000`).all(id).reverse();
    first = d.prepare(`select min(rollout_ordinal) o from thread_items where thread_id = ? and ${shown}`).get(id)?.o ?? 0;
    turns = d.prepare("select rollout_end_ordinal e, duration_ms ms from thread_turns where thread_id = ? and status != 'inProgress' and rollout_end_ordinal is not null and duration_ms > 0").all(id);
    const last = live ? d.prepare('select turn_id, status from thread_turns where thread_id = ? order by rollout_ordinal desc limit 1').get(id) : null;
    going = last?.status === 'inProgress' ? last.turn_id : null;
  } finally { d.close(); }
  const stop = going ? rows.findIndex((r) => r.done == null && r.tu === going) : -1, got = stop < 0 ? rows : rows.slice(0, stop);
  const hi = stop < 0 ? Infinity : rows[stop].o, lo = got[0]?.o ?? (from != null ? Number(from) : 0);
  const items = [];
  for (const r of got) {
    if (r.k === 'userMessage') {
      let parts = [];
      try { parts = JSON.parse(r.v ?? '[]'); } catch {}
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim(), pics = parts.filter((p) => /image/i.test(p.type)).length;
      if (text || pics) items.push({ role: 'user', text: [text, pics ? `🖼 ${pics} 张图片` : ''].filter(Boolean).join('\n'), at: r.at, o: r.o });
    } else if (r.k === 'agentMessage') { if (String(r.v ?? '').trim()) items.push({ role: 'claude', text: String(r.v).trim(), at: r.at, o: r.o }); }
    else if (r.k === 'contextCompaction') items.push({ role: 'note', text: '更早的内容已压缩', at: r.at, o: r.o });
    else if (r.k === 'fileChange') { // its files on the tool's line; done, each one's lines added and taken out (as Claude's Edit)
      let j = {};
      try { j = JSON.parse(r.v ?? '{}'); } catch {}
      const changes = Array.isArray(j.changes) ? j.changes : [];
      items.push({ role: 'tool', text: `Edit  ${changes.map((c) => c.path).join(', ').split('\n')[0].slice(0, 160)}`, at: r.at, o: r.o });
      if (j.status === 'completed') for (const c of changes) items.push({ role: 'edit', ...codexEdit(c), at: r.at, o: r.o });
    } else items.push({ role: 'tool', text: `${GPT_TOOL[r.k]}  ${String(r.v ?? '').split('\n')[0].slice(0, 160)}`, at: r.at, o: r.o });
  }
  for (const t of turns) if (t.e >= lo && t.e < hi && (from == null || t.e >= Number(from)) && (end == null || t.e < Number(end))) items.push({ role: 'done', text: String(t.ms), o: t.e });
  items.sort((a, b) => a.o - b.o);
  let start = 0;
  if (from == null) { // the newest messages, back to one of yours; more before them: where they begin
    let cut = 0;
    if (items.length > keep) { cut = items.length - keep; while (cut > 0 && items[cut].role !== 'user') cut--; }
    items.splice(0, cut);
    start = !items.length || (!cut && got[0]?.o === first) ? 0 : items[0].o;
  }
  const last = Math.max(-1, ...items.map((m) => m.o), from != null ? Number(from) - 1 : -1);
  return { items: items.map(({ o, ...m }) => m), start, end: hi === Infinity ? last + 1 : hi };
}
// A GPT account's usage, as Codex last heard it: each reply brings the plan's windows (how much of each is used, when it
// resets) into its record file; the newest conversation's file still there, the last of them in it. None yet: not read.
function gptUsage(home) {
  let paths = [];
  try {
    const d = codexDb(home, 'state_5.sqlite');
    try { paths = d.prepare('select rollout_path p from threads order by updated_at_ms desc limit 10').all().map((r) => longPath(r.p)); } finally { d.close(); }
  } catch {}
  const name = (w) => (w.window_minutes === 300 ? 'five_hour' : w.window_minutes === 10080 ? 'seven_day' : `${Math.round(w.window_minutes / 60)} 小时`);
  for (const f of paths) {
    let tail = '';
    try { const fd = fs.openSync(f, 'r'); try { tail = slice(fd, Math.max(0, fs.fstatSync(fd).size - 1048576), 1048576); } finally { fs.closeSync(fd); } } catch { continue; }
    const line = tail.split('\n').reverse().find((l) => l.includes('"rate_limits":{'));
    if (line) try {
      const r = JSON.parse(line).payload.rate_limits;
      return { plan: r.plan_type ?? null, windows: [r.primary, r.secondary].filter(Boolean).map((w) => ({ k: name(w), pct: Math.round(w.used_percent), reset: w.resets_at ? until(w.resets_at * 1000) : '' })) };
    } catch {}
  }
  return null;
}
// A GPT conversation as the 管家 and the phones need it, from its records: its last words of each kind (yours: who set its
// turn going, turnBy; its reply: what a note says), and its last turn's state ('inProgress' while at work). '' / null
// when unread (a write in flight, or none yet).
function gptLast(home, id, kind) {
  try {
    const d = codexDb(home, 'thread_history_1.sqlite');
    try {
      const v = d.prepare(`select json_extract(item_json, '${kind === 'userMessage' ? '$.content' : '$.text'}') v from thread_items where thread_id = ? and item_type = ? order by rollout_ordinal desc limit 1`).get(id, kind)?.v;
      if (kind !== 'userMessage') return String(v ?? '');
      try { return JSON.parse(v ?? '[]').filter((p) => p.type === 'text').map((p) => p.text).join('\n'); } catch { return ''; }
    } finally { d.close(); }
  } catch { return ''; }
}
// its last turn ({status, started: when, in ms}), or null
function gptTurn(home, id) {
  try {
    const d = codexDb(home, 'thread_history_1.sqlite');
    try { const r = d.prepare('select status, started_at s from thread_turns where thread_id = ? order by rollout_ordinal desc limit 1').get(id); return r ? { status: r.status, started: r.s * 1000 } : null; } finally { d.close(); }
  } catch { return null; }
}
// Codex's notify, which the web service sets on the ones it starts (-c notify=[node, this, notify, gpt, its CODEX_HOME]),
// its JSON the last argument: a turn over (agent-turn-complete), or a permission asked (approval-requested). As Claude's
// hooks do: the island's inbox and the notes the page and the phones read, named as the account's list names it. A helper
// agent's thread notifies nothing.
function notifyGpt(arg, home = process.env.CODEX_HOME) {
  let j;
  try { j = JSON.parse(arg); } catch { return; }
  const kind = j.type === 'agent-turn-complete' ? 'done' : j.type === 'approval-requested' ? 'ask' : null, id = j['thread-id'];
  if (!kind || !id) return;
  let t = null, read = false;
  try { const d = codexDb(home, 'state_5.sqlite'); try { t = d.prepare('select title, name, first_user_message first, cwd, source from threads where id = ?').get(id); read = true; } finally { d.close(); } } catch {}
  if (read && !t) return; // a temporary thread of Codex's own (naming its thread, reviewing a command): never saved, nothing to open
  if (/subagent/.test(t?.source ?? '')) return;
  const dir = longPath(t?.cwd) || j.cwd || '';
  // its Codex, by its marker (a click on the island's card finds its window by that pid): this thread's, or the one in its
  // folder not bound yet, which this binds
  const mine = home ? gptMarks().filter((m) => sameDir(m.home, home)) : [], m = mine.find((x) => x.id === id) ?? (dir && mine.find((x) => !x.id && sameDir(x.cwd, dir)));
  if (m && !m.id) gptMark({ ...m, id });
  dropNote({ kind, project: dir ? path.basename(dir) : '', msg: kind === 'done' ? '任务完成，等你下一步指示' : '需要你确认一下',
    title: String(t?.name || t?.title || t?.first || '').split('\n')[0].trim().slice(0, 100) || null, id, gpt: true }, m?.pid ?? null);
}

// --- Gemini: Google's Antigravity CLI (agy), signed in with a Google account, as a third kind of conversation (Windows
// only). Its accounts are A1, A2… (the registry's gemini). agy keeps its sign-in in one Credential Manager entry, so one
// account is on at a time (geminiOn), its sign-in in that entry; everything else (settings, MCP, plugins, conversations)
// is in your ~/.gemini, shared by all and never moved, so a conversation goes on with whichever is on (as Antigravity
// Manager does it). Each account's sign-in is kept in its folder in accounts\ (cm-login.dpapi: encrypted for this
// Windows user, all that's there); switching puts the other's in, only while no agy runs (a running one would go on as
// the new account, as it reads the entry again).
const GEMINI_HOME = path.join(HOME, '.gemini'), AGY_CRED = 'gemini:antigravity';
const geminiAccounts = (reg = load()) => reg.gemini ?? [];
const gemByName = (x, reg) => (/^a\d+$/i.test(x ?? '') ? geminiAccounts(reg)[Number(x.slice(1)) - 1] ?? null : null);
const gemLogin = (home) => path.join(home, 'cm-login.dpapi');
const AGY_GET = 'irm https://antigravity.google/cli/install.ps1 | iex';
function agyCmd() { // its installer's agy.exe (on the PATH, or where it puts it); CM_AGY: another program, for tests
  if (process.env.CM_AGY) return process.env.CM_AGY;
  if (!WIN) return null;
  const at = whereIs('agy'), own = path.join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe');
  return /\.exe$/i.test(at) ? at : fs.existsSync(own) ? own : null;
}
// a program run without holding up the web service: { status: 0, its exit code, or -1 (it never ran, or was stopped
// after 60 s), stdout }
const execA = (file, args, o = {}) => new Promise((ok) => require('child_process').execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, ...o },
  (e, stdout, stderr) => ok({ status: !e ? 0 : Number.isInteger(e.code) && !e.killed ? e.code : -1, stdout: stdout ?? '', stderr: stderr ?? '' })));
// (tasklist failing: as if one ran, so nothing switches blind)
const agyRunning = async () => { const r = await execA('tasklist', ['/fi', 'imagename eq agy.exe', '/fo', 'csv', '/nh']); return r.status !== 0 || /^"agy\.exe"/im.test(r.stdout); };
// The sign-in entry, read and written as agy's keyring library does (a generic credential, its user the part after the
// colon, its bytes as they are), never through this process: save (to CM_FILE, DPAPI), load (from it), drop, has, peek
// (its bytes, base64: only for the account's email). Exit 3: there's none.
const AGY_CRED_PS = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class CmCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public int WrittenLow; public int WrittenHigh;
    public int BlobSize; public IntPtr Blob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static byte[] Read(string t) {
    IntPtr p; if (!CredReadW(t, 1, 0, out p)) return null;
    try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); byte[] b = new byte[c.BlobSize]; Marshal.Copy(c.Blob, b, 0, b.Length); return b; }
    finally { CredFree(p); }
  }
  public static void Write(string t, string user, byte[] b) {
    CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = t; c.UserName = user; c.Persist = 2; c.BlobSize = b.Length; c.Blob = Marshal.AllocHGlobal(b.Length);
    try { Marshal.Copy(b, 0, c.Blob, b.Length); if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(); }
    finally { Marshal.FreeHGlobal(c.Blob); }
  }
  public static void Delete(string t) { CredDeleteW(t, 1, 0); }
}
'@
$t = $env:CM_CRED; $f = $env:CM_FILE; $me = [Security.Cryptography.DataProtectionScope]::CurrentUser
switch ($env:CM_OP) {
  'save' { $b = [CmCred]::Read($t); if ($null -eq $b) { exit 3 }
    [IO.File]::WriteAllText($f + '.tmp', [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $null, $me)))
    Move-Item -Force -LiteralPath ($f + '.tmp') -Destination $f }
  'load' { $b = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([IO.File]::ReadAllText($f).Trim()), $null, $me)
    [CmCred]::Write($t, $t.Substring($t.IndexOf(':') + 1), $b) }
  'drop' { [CmCred]::Delete($t); if ($null -ne [CmCred]::Read($t)) { exit 1 } }
  'has' { if ($null -eq [CmCred]::Read($t)) { exit 3 } }
  'peek' { $b = [CmCred]::Read($t); if ($null -eq $b) { exit 3 }; [Console]::Out.Write([Convert]::ToBase64String($b)) }
}`;
// (the script whole, as -EncodedCommand: its quotes never meet the command line's; CM_AGY_CRED: another entry, for tests)
const agyCred = (op, file = '') => execA('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(AGY_CRED_PS, 'utf16le').toString('base64')],
  { env: { ...process.env, CM_OP: op, CM_FILE: file, CM_CRED: process.env.CM_AGY_CRED || AGY_CRED } });
// Account g on: the one on before keeps its sign-in as agy last refreshed it, g's put in. Never
// while an agy runs; while the entry changes the registry says none is on (stopped there, the next switch saves no
// sign-in into the wrong account), g once its sign-in is in; one that can't be read leaves none on. One switch at a
// time. shortcut: one at a time in this process only (the web service and a start An at the same instant could
// interleave); add a lock file if that ever happens
let gemQ = Promise.resolve();
function gemOn(g, running = agyRunning) {
  const p = gemQ.then(() => gemSwitch(g, running));
  gemQ = p.catch(() => {});
  return p;
}
async function gemSwitch(g, running) {
  const reg = load(), all = geminiAccounts(reg), n = all.findIndex((x) => x.id === g.id) + 1;
  if (reg.geminiOn === g.id) return;
  if (await running()) throw new Error(`有 Gemini（agy）在运行：先结束它，才能换到 Gemini 账号 A${n}（同一时间只有一个 Gemini 账号在线）`);
  const was = all.find((x) => x.id === reg.geminiOn && x.id !== g.id);
  if (was && ![0, 3].includes((await agyCred('save', gemLogin(was.home))).status)) // 3: none there (signed out meanwhile): its file as it was
    throw new Error(`Gemini 账号 A${all.indexOf(was) + 1} 的登录没能存下来，没有切换`);
  update((x) => { x.geminiOn = null; });
  if ((await agyCred('load', gemLogin(g.home))).status !== 0) throw new Error(`Gemini 账号 A${n} 的登录读不出来：用 claude-multi new gemini 再登录一次这个 Google 账号`);
  update((x) => { x.geminiOn = g.id; });
  log('gemini_on', { profile_id: g.id });
}
// the signed-in account's email, asked of Google with its token (right after signing in: fresh)
async function gemWho() {
  try {
    const r = await agyCred('peek'), tok = JSON.parse(Buffer.from(r.stdout, 'base64').toString('utf8')).token?.access_token;
    if (r.status !== 0 || !tok) return null;
    const u = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(15000) });
    return u.ok ? (await u.json()).email ?? null : null;
  } catch { return null; }
}
// its status line (model, context used: the page's status bar), unless one of your own is set there; settings it can't
// read (not JSON) left as they are (trim: a BOM too). agy runs it through cmd with every quote handed on as it is, so the
// path goes bare. shortcut: a claude-multi whose path has a space gets none (ours taken out); its 8.3 name if one needs it
function gemSettings(home = GEMINI_HOME, script = __filename.replace(/\\/g, '/')) {
  const f = path.join(home, 'antigravity-cli', 'settings.json');
  let s = {};
  try { const t = fs.readFileSync(f, 'utf8').trim(); s = t ? JSON.parse(t) : {}; } catch (e) { if (e.code !== 'ENOENT') return; }
  if (s.statusLine && !String(s.statusLine.command ?? '').includes('claude-multi.js')) return;
  const { statusLine, ...rest } = s;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(/\s/.test(script) ? rest : { ...s, statusLine: { type: 'command', command: `node ${script} statusline` } }, null, 2) + '\n');
}
// new gemini: an account, signed in with Google in agy started bare (the only way it signs in: signed out, its models
// just says so); a browser, or its link opened anywhere and the code pasted back. Kept the moment agy has the sign-in
// (looked for every few seconds): however agy is left after, or its window closed, it's an account. Each time: a sign-in
// agy has already is never taken unasked (the first's: kept meanwhile, back if none is made). A Google account already
// here: its sign-in renewed. Not signed in: its folder gone, the one on before on again.
async function newGemini(running = agyRunning) {
  const agy = agyCmd();
  if (!agy) { console.log(`没找到 agy，先装好 Antigravity 的命令行（在 PowerShell 里）：${AGY_GET}`); return null; }
  process.on('SIGINT', () => {}); // Ctrl+C is agy's (signing in given up): this goes on, and puts back what was
  if (await running()) { console.log('有 Gemini（agy）在运行：先结束它，再加账号'); return null; }
  const reg = load(), first = !geminiAccounts(reg).length, was = geminiAccounts(reg).find((x) => x.id === reg.geminiOn);
  if (was && ![0, 3].includes((await agyCred('save', gemLogin(was.home))).status)) { console.log('现在在线的 Gemini 账号的登录没能存下来，先不加新账号'); return null; }
  let id, home;
  fs.mkdirSync(ACCOUNTS, { recursive: true });
  const day = new Date().toLocaleDateString('sv').replace(/-/g, '');
  for (let n = 1; ; n++) { // mkdir without recursive is the uniqueness check, as newGpt's
    id = `gemini-${day}-${String(n).padStart(3, '0')}`; home = path.join(ACCOUNTS, id);
    try { fs.mkdirSync(home); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  update((x) => { x.geminiOn = null; }); // the entry is no account's from here till it's this one's, or the one before's again
  // (the first's) agy's own sign-in, from before there were accounts: kept here till one is made, so one cut short (its
  // window closed) gets it back the next time; kept as it is when the entry has none to keep now
  const before = path.join(ACCOUNTS, 'gemini-before.dpapi');
  const back = async (why) => {
    console.log(why);
    if (first && (await agyCred('load', before)).status === 0) fs.rmSync(before, { force: true });
    if (!geminiAccounts().some((x) => x.id === id)) fs.rmSync(home, { recursive: true, force: true }); // only made now, never listed: a sign-in at most
    if (was && !(await running()) && (await agyCred('load', gemLogin(was.home))).status === 0) update((x) => { x.geminiOn = was.id; });
    log('gemini_failed', { profile_id: id });
    return null;
  };
  try {
    if (first && ![0, 3].includes((await agyCred('save', before)).status)) return back('agy 现在的登录没能先存下来，没有加账号');
    if ((await agyCred('drop')).status !== 0) return back('agy 现在的登录没能清掉（不清掉它就会直接拿来用），没有加账号'); // so agy asks for one
    log('gemini_created', { profile_id: id });
    console.log('接下来打开 agy：在里面选用 Google 账号登录（会打开浏览器；没打开就把它给的网址复制到浏览器里，登好把授权码粘回去）。\n'
      + '登录成功就已经存好了。之后输入 /exit 退出 agy（或连按两次 Ctrl+D），这里会告诉你存成了哪个账号。');
    // what's said once agy is left (agy's screen till then); null: no sign-in kept
    const keep = async () => {
      if ((await agyCred('save', gemLogin(home))).status !== 0) return null;
      fs.rmSync(before, { force: true });
      const email = await gemWho(), all = geminiAccounts(), d = email ? all.findIndex((x) => x.email === email) : -1;
      if (d >= 0) { // an account here already (its saved sign-in unreadable, say): this its sign-in now, it on; the new folder (only made now) gone
        fs.copyFileSync(gemLogin(home), gemLogin(all[d].home));
        update((x) => { x.geminiOn = all[d].id; });
        fs.rmSync(home, { recursive: true, force: true });
        log('gemini_relogin', { profile_id: all[d].id });
        return `Gemini 账号 A${d + 1}（${email}）重新登录好了，现在在线的就是它`;
      }
      try { gemSettings(); } catch {} // (no status line: no reason to lose the sign-in)
      const r = update((x) => { (x.gemini ??= []).push({ id, label: email || 'Google 账号', email, home, createdAt: now() }); x.geminiOn = id; });
      log('gemini_registered', { profile_id: id });
      return `已保存 Gemini 账号 A${r.gemini.length}：${email || 'Google 账号'}（现在在线的就是它）`
        + (email ? '' : `\n没查到这个 Google 账号的邮箱（可能连不上 googleapis.com），先叫它「Google 账号」。同一个号别再加一次；加重了用 claude-multi remove A${r.gemini.length} 去掉`);
    };
    const child = require('child_process').spawn(agy, [], { stdio: 'inherit' });
    let over = false, said = null;
    const ended = new Promise((ok) => { child.on('exit', ok); child.on('error', ok); }).then(() => { over = true; });
    for (;;) {
      const last = over; // (agy gone before this look: the last one)
      if ((await agyCred('has')).status === 0) { said = await keep(); break; }
      if (last) break;
      await Promise.race([ended, sleep(3000)]);
    }
    await ended;
    if (!said) return back('还没检测到登录成功，没有加上账号');
    console.log(said);
    return true;
  } catch (e) { return back(`没加上：${e.message}`); }
}
// remove An: Gemini account n leaves the list, its folder (its sign-in alone) to the Recycle Bin. The one on: none on
// after (agy's entry keeps its sign-in till another's is put in; a running agy goes on with it)
function removeGemini(n) {
  const g = geminiAccounts()[n - 1];
  if (!g) { console.log('没有这个 Gemini 账号：用 claude-multi list 看编号（A1、A2…）'); process.exit(1); }
  canRecycle();
  update((r) => { r.gemini = (r.gemini ?? []).filter((x) => x.id !== g.id); if (r.geminiOn === g.id) r.geminiOn = null; });
  log('gemini_removed', { profile_id: g.id });
  const r = recycle([g.home]);
  if (fs.existsSync(g.home)) console.log(`已移除 Gemini 账号 ${g.label}，但文件夹没能放进回收站（${(r.stderr || '').trim().split('\n')[0]}），可以之后手动删：${g.home}`);
  else console.log(`已移除 Gemini 账号 ${g.label}，文件夹在回收站里。`);
}
// agy's / commands, as its own menu lists them (they're listed nowhere else): read off its screen once per agy (a new
// one: again), its menu typed open in a pseudo-terminal in your home folder and gone down to its end, each its name and
// what it does. Only with an account on (signed out, started bare it would ask you to sign in). Nothing sent, no model
// asked. shortcut: plugins added later show up after the next agy update or a web restart
let agyCmds = null;
function agySlash() {
  const agy = agyCmd();
  if (!agy || !WIN || !load().geminiOn) return Promise.resolve([]);
  let mt = 0;
  try { mt = fs.statSync(agy).mtimeMs; } catch {}
  if (agyCmds?.mt === mt) return agyCmds.list;
  const list = new Promise((ok) => {
    const { Terminal } = require('@xterm/headless'), t = new Terminal({ cols: 160, rows: 50, allowProposedApi: true });
    let p;
    try { p = require('@lydell/node-pty').spawn(agy, ['--settings', JSON.stringify({ trustedWorkspaces: [HOME] })], { name: 'xterm-256color', cols: 160, rows: 50, cwd: HOME, env: process.env }); } catch { return ok([]); }
    p.onData((d) => t.write(d));
    const rows = () => { const b = t.buffer.active, out = []; for (let y = 0; y < 50; y++) out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? ''); return out; };
    const got = new Map();
    let n = 0, ready = 0, still = 0;
    const go = setInterval(() => { // every 0.1 s: its box up (a few seconds after, settled), its notice away, /, then ↓ till nothing new
      n++;
      const r = rows();
      if (!ready) { if (r.some((x, i) => /^─{20}/.test(x) && /^>/.test(r[i + 1] ?? ''))) ready = n; else if (n > 150) end(); return; }
      if (n - ready === 30) p.write('\x1b'); // (apart from the /: Esc and / together read as Alt+/)
      if (n - ready === 36) p.write('/');
      if (n - ready <= 40) return;
      const was = got.size;
      // 「> /clear (new)   Clear conversation…」: its name, its other names in brackets, what it does
      for (const x of r) { const m = /^[>\s]\s*\/(\S+)(?: \(([^)]*)\))?\s{2,}(\S.*?)\s*$/.exec(x); if (m) got.set(m[1], { desc: m[3], also: m[2] ? m[2].split(/,\s*/) : [] }); }
      still = got.size === was ? still + 1 : 0;
      if ((still > 8 && got.size) || n > 400) end();
      else p.write('\x1b[B');
    }, 100);
    function end() {
      clearInterval(go);
      require('child_process').execFile('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }, () => {});
      ok([...got].map(([name, x]) => ({ name, desc: x.desc, hint: '', also: x.also, builtin: true })));
    }
  });
  agyCmds = { mt, list };
  list.then((l) => { if (!l.length) agyCmds = null; }); // (none read: tried again next time)
  return list;
}
// start An: agy on that account here, in this terminal (switched on first)
async function runGem(g, args = []) {
  const agy = agyCmd();
  if (!agy) { console.log(`没找到 agy，先装好 Antigravity 的命令行（在 PowerShell 里）：${AGY_GET}`); process.exit(1); }
  try { await gemOn(g); } catch (e) { console.log(e.message); process.exit(1); }
  console.log(`使用 Gemini 账号：${g.label}\n正在启动 agy……`);
  process.on('SIGINT', () => {});
  const child = require('child_process').spawn(agy, args, { stdio: 'inherit' });
  child.on('error', (e) => { console.error(`无法启动 agy：${e.message}`); process.exit(1); });
  child.on('exit', (code) => process.exit(code ?? 1));
}
// A Gemini conversation's record: agy's transcript.jsonl in its brain folder, a step a line, as agy's own swarm board
// reads it (builtin\plugins\swarm\sidecars\swarm_board\main.mjs): step_index, type, source, status, created_at to the
// second. USER_INPUT: yours (source USER_EXPLICIT), your words between <USER_REQUEST> tags. PLANNER_RESPONSE: the
// model's, logged only once it's done: content, tool_calls [{name, args}] (string args JSON-quoted). GENERIC: a tool
// call's result (RUNNING for one sent to the background, for good). Also SYSTEM_MESSAGE, ERROR_MESSAGE. A turn is over
// when its newest step is a reply calling no tool. Read again only once it changed (a line still being written left out
// till then); the last 30 read kept. shortcut: read whole on each change; read its tail if one grows to megabytes
const gemSaid = (c) => String(/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(c ?? '')?.[1] ?? c ?? '').trim();
const gemCalls = (s) => (s?.type === 'PLANNER_RESPONSE' && Array.isArray(s.tool_calls) ? s.tool_calls : []);
const gemReads = new Map();
function gemSteps(id) {
  if (!/^[\w-]{1,80}$/.test(id ?? '')) return [];
  const f = path.join(GEMINI_HOME, 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  let mt = 0;
  try { mt = fs.statSync(f).mtimeMs; } catch { return []; }
  const r = gemReads.get(id);
  gemReads.delete(id);
  if (r?.mt === mt) return gemReads.set(id, r), r.steps;
  // a field over 4 KB is cut there (its first and last 2 KB, 「<truncated N bytes>」 between, truncated_fields naming it):
  // whole on the same line of transcript_full.jsonl. Taken from there for what's shown (yours, its replies and calls, an
  // error), not for a tool's result (only its first line is read: up to tens of KB each, kept for 30 conversations)
  let steps, full;
  const whole = (s, i) => {
    if (!s.truncated_fields || s.type === 'GENERIC') return s;
    if (full === undefined) try { full = fs.readFileSync(f.replace(/transcript\.jsonl$/, 'transcript_full.jsonl'), 'utf8').split('\n'); } catch { full = []; }
    try { const w = JSON.parse(full[i]); return w.step_index === s.step_index ? w : s; } catch { return s; } // (still being written: as it is)
  };
  try { steps = fs.readFileSync(f, 'utf8').split('\n').flatMap((l, i) => { try { return [whole(JSON.parse(l), i)]; } catch { return []; } }); } catch { return r?.steps ?? []; }
  steps.sort((a, b) => a.step_index - b.step_index);
  gemReads.set(id, { mt, steps });
  if (gemReads.size > 30) gemReads.delete(gemReads.keys().next().value);
  return steps;
}
// a Gemini conversation's last words of yours (mine) or its last reply: a note's gist, the 管家's look; '' for none
function gemLast(id, mine = false) {
  const s = gemSteps(id).findLast((x) => (mine ? x.type === 'USER_INPUT' && x.source === 'USER_EXPLICIT' : x.type === 'PLANNER_RESPONSE' && String(x.content ?? '').trim()));
  return s ? (mine ? gemSaid(s.content) : String(s.content).trim()) : '';
}
// what the list needs of one (its record read only once it changed): your first message and when, your last one's time,
// its last step's time, and what it's at by that step: 'busy' (a turn not over: yours just in, a tool called or its
// result, the model on it again) or 'wait' (a step waiting on you, if agy ever logs one so: its questions are in its log,
// not here) or null; err: the error its turn stopped on
const gemSums = new Map();
function gemSum(id) {
  let mt = 0;
  try { mt = fs.statSync(path.join(GEMINI_HOME, 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')).mtimeMs; } catch {}
  const r = gemSums.get(id);
  if (r?.mt === mt) return r.sum;
  const steps = gemSteps(id), yours = steps.filter((x) => x.type === 'USER_INPUT' && x.source === 'USER_EXPLICIT'), you = yours[0], last = steps[steps.length - 1];
  const sum = you ? { first: gemSaid(you.content).split('\n')[0].trim(), made: gemTime(you.created_at), said: gemTime(yours.at(-1).created_at), lastAt: gemTime(last.created_at),
    going: last.status === 'WAITING' ? 'wait' : (last.type === 'PLANNER_RESPONSE' && !gemCalls(last).length) || last.type === 'ERROR_MESSAGE' ? null : 'busy', n: steps.length,
    err: last.type === 'ERROR_MESSAGE' ? String(last.error ?? last.content ?? '').split('\n')[0].slice(0, 200) || '出错了' : null } : null;
  gemSums.set(id, { mt, sum });
  return sum;
}
// a turn of its over, by an agy that began at since: its steps then (each turn's end told once by that), else null
const gemEnded = (s, since) => (s && !s.going && s.lastAt >= since - 1000 ? s.n : null);
// The Gemini conversations each agy running holds (here or in a terminal window: start An, or agy itself), by agy's own
// log: one per agy (log\cli-<started>.log), its first line its pid (「…process with pid 9604」), a line naming each
// conversation it creates, resumes or sends to: the last of them its own now (a /clear or /resume there moves it on; a
// helper agent's, one with a parent, isn't). pids: the agy running to look for. A log's pid read once; what it adds as it
// grows. → Map id → { pid, since (its start), cut (its last turn cut short, or 0), ask (a question up now: { at, kind }) }
// What agy 1.5 logs, each line's time first (I1120 23:11:36.137628 …):
//   its own:      Created / Resuming / Streaming / Forwarding user message to / Sending user message to conversation <id>,
//                 Forked conversation <id> -> <new id>
//   Esc:          Cancelling in-progress response for conversation <id>   (the record says nothing of it)
//   a question:   Surfacing tool confirmation: "Bash" at step 13 · Surfacing ask_question at step 2
//   answered:     Responding to tool confirmation: convID=… · AskQuestion response for conversation …
//   a helper's:   Starting new conversation (agent=true) before its Created (yours: agent=false); or its row in agy's
//                 list has a parent. shortcut: a helper agy starts some other way, its row not written yet, is taken for its own
const gemLogPid = new Map(), gemLogTail = new Map();
const gemChild = (id) => { if (!gemHead) listGemini(); return !!gemHead?.rows.find((r) => r.id === id)?.parent; };
const GEM_LINE = /^[IWE](\d\d)(\d\d) (\d\d):(\d\d):(\d\d\.\d{3})\d*\s+\d+ \S+\] (?:(Created|Resuming|Streaming|Forwarding user message to|Sending user message to) conversation ([0-9a-f-]{36})|Forked conversation [0-9a-f-]{36} -> ([0-9a-f-]{36})|Cancelling in-progress response for conversation ([0-9a-f-]{36})|Surfacing (tool confirmation|ask_question)|(Responding to tool confirmation|AskQuestion response)|Starting new conversation \(agent=(true|false)\))/gm;
function gemAgyConvs(pids, child = gemChild) {
  const out = new Map(), dir = path.join(GEMINI_HOME, 'antigravity-cli', 'log');
  if (!pids.size) return out;
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^cli-\d{8}_\d{6}\.log$/.test(f)).sort().reverse(); } catch { return out; } // newest first: a pid an older agy had too is the newest log's
  const seen = new Set();
  for (const f of files) {
    let pid = gemLogPid.get(f);
    if (pid === undefined) {
      try { const fd = fs.openSync(path.join(dir, f), 'r'); try { pid = +(/process with pid (\d+)/.exec(slice(fd, 0, 400))?.[1] ?? 0); } finally { fs.closeSync(fd); } } catch { pid = 0; }
      gemLogPid.set(f, pid);
    }
    if (!pids.has(pid) || seen.has(pid)) continue;
    seen.add(pid);
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
    // what it added since the last read, line by line in order (a line cut there read again whole: each sets what it
    // says, so twice is once); the first time, all of it: an agy idle for hours named its conversation long before its
    // last 256 KB. Times by the line's own month and day, the log's year. shortcut: 16 MB at most then, an agy days on in one log may outrun it
    const c = gemLogTail.get(f), on = c && c.size < st.size, m = /^cli-(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)/.exec(f); // on: grown since (else new, or begun anew)
    let s = on || c?.size === st.size ? c : { id: null, cut: null, ask: null, agent: false, helpers: [] };
    if (c?.size !== st.size) try {
      const from = on ? Math.max(0, c.size - 200) : Math.max(0, st.size - 16777216), fd = fs.openSync(path.join(dir, f), 'r');
      try {
        s = { ...s, helpers: [...s.helpers] };
        for (const k of slice(fd, from, st.size - from).matchAll(GEM_LINE)) {
          const at = new Date(+m[1] + (+k[1] < +m[2] ? 1 : 0), k[1] - 1, +k[2], +k[3], +k[4]).getTime() + Math.round(k[5] * 1000);
          const to = k[7] ?? k[8];
          if (k[12]) s.agent = k[12] === 'true';
          else if (to) {
            if (k[6] === 'Created' && s.agent) { s.agent = false; if (!s.helpers.includes(to)) s.helpers = [...s.helpers, to].slice(-50); }
            else if (!s.helpers.includes(to) && !child(to)) { s.id = to; if (k[6] !== 'Streaming') s.ask = null; }
          }
          else if (k[9]) { s.cut = { id: k[9], at }; s.ask = null; }
          else if (k[10]) s.ask = { at, kind: k[10] === 'ask_question' ? 'question' : 'tool' };
          else if (k[11]) s.ask = null;
        }
      } finally { fs.closeSync(fd); }
      gemLogTail.set(f, { size: st.size, ...s });
    } catch {} // (unread: as it was, read again next time)
    if (s?.id) out.set(s.id, { pid, since: new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(), cut: s.cut?.id === s.id ? s.cut.at : 0, ask: s.ask });
  }
  return out;
}
// A Gemini conversation renamed: claude-multi's own name for it (gem-titles.json, what the list shows), and agy's (its
// list, for its own /resume) when it isn't running here. Deleted: its record and its files to the Recycle Bin, its row
// out of agy's list (not while it runs here: the web service checks)
const GEM_TITLES = path.join(ROOT, 'gem-titles.json');
const gemTitles = () => { try { return JSON.parse(fs.readFileSync(GEM_TITLES, 'utf8')); } catch { return {}; } };
const gemTitlesSave = (t) => { fs.writeFileSync(`${GEM_TITLES}.tmp`, JSON.stringify(t)); fs.renameSync(`${GEM_TITLES}.tmp`, GEM_TITLES); };
function gemDb(sql, ...args) { // agy's list written (it waits a moment for an agy writing it too)
  const { DatabaseSync } = require('node:sqlite'), d = new DatabaseSync(path.join(GEMINI_HOME, 'antigravity-cli', 'conversation_summaries.db'));
  try { d.exec('PRAGMA busy_timeout = 3000'); return d.prepare(sql).run(...args); } finally { d.close(); }
}
function gemRename(id, name, running = false) {
  if (!/^[\w-]{1,80}$/.test(id)) throw new Error('找不到这个对话');
  gemTitlesSave({ ...gemTitles(), [id]: name });
  if (!running) try { gemDb('update conversation_summaries set title = ? where conversation_id = ?', name, id); } catch {}
  gemHead = null;
  return { said: `已改名：${name}` };
}
async function gemDelete(id, bin = recycle) {
  if (!/^[\w-]{1,80}$/.test(id)) throw new Error('找不到这个对话');
  const a = path.join(GEMINI_HOME, 'antigravity-cli'), title = listGemini().find((x) => x.id === id)?.title ?? '这个对话';
  const files = [path.join(a, 'brain', id), ...['', '-wal', '-shm'].map((x) => path.join(a, 'conversations', `${id}.db${x}`)),
    path.join(a, 'annotations', `${id}.pbtxt`), path.join(a, 'presence', `${id}.lock`)].filter((p) => fs.existsSync(p));
  const r = files.length ? await bin(files) : { status: 0 };
  if (r.status !== 0 || files.some((p) => fs.existsSync(p))) throw new Error(`删除失败：${(r.stderr || '').trim().split('\n')[0] || '可能有 agy 开着它的文件'}`);
  try { gemDb('delete from conversation_summaries where conversation_id = ?', id); } catch {}
  const t = gemTitles();
  if (t[id]) { delete t[id]; gemTitlesSave(t); }
  gemHead = null; gemReads.delete(id); gemSums.delete(id);
  log('gemini_deleted', { session_id: id });
  return { said: `已删除「${title}」，可以在回收站里找回。` };
}
// The Gemini conversations, once there's an account: ~/.gemini's (its conversation_summaries.db) with something you said
// in it (its record: the first is its title till agy gives one), not a helper agent's, their folder still there; newest
// first; each on the account on (any goes on with it). The list read again only once the db changed; a read that fails
// (a write in flight) keeps the last. going, lastAt: what it's at, for one an agy runs here (since it started)
let gemHead = null;
const gemTime = (s) => { const t = Date.parse(String(s ?? '').replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')); return t > 0 ? t : 0; };
function listGemini(reg = load()) {
  const out = [], mt = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }, all = geminiAccounts(reg);
  if (all.length) {
    const acct = Math.max(0, all.findIndex((g) => g.id === reg.geminiOn)), dir = path.join(GEMINI_HOME, 'antigravity-cli');
    const at = Math.max(0, ...['conversation_summaries.db', 'conversation_summaries.db-wal'].map((x) => mt(path.join(dir, x))));
    if (at && gemHead?.at !== at) try {
      const d = codexDb(dir, 'conversation_summaries.db');
      try { gemHead = { at, rows: d.prepare('select conversation_id id, title, last_modified_time up, workspace_uris ws, parent_conversation_id parent from conversation_summaries').all() }; } finally { d.close(); }
    } catch {}
    const named = gemTitles();
    for (const t of gemHead?.rows ?? []) {
      if (t.parent) continue;
      let cwd = '';
      try { cwd = require('url').fileURLToPath(JSON.parse(t.ws)[0]); } catch {}
      if (!cwd || !fs.existsSync(cwd)) continue;
      const s = gemSum(t.id);
      if (!s) continue;
      const title = String(named[t.id] || t.title || s.first).split('\n')[0].trim().slice(0, 100);
      out.push({ id: t.id, gem: true, acct, cwd, title, prompt: s.first && s.first !== title ? s.first.slice(0, 200) : null,
        at: Math.max(gemTime(t.up), s.lastAt), made: s.made, said: s.said, pid: null, busy: false, wait: false, going: s.going, lastAt: s.lastAt });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
// A Gemini conversation's record as the page's messages (as gptHistory makes a GPT one's): what you said, its replies, a
// line per tool it called named as Claude's are (the page counts them by name; its results not shown), a model error as
// a note; a turn's end (about how long it took: its steps' times are to the second) with the reply that ends it, or by
// your next message, or once it's no longer running (one cut short). By step_index, in pieces as history's: a model
// step is logged whole, so nothing waits for a next read.
const GEM_TOOL = [[/command|shell|terminal/i, 'Bash'], [/write|replace|edit|patch|create_file|delete/i, 'Edit'], [/view|read_file|list_dir|open_file/i, 'Read'],
  [/search_web|web_search/i, 'WebSearch'], [/grep|find|search/i, 'Grep'], [/url|fetch|browser/i, 'WebFetch']];
const gemArg = (v) => { const s = typeof v === 'string' ? v.trim() : ''; if (/^".*"$/s.test(s)) try { return String(JSON.parse(s)); } catch {} return s; };
function gemTool(c) {
  const name = String(c?.name ?? ''), a = c?.args && typeof c.args === 'object' ? c.args : {};
  const what = ['CommandLine', 'Command', 'AbsolutePath', 'TargetFile', 'Path', 'Query', 'Url', 'toolSummary', 'toolAction'].map((k) => gemArg(a[k])).find(Boolean)
    ?? Object.values(a).map(gemArg).find(Boolean) ?? '';
  return `${GEM_TOOL.find(([re]) => re.test(name))?.[1] ?? name}  ${what.split('\n')[0].slice(0, 160)}`.trim();
}
// a file one of its tools changed (written whole, or a part replaced): its path, the lines added and taken out (as
// agy's result says, 「(+1/-1 lines)」, else counted off the call), for the turn's 改动 card as a GPT one's
const GEM_EDIT = /write_file|edit_file|replace|create_file/i;
function gemEdit(c, r) {
  const a = c?.args && typeof c.args === 'object' ? c.args : {}, file = gemArg(a.Path ?? a.TargetFile ?? a.AbsolutePath);
  if (!GEM_EDIT.test(c?.name ?? '') || !file) return null;
  const lines = (v) => { const s = gemArg(v); return s ? s.replace(/\n$/, '').split('\n').length : 0; }, said = /\(\+(\d+)\/-(\d+) lines?\)/.exec(String(r?.content ?? ''));
  return { text: file, add: said ? +said[1] : lines(a.Content ?? a.Replacement ?? a.CodeContent), del: said ? +said[2] : lines(a.Target) };
}
function gemHistory(id, { from, end, keep = 120, live = false } = {}) {
  const got = gemSteps(id);
  let items = [], turn = null, calls = []; // the turn going (when it began, its last step's time); the calls of the last reply not answered yet
  const over = (o) => { if (turn) items.push({ role: 'done', text: String(Math.max(1000, turn.last - turn.at)), o }); turn = null; };
  for (const s of got) {
    const o = s.step_index, at = gemTime(s.created_at);
    if (s.type === 'USER_INPUT') {
      if (s.source !== 'USER_EXPLICIT') continue;
      over(o); turn = { at, last: at };
      const text = gemSaid(s.content);
      if (text) items.push({ role: 'user', text, at, o });
    } else if (s.type === 'PLANNER_RESPONSE' || s.type === 'ERROR_MESSAGE') {
      if (turn) turn.last = at; else turn = { at, last: at }; // (going on by itself: after a background task, say)
      if (s.type === 'ERROR_MESSAGE') { items.push({ role: 'note', text: `出错了：${String(s.error ?? s.content ?? '').split('\n')[0].slice(0, 200)}`, at, o }); over(o); continue; }
      if (String(s.content ?? '').trim()) items.push({ role: 'claude', text: String(s.content).trim(), at, o });
      for (const c of gemCalls(s)) items.push({ role: 'tool', text: gemTool(c), at, o });
      calls = [...gemCalls(s)];
      if (!calls.length) over(o);
    } else if (s.type === 'GENERIC') { // a call's result (in the order called): a file changed, on the turn's card
      const c = calls.shift(), e = s.status === 'DONE' && gemEdit(c, s);
      if (e) items.push({ role: 'edit', ...e, at, o });
    } else if (s.type === 'SYSTEM_MESSAGE') { // a background task of its own over (it goes on by itself then): a line, as a Claude one's
      const t = /sender=\S+\/task-\d+\b[^\n]*?content=Task id "[^"]+" (\w+)[^\n]*(?:\n([^\n]+))?/.exec(String(s.content ?? ''));
      if (t) items.push({ role: 'note', text: `⏳ 后台的事${t[1] === 'finished' ? '有结果了' : '结束了'}${t[2]?.trim() ? `：${t[2].trim().slice(0, 120)}` : ''}`, at, o });
    }
  }
  if (!live) over((got[got.length - 1]?.step_index ?? 0) + 0.5);
  items = items.filter((m) => (from == null || m.o >= Number(from)) && (end == null || m.o < Number(end)));
  let start = 0;
  if (from == null && items.length > keep) { // the newest messages, back to one of yours; more before them: where they begin
    let cut = items.length - keep;
    while (cut > 0 && items[cut].role !== 'user') cut--;
    if (cut > 0 && items[cut - 1].role === 'done' && items[cut - 1].o === items[cut].o) cut--; // (a turn cut short: its end by your next message, with it)
    items = items.slice(cut); start = cut ? items[0].o : 0;
  }
  const last = Math.max(-1, ...got.map((s) => s.step_index), from != null ? Number(from) - 1 : -1);
  return { items: items.map(({ o, ...m }) => m), start, end: last + 1 };
}

// --- GPT 聊天:OpenAI's strongest model (GPT-6 Astra) over the API with your key (openai-key.txt here), as a plain chat:
// no folder, no commands, so not Codex. Its mode and effort picked in the page for each message: pro mode is ChatGPT's
// GPT-6 Pro. Each chat is oai\<id>.json (its messages as the page shows them) and oai\<id>\ (the pictures and files sent
// in it, out of uploads\, which is emptied after a week). OpenAI keeps what was said (store), each message going on from
// the last answer (previous_response_id): pictures and files are sent once. An answer is made at OpenAI in the background
// (a hard one takes minutes): its id kept in the chat (pending) and asked after by the web service till it's done,
// through a restart, the page there or not. (As LibreChat does it, without its own long-running jobs: OpenAI's background
// mode holds the answer for us.)
const OAI = path.join(ROOT, 'oai'), OAI_KEY = path.join(ROOT, 'openai-key.txt');
const OAI_MODEL = 'gpt-6-astra', OAI_MODES = ['standard', 'pro'], OAI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']; // what it takes
const OAI_OPTS = { mode: 'standard', effort: 'medium' }; // a chat's, till one is picked: OpenAI's own default effort
// what OpenAI takes, by the name's end: pictures as pictures, these as files; any other text file as text/plain (its own
// type, or application/octet-stream, is refused)
const OAI_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const oaiPic = (p) => /^image\//.test(OAI_TYPES[path.extname(p).slice(1).toLowerCase()] ?? '');
const oaiName = (p) => /^\d{8}T\d{6}-[0-9a-f]{6}-(.+)$/.exec(path.basename(p))?.[1] ?? path.basename(p); // as uploaded
async function oaiApi(p, body) {
  let key = '';
  try { key = fs.readFileSync(OAI_KEY, 'utf8').trim(); } catch {} // trim takes a BOM too (Notepad's)
  if (!key) throw new Error('还没有 OpenAI 的 key：存进 .claude-multi\\openai-key.txt');
  const r = await fetch(`https://api.openai.com/v1/${p}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI：${j.error?.message ?? r.status}`);
  return j;
}
// a message as OpenAI takes it: your words, then each picture and file
function oaiInput(text, files = []) {
  const parts = text ? [{ type: 'input_text', text }] : [];
  for (const p of files) {
    const data = fs.readFileSync(p), type = OAI_TYPES[path.extname(p).slice(1).toLowerCase()] ?? (data.subarray(0, 8192).includes(0) ? null : 'text/plain');
    if (!type) throw new Error(`${oaiName(p)}：GPT 读不了这种文件（图片、PDF、Word、Excel、PPT 和文本文件可以）`);
    const url = `data:${type};base64,${data.toString('base64')}`;
    parts.push(type.startsWith('image/') ? { type: 'input_image', image_url: url } : { type: 'input_file', filename: oaiName(p), file_data: url });
  }
  return parts;
}
// an answer's words (its sources are links in them already)
const oaiText = (r) => (r.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).map((c) => c.text ?? c.refusal ?? '').join('\n\n').trim();
const oaiRead = (id) => {
  if (!/^oai-\d+$/.test(id ?? '')) throw new Error('没有这个对话');
  try { return JSON.parse(fs.readFileSync(path.join(OAI, `${id}.json`), 'utf8')); } catch { throw new Error('找不到这个对话'); }
};
const oaiSave = (c) => { fs.mkdirSync(OAI, { recursive: true }); const f = path.join(OAI, `${c.id}.json`); fs.writeFileSync(`${f}.tmp`, JSON.stringify(c)); fs.renameSync(`${f}.tmp`, f); };
// ponytail: every chat's file read for each look at the list (every 5 s a page is open); a small index of them if there are hundreds
const oaiChats = () => ls(OAI).filter((f) => /^oai-\d+\.json$/.test(f)).flatMap((f) => { try { return [JSON.parse(fs.readFileSync(path.join(OAI, f), 'utf8'))]; } catch { return []; } });
// as the CLI lists them (the 管家's sessions --all, chat look / say): no folder, no account, none running (busy: an
// answer pending at OpenAI)
const oaiList = () => oaiChats().map((c) => ({ id: c.id, title: c.title, at: c.at, cwd: '', acct: -1, oai: true, pid: null, busy: !!c.pending, who: 'GPT 聊天' }));
const oaiLast = (c) => c.msgs.findLast((m) => m.role === 'claude')?.text ?? ''; // its last answer
const oaiHow = (o) => `${o.mode === 'pro' ? 'Pro' : '普通'} · ${o.effort}`;
// the 管家's message to one (s), or the first of a new one (s null): through the web service, as the page sends it (one
// at a time in a chat: that lock is there), with the mode and effort asked for, else the chat's last, else 普通 · 中
async function oaiSay(s, text, ask = {}) {
  if (!text) throw new Error('要问什么？');
  const c = s ? oaiRead(s.id) : null, opts = { ...OAI_OPTS, ...c?.opts };
  for (const k of ['mode', 'effort']) if (ask[k]) opts[k] = ask[k];
  if (!OAI_MODES.includes(opts.mode) || !OAI_EFFORTS.includes(opts.effort)) throw new Error(`--mode 是 ${OAI_MODES.join(' 或 ')}，--effort 是 ${OAI_EFFORTS.join('、')} 之一`);
  if (c?.pending) throw new Error(`「${s.title}」还在回答上一条：它答完网页服务会告诉你，之后再发`);
  const { id } = await webPost('/api/oai/send', { id: s?.id, text, ...opts }), cut = text.length > 40 ? text.slice(0, 40) + '…' : text;
  blog(s ? `给「${s.title}」发了消息：${cut}` : `新开了对话（GPT 聊天）：${cut}`, id);
  console.log(`${s ? `已发给「${s.title}」` : `已新开 GPT 聊天，编号 ${id}`}（${oaiHow(opts)}），它在想了：答完网页服务会告诉你。`);
  return { id, title: s?.title ?? '' };
}
// a chat's messages as the page's 对话 view takes a record's: a picture by where it is (msg.file), a file as 附件：path
function oaiItems(c) {
  return c.msgs.flatMap((m, i) => m.role !== 'user' ? [{ role: m.role, text: m.text, at: m.at }, ...(m.took ? [{ role: 'done', text: String(m.took) }] : [])]
    : [...(m.files ?? []).flatMap((p, k) => (oaiPic(p) ? [{ role: 'img', text: `${i}.${k}`, at: m.at }] : [])),
      { role: 'user', text: [m.text, ...(m.files ?? []).filter((p) => !oaiPic(p)).map((p) => `附件：${p}`)].filter(Boolean).join('\n'), at: m.at }]);
}
// one message sent, with the mode and effort picked (kept on the chat: the page shows them again): to OpenAI first
// (refused, nothing is kept), then into the chat, its answer pending. One already being sent (or answered) in that chat:
// not a second (its answer would be lost to the chat, and paid for)
const oaiSending = new Set();
async function oaiSend(b) {
  const text = String(b.text ?? '').trim(), ups = (Array.isArray(b.paths) ? b.paths : []).map((p) => path.resolve(String(p)));
  if (!text && !ups.length) throw new Error('要发什么？');
  if (ups.some((p) => path.dirname(p) !== UPLOADS)) throw new Error('只能发从这里传上去的图片和文件');
  if (!OAI_MODES.includes(b.mode) || !OAI_EFFORTS.includes(b.effort)) throw new Error('模式或思考强度不对');
  const old = b.id ? oaiRead(String(b.id)) : null, id = old?.id ?? `oai-${Date.now()}`, opts = { mode: b.mode, effort: b.effort };
  if (old?.pending || oaiSending.has(id)) throw new Error('上一条还在回答，等它答完再发（或者先停止）');
  oaiSending.add(id);
  try {
    // ponytail: a chat whose last answer OpenAI no longer keeps (30 days) can't go on; sending its messages again would
    const r = await oaiApi('responses', { model: OAI_MODEL, reasoning: opts, tools: [{ type: 'web_search' }], input: [{ role: 'user', content: oaiInput(text, ups) }],
      previous_response_id: old?.resp ?? undefined, background: true, store: true, truncation: 'auto' }); // a chat grown past its window: its oldest dropped there, not this message refused
    const c = old ? oaiRead(id) : { id, title: (text.split('\n')[0] || oaiName(ups[0])).slice(0, 40), msgs: [], resp: null }, now = Date.now();
    const dir = path.join(OAI, id), files = ups.map((p) => path.join(dir, path.basename(p)));
    if (ups.length) fs.mkdirSync(dir, { recursive: true });
    ups.forEach((p, k) => fs.renameSync(p, files[k]));
    c.msgs.push({ role: 'user', text, files, at: now });
    Object.assign(c, { opts, pending: r.id, since: now, at: now });
    oaiSave(c);
    return { id };
  } finally { oaiSending.delete(id); }
}
// the web service, every few seconds: each answer pending asked after; one done goes into its chat, and a note out (the
// page's dot, the island, the phones). A failed one is said there, the chat going on from the answer before it.
let oaiPolling = false;
async function oaiPoll() {
  if (oaiPolling) return;
  oaiPolling = true;
  try {
    for (const { id, pending } of oaiChats().filter((c) => c.pending)) {
      let r;
      try { r = await oaiApi(`responses/${pending}`); } catch { continue; } // the network: asked again next time
      if (['queued', 'in_progress'].includes(r.status)) continue;
      let c;
      try { c = oaiRead(id); } catch { continue; } // deleted meanwhile
      if (c.pending !== pending) continue; // stopped meanwhile
      const now = Date.now(), text = oaiText(r), ok = r.status === 'completed' && !!text;
      if (text) c.msgs.push({ role: 'claude', text, at: now, ...(ok && { took: now - c.since }) });
      if (!ok) c.msgs.push({ role: 'note', text: `没有答完（${r.error?.message ?? r.incomplete_details?.reason ?? r.status}），这一条不算进对话，可以再发一次`, at: now });
      if (ok) c.resp = r.id;
      Object.assign(c, { pending: null, at: now });
      oaiSave(c);
      dropNote({ kind: 'done', project: 'GPT 聊天', msg: ok ? '回答好了' : '没有答完', title: c.title, id, gpt: true, gist: ok ? gistText(text, 150) : null }); // its start, for the phones
    }
  } finally { oaiPolling = false; }
}
async function oaiStop(id) {
  const c = oaiRead(id);
  if (!c.pending) return {};
  await oaiApi(`responses/${c.pending}/cancel`, {}).catch(() => {}); // done just now: stopped all the same, not kept
  const now = oaiRead(id);
  if (now.pending === c.pending) { now.msgs.push({ role: 'note', text: '已停止，这一条不算进对话', at: Date.now() }); now.pending = null; oaiSave(now); }
  return {};
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
  if (!s && name && listGemini().some((x) => x.id === id)) return console.log(gemRename(id, name, gemAgyConvs(agyPids()).has(id)).said); // a Gemini one's (agy's own list too when it isn't running)
  if (!s || !name) { console.log('用法：claude-multi rename <对话 id> <新名字>'); process.exit(1); }
  if (s.pid) { console.log(`这个对话正在运行，请在它的窗口里输入：/rename ${name}`); process.exit(1); }
  fs.appendFileSync(s.file, JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: id }) + '\n');
  fs.mkdirSync(s.file.slice(0, -6), { recursive: true });
  fs.writeFileSync(path.join(s.file.slice(0, -6), 'custom-title.json'), JSON.stringify({ customTitle: name }), { mode: 0o600 });
  console.log(`已改名：${name}`);
}

// resume ID N: continue a past conversation with account N, in its own folder. Claude only finds a
// transcript in its own config dir, so the newest copy (and its side folder of subagent and tool-output
// files) is moved into N's first when another account wrote it last.
// A Gemini one from the command line (the island, the 管家): which agy run (any: here or in a window), and the account
// n names (A2 or 2; the one on when none: its record is every account's)
const agyPids = () => (WIN ? new Set([...String(spawnSync('tasklist', ['/fi', 'imagename eq agy.exe', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout ?? '')
  .matchAll(/^"agy\.exe","(\d+)"/gim)].map((m) => +m[1])) : new Set());
const gemAcct = (n, reg = load()) => { const all = geminiAccounts(reg); return all[Number(String(n ?? '').replace(/^A/i, '')) - 1] ?? all.find((g) => g.id === reg.geminiOn) ?? all[0]; };
function resume(id, n) {
  const reg = load(), s = listSessions(reg).find((x) => x.id === id), gm = !s && listGemini(reg).find((x) => x.id === id);
  if (gm) { // a Gemini one: in its folder, on that account (switched on first)
    if (gemAgyConvs(agyPids()).has(id)) { console.log('这个对话正在运行：在网页上打开它，或者切到它的终端窗口。'); process.exit(1); }
    process.chdir(gm.cwd);
    return runGem(gemAcct(n, reg), ['--conversation', id]);
  }
  if (!s) { // a GPT one: on its own account (a GPT one changes none), in its folder
    const g = listGpt(reg).find((x) => x.id === id);
    if (!g) { console.log(`找不到对话 ${id}。`); process.exit(1); }
    if (g.pid) { console.log(g.web ? '这个对话正在网页服务里运行：用 claude-multi attach 接上它。' : `这个对话正在运行（进程 ${g.pid}），直接切到它的窗口即可。`); process.exit(1); }
    process.chdir(g.cwd);
    return runGpt(gptAccounts(reg)[g.acct], ['resume', id]);
  }
  if (s.mac) return attach(id); // the Mac's: continued there by the web service, this tab joined to it
  if (s.pid) { console.log(s.web ? '这个对话正在网页服务里运行：用 claude-multi attach 接上它。' : `这个对话正在运行（进程 ${s.pid}），直接切到它的窗口即可。`); process.exit(1); }
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
// A status it can't read (the file gone, or caught mid-write) isn't taken for free: read again, and after unknownMs of
// that, an error (nothing is ended).
// ponytail: an answer still going after 2 h is ended anyway
async function untilFree(dir, pid, now, unknownMs = 30000) {
  let unknownSince = null;
  for (const end = Date.now() + 7200000; !now && Date.now() < end && alive(pid); await sleep(1000)) {
    let st = null;
    try { st = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${pid}.json`), 'utf8')).status; } catch {}
    if (st == null) {
      unknownSince ??= Date.now();
      if (Date.now() - unknownSince >= unknownMs) throw new Error('读不到这个 Claude 在不在忙，没有换账号');
      continue;
    }
    unknownSince = null;
    if (st !== 'busy' && st !== 'shell') return;
  }
}
// Conversation s, running in a window here, to go on with account n; nothing is sent, it waits for you there.
// 'tab' or 'new': where it went on.
async function switchWindow(s, n, now) {
  const reg = load(), own = reg.profiles[s.acct], to = reg.profiles[n - 1]?.id;
  await untilFree(own.configDir, s.pid, now || atLimit(own));
  // the account it was asked for, by its id: one removed while this waited (up to 2 h) moved the numbers after it
  n = load().profiles.findIndex((p) => p.id === to) + 1;
  if (!n) throw new Error('要换去的账号已经不在了');
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
  if (!s && listGemini(reg).some((x) => x.id === id)) { // a Gemini one: in the web service, on An (ended there and started again; one not running: started there)
    const k = Number(String(n ?? '').replace(/^A/i, ''));
    if (!geminiAccounts(reg)[k - 1]) return console.log('没有这个 Gemini 账号（写 A1、A2…）。');
    try { await webPost('/api/open', { id, gem: true, swap: true, acct: k, cols: 120, rows: 40 }); return console.log(`这个 Gemini 对话在网页服务里换到 A${k} 接着了。`); }
    catch (e) { return console.log(`没换成：${e.message}`); }
  }
  n = Number(n);
  if (!s || !reg.profiles[n - 1]) return console.log(s ? '没有这个账号。' : `找不到对话 ${id}。`);
  if (!s.pid) return console.log(`这个对话没在运行，用 claude-multi resume ${id} ${n} 打开即可。`);
  if (s.web) {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/switch`, { method: 'POST', body: JSON.stringify({ id, acct: Number(n), now }),
      headers: { cookie: `cm=${webKey()}`, 'content-type': 'application/json', 'accept-encoding': 'identity' } });
    const j = await r.json().catch(() => ({}));
    return console.log(r.ok ? `网页上的这个对话会换到账号 ${n} 接着` : `没换成：${j.err ?? r.status}`);
  }
  let where;
  try { where = await switchWindow(s, n, now); } catch (e) { process.exitCode = 1; return console.log(`没换成：${e.message}`); }
  console.log(where === 'tab' ? `已换到账号 ${n}，在原来的窗口里接着` : `已换到账号 ${n}，在新窗口里接着`);
}
// attach ID: this terminal joins a conversation running in the web service (one started or continued from
// the web page): the same screen on both sides, either one types. The size follows the side you type on;
// the other side scales to it. Closing this tab leaves the conversation running there.
// (start: one to start there and join, as /api/open takes it: {mac: true} for one on the Mac)
async function attach(id, start) {
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
    const r = await post('/api/open', start ? { ...start, ...size() } : { id, gpt: listGpt().some((x) => x.id === id), gem: listGemini().some((x) => x.id === id), ...size() });
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

// --- chat: how the 管家 (butler\) works the other conversations, through the web service as the page does. A
// conversation by its id, or a part of its title that only it has. look: where it is, its last answer, the question it
// waits on; wait: until it's done (in the 管家's background: it's woken when this ends), or until a time (a quota's
// reset); say: a message, sent as the page sends one, not while it's asking something; pick: an option of its question;
// new: one started in the web service, on the recommended account, its folder marked trusted first.
async function webPost(p, body, method = 'POST') {
  const r = await fetch(`http://127.0.0.1:${WEB_PORT}${p}`, { method, ...(method === 'POST' && { body: JSON.stringify(body) }),
    headers: { cookie: `cm=${webKey()}`, 'content-type': 'application/json', 'accept-encoding': 'identity' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.err || `网页服务出错了（${r.status}）`);
  return j;
}
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
// the claude-multi in use, or a folder in it: a change there is live at once, unreviewed (the 管家 works elsewhere)
const realDir = (d) => { try { return fs.realpathSync.native(path.resolve(d)); } catch { return path.resolve(d); } };
const inLive = (d) => { const r = path.relative(realDir(__dirname), realDir(d)); return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r)); };
const LIVE_NO = `这是正在用的 claude-multi 代码，不能在这里改：在单独的副本（${__dirname}-dev 这类 git worktree）里新开对话，交代里写明建分支、发 PR`;
function findChat(ref) { // a Claude conversation, a GPT one (gpt: true), a Gemini one (gem: true) or a GPT 聊天 one (oai: true), by its id or words of its title
  const reg = load(), all = [...listSessions(reg), ...listGpt(reg), ...listGemini(reg), ...oaiList()], byId = all.find((s) => s.id === ref), hit = byId ? [byId] : all.filter((s) => ref && s.title.includes(ref));
  if (hit.length === 1) return hit[0];
  if (!hit.length) throw new Error(`找不到「${ref ?? ''}」这个对话`);
  throw new Error(`「${ref}」对上了好几个对话，用编号指定：\n${hit.slice(0, 8).map((s) => `  ${s.id}  ${s.title}`).join('\n')}`);
}
// its Claude's session file (on any account), once one matches; null after ms
async function waitLive(match, ms = 0) {
  for (const end = Date.now() + ms; ; await sleep(1000)) {
    for (const p of load().profiles) { const j = sessionFiles(p.configDir).find(match); if (j) return { ...j, dir: p.configDir }; }
    if (Date.now() >= end) return null;
  }
}
const statusOf = (live) => { try { return alive(live.pid) ? JSON.parse(fs.readFileSync(path.join(live.dir, 'sessions', `${live.pid}.json`), 'utf8')).status : 'gone'; } catch { return null; } };
// A conversation's screen as its terminal shows it now (the question it waits on is only there: its record gets it once
// answered): its stream, which the service begins with what's on it, written into a terminal of the same size here and
// read once quiet; what's on it as the page reads it (screen.js). Live: one that ended since is not started again
async function screenOf(id, gem = false) { // (gem: a Gemini one's, its agy's screen)
  const rows = await screenRows((await webPost('/api/open', { id, live: true, gem })).key), sc = require('./screen.js');
  return rows && (gem ? sc.parseAgyScreen(rows) : sc.parseScreen(rows));
}
// a terminal's screen as its rows, once quiet (nothing new for `still` ms; `max` ms at most); null if nothing came. A GPT
// conversation's too, for its Codex up before it's typed to
async function screenRows(key, { max = 5000, still = 800 } = {}) {
  const { Terminal } = require('@xterm/headless'), { Unicode11Addon } = require('@xterm/addon-unicode11');
  const ac = new AbortController();
  const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/term?key=${encodeURIComponent(key)}`, { signal: ac.signal, headers: { cookie: `cm=${webKey()}`, 'accept-encoding': 'identity' } });
  let term = null, last = Date.now(), wrote = Promise.resolve();
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      for (let k; (k = buf.indexOf('\n\n')) >= 0; buf = buf.slice(k + 2)) {
        const block = buf.slice(0, k), ev = /^event: (\w+)/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev === 'size') {
          const z = JSON.parse(data);
          if (term) { if (z.w) term.resize(z.w, z.h); continue; }
          term = new Terminal({ cols: z.w || 120, rows: z.h || 40, allowProposedApi: true });
          term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11'; // CJK two columns wide, as the page draws them
        } else if (ev === 'data' && term) { const d = JSON.parse(data); wrote = new Promise((ok) => term.write(d, ok)); last = Date.now(); }
      }
    }
  })().catch(() => {});
  for (const end = Date.now() + max; Date.now() < end && !(term && Date.now() - last > still);) await sleep(100);
  ac.abort(); await wrote;
  if (!term) return null;
  const b = term.buffer.active, rows = [];
  for (let i = 0; i < term.rows; i++) rows.push(b.getLine(b.baseY + i)?.translateToString(true) ?? '');
  term.dispose();
  return rows;
}
// A Codex screen on a question of its own (hooks to trust, a folder, an update…) instead of its input box: its first line,
// for the 管家 to pass on. null at its input box, or with nothing to tell (still starting: typed to as before)
function codexBlocked(rows) {
  const s = (rows ?? []).join('\n');
  if (!rows || /for shortcuts|Ask Codex to do anything/.test(s) || !/\benter\b/i.test(s)) return null;
  return rows.map((r) => r.trim()).find(Boolean)?.slice(0, 80) ?? '';
}
// "15:40" (the next one), or a date and time: when to wake
function parseUntil(s, now = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  if (!m) { const t = Date.parse(s); if (isNaN(t)) throw new Error(`看不懂这个时间：${s}（写成 15:40）`); return t; }
  const d = new Date(now); d.setHours(+m[1], +m[2], 0, 0);
  return d.getTime() > now ? d.getTime() : d.getTime() + 86400000;
}
// not while it works (up to ms), nor while it waits on a question: typing would answer it
async function untilReady(live, ms = 600000) {
  for (const end = Date.now() + ms; ; await sleep(2000)) {
    const st = statusOf(live);
    if (st === 'gone') throw new Error('它的 Claude 已经退出了');
    if (st === 'waiting') throw new Error('它在等人回答问题，先用 chat look 看它在问什么');
    if (st === 'idle') return;
    if (Date.now() >= end) throw new Error(st == null ? '读不到它的状态，没有发' : '它一直在忙，没有发');
  }
}
// as the page sends a message: pasted in one piece, then Enter; whether it got to work
async function pasteEnter(key, text) {
  await webPost('/api/input', { key, by: 'butler', data: `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~` });
  await sleep(400);
  await webPost('/api/input', { key, by: 'butler', data: '\r' });
}
async function typeIn(key, live, text) {
  await pasteEnter(key, text);
  for (let k = 0; k < 20; k++, await sleep(1000)) if (['busy', 'shell'].includes(statusOf(live))) return true;
  return false;
}
// A GPT conversation for the 管家's commands (Codex writes no session file: its state is in its records). Not while its
// turn goes on; 2 minutes at most: a permission it asks keeps its turn going, and isn't read yet. Taken in: what it was
// sent is its last message from you (within 20 s)
async function gptUntilReady(s, ms = 120000) { // as the web service tells it: at work in the Codex running there
  for (const end = Date.now() + ms; (await webPost(`/api/gpt?id=${encodeURIComponent(s.id)}`, null, 'GET')).busy; await sleep(2000))
    if (Date.now() >= end) throw new Error('它一直在忙，或者在等人确认（GPT 的确认还认不出来），没有发。用 chat look 看看，或让用户在网页上打开它');
}
// A Gemini one for the 管家's commands: done with its turn (its screen and its record) and asking nothing (a question:
// told, not typed into); 2 minutes at most. Taken in: what it was sent is its last message from you (within 20 s)
async function gemUntilReady(s, key, ms = 120000) {
  for (const end = Date.now() + ms; ; await sleep(2000)) {
    const sc = require('./screen.js').parseAgyScreen((await screenRows(key, { max: 6000, still: 800 })) ?? []);
    if (sc.menu || sc.writing) throw new Error('它在等人回答问题，先用 chat look 看它在问什么');
    const run = await webPost(`/api/gem?id=${encodeURIComponent(s.id)}`, null, 'GET');
    if (!sc.busy && !run.busy) return;
    if (Date.now() >= end) throw new Error('它一直在忙，没有发。用 chat look 看看');
  }
}
// one just started: its box up (a rule, > under it), its notice at the start away (Esc); false if it never came
async function gemBox(key) {
  let up = false;
  for (let k = 0; k < 10 && !up; k++) { const r = (await screenRows(key, { max: 4000, still: 1000 })) ?? []; up = r.some((x, i) => /^─{20}/.test(x) && /^>/.test(r[i + 1] ?? '')); if (!up) await sleep(1000); }
  if (up) { await webPost('/api/input', { key, by: 'butler', data: '\x1b' }); await sleep(600); }
  return up;
}
async function gemWent(id, text) {
  const flat = (t) => String(t ?? '').replace(/\s+/g, ' ').trim(), want = flat(text).slice(0, 40);
  for (let k = 0; k < 20; k++, await sleep(1000)) if (flat(gemLast(id, true)).startsWith(want)) return true;
  return false;
}
async function gptWent(home, id, text) {
  const flat = (t) => String(t ?? '').replace(/\s+/g, ' ').trim(), want = flat(text).slice(0, 40);
  for (let k = 0; k < 20; k++, await sleep(1000)) if (flat(gptLast(home, id, 'userMessage')).startsWith(want)) return true;
  return false;
}
// a question on its screen as the 管家 reads it: what it asks, its options (the cursor's marked), how to answer
const menuSaid = (menu, id) => `\n\n它在问${menu.tabs ? `（一次好几题：${menu.tabs}）` : ''}：\n${menu.ask}\n`
  + menu.opts.map((o) => `  ${o.n}. ${o.check == null ? '' : o.check ? '[✔] ' : '[ ] '}${o.label}${o.desc ? ' — ' + o.desc : ''}${o.n === menu.cur ? '  ← 光标在这' : ''}`).join('\n')
  + `\n（用户交代过怎么选的，用 claude-multi chat pick ${id} <选项号> 回答；没交代就转告用户）`;
async function chatLook(ref) {
  const s = findChat(ref);
  if (s.gem) { // a Gemini one: where it runs (the web service, or a terminal window), at work or asking (its screen), its last answer
    let run = null, sc = null;
    try { run = await webPost(`/api/gem?id=${encodeURIComponent(s.id)}`, null, 'GET'); } catch {}
    if (run?.pid) try { sc = await screenOf(s.id, true); } catch {}
    const ans = gemLast(s.id) || '（还没有回答）', menu = sc?.menu;
    const st = !run?.pid ? '没在运行' : menu ? '在等人回答' : sc?.writing ? '在等人填写回答' : sc?.busy || run.busy ? '正在回复' : '空闲';
    return console.log(`「${s.title}」 ${s.id}\nGemini 账号 A${s.acct + 1} · ${s.cwd} · ${run?.pid ? (run.web ? '网页上 · ' : '电脑窗口里 · ') : ''}${st}\n\n最后的回答：\n${ans.length > 2000 ? '…' + ans.slice(-2000) : ans}`
      + (menu ? menuSaid(menu, s.id) : sc?.writing ? '\n\n它在等人填写一个回答（自己输入的那一项），让用户在网页上回答。' : ''));
  }
  if (s.oai) { // a GPT 聊天 one: its mode and effort as last sent, its answer pending or not, its last answer (and what came after it)
    const c = oaiRead(s.id), ans = oaiLast(c) || '（还没有回答）', end = c.msgs.at(-1)?.role === 'note' ? c.msgs.at(-1).text : '';
    return console.log(`「${s.title}」 ${s.id}\nGPT 聊天 · ${oaiHow(c.opts ?? OAI_OPTS)} · ${c.pending ? `正在回答（已经 ${Math.max(1, Math.round((Date.now() - c.since) / 60000))} 分钟）` : '空闲'}`
      + `\n\n最后的回答：\n${ans.length > 2000 ? '…' + ans.slice(-2000) : ans}${end ? `\n\n（之后：${end}）` : ''}`);
  }
  if (s.gpt) { // a GPT one: whether it runs in the web service (its Codex is nowhere else), its last answer from its records
    let run = null;
    try { run = await webPost(`/api/gpt?id=${encodeURIComponent(s.id)}`, null, 'GET'); } catch {}
    const ans = gptLast(s.home, s.id, 'agentMessage') || '（还没有回答）';
    return console.log(`「${s.title}」 ${s.id}\nGPT 账号 G${s.acct + 1} · ${s.cwd} · ${!run?.pid ? '没在运行' : `${run.web ? '网页上' : '电脑的终端窗口里'} · ${run.busy ? '正在回复' : '空闲'}`}\n\n最后的回答：\n${ans.length > 2000 ? '…' + ans.slice(-2000) : ans}`
      + (run?.pid ? '\n\n（GPT 对话问的选择题、要的权限确认这里还认不出来：它一直停着不动时，让用户在网页上打开看看）' : ''));
  }
  const live = s.pid ? await waitLive((j) => j.pid === s.pid) : null;
  const st = live ? statusOf(live) : null, menu = st === 'waiting' ? (await screenOf(s.id))?.menu : null;
  const ans = history(s.file).items.filter((m) => m.role === 'claude').pop()?.text ?? '（还没有回答）';
  const where = !s.pid ? '没在运行' : { busy: '正在回复', shell: '正在执行命令', waiting: '在等人回答', idle: '空闲' }[st] ?? '在运行';
  let out = `「${s.title}」 ${s.id}\n${s.mac ? s.who : `账号 ${s.acct + 1}`} · ${s.cwd} ·${s.pid ? (s.web ? '网页上 · ' : '电脑窗口里 · ') : ''}${where}\n\n最后的回答：\n${ans.length > 2000 ? '…' + ans.slice(-2000) : ans}`;
  if (menu) out += menuSaid(menu, s.id);
  else if (st === 'waiting') out += '\n\n它在等人处理，但屏幕上没认出选择题，让用户在网页上打开它看一下。';
  console.log(out);
}
async function chatWait(ref, until, note) {
  const t = until ? parseUntil(until) : null, s = ref ? findChat(ref) : null, wf = path.join(WAITS, `${process.pid}.json`);
  if (!t) throw new Error('chat wait 只用来定时：--until 15:40。工单的对话停下时你会自动收到通知，不用等');
  fs.mkdirSync(WAITS, { recursive: true });
  fs.writeFileSync(wf, JSON.stringify({ pid: process.pid, at: Date.now(), until: t, id: s?.id ?? null, title: s?.title ?? null, note: note ?? null }));
  try {
    await sleep(Math.max(0, t - Date.now()));
    blog(`提醒到点：${note || new Date(t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}`, s?.id);
    console.log(`到点了（${new Date(t).toLocaleString('zh-CN', { hour12: false })}）。`);
    if (s) await chatLook(s.id);
  } finally { fs.rmSync(wf, { force: true }); }
}
async function chatSay(ref, text, before, ask) { // ask: a GPT 聊天 one's mode and effort
  if (!text) throw new Error('要说什么？');
  const s = findChat(ref), t0 = Date.now();
  if (s.oai) return oaiSay(s, text, ask);
  // its Claude runs there: one started for it here would never be found (waitLive reads this PC's accounts)
  if (s.mac) throw new Error('Mac 上的对话管家还发不了消息，请用户在网页上打开它');
  if (s.gem) { // a Gemini one: its agy in the web service (continued there if it isn't; one in a terminal window: typed there), ready first
    const { key, pid } = await webPost('/api/open', { id: s.id, gem: true, cols: 120, rows: 40 }); // pid: just started for it
    if (pid && !(await gemBox(key))) throw new Error(`「${s.title}」的 agy 没能准备好，没有发。请用户在网页上打开它看看`);
    await gemUntilReady(s, key);
    await before?.(s.id);
    await pasteEnter(key, text);
    const went = await gemWent(s.id, text);
    blog(`给「${s.title}」发了消息：${text.length > 40 ? text.slice(0, 40) + '…' : text}`, s.id);
    console.log(went ? `已发给「${s.title}」，它开始干活了。` : `已发给「${s.title}」，但还没看到它收下，稍后用 chat look 看看。`);
    return { id: s.id, title: s.title };
  }
  if (s.gpt) { // a GPT one: its Codex in the web service (continued there if it isn't), up, and done with its turn first
    const { key } = await webPost('/api/open', { id: s.id, gpt: true, cols: 120, rows: 40 });
    const stuck = codexBlocked(await screenRows(key, { max: 20000, still: 1500 }));
    if (stuck != null) throw new Error(`「${s.title}」的 GPT 停在它自己的一个问题上（${stuck}），没有发。请用户在网页上打开它，切到「终端」回答一次`);
    await gptUntilReady(s);
    await before?.(s.id);
    await pasteEnter(key, text);
    const went = await gptWent(s.home, s.id, text);
    blog(`给「${s.title}」发了消息：${text.length > 40 ? text.slice(0, 40) + '…' : text}`, s.id);
    console.log(went ? `已发给「${s.title}」，它开始干活了。` : `已发给「${s.title}」，但还没看到它收下，稍后用 chat look 看看。`);
    return { id: s.id, title: s.title };
  }
  const { key, pid } = await webPost('/api/open', { id: s.id, acct: s.acct + 1, cols: 120, rows: 40 }); // not running: continued in the web service
  const run = s.pid ?? pid; // its Claude: the one it runs in, or the one the service just started for it
  const live = await waitLive((j) => j.sessionId === s.id || j.pid === run || (!run && sameDir(j.cwd, s.cwd) && j.startedAt >= t0 - 5000), 60000);
  if (!live) throw new Error('它没能启动起来');
  await untilReady(live);
  await before?.(s.id); // ticket give: bound first, so its first turn ending is seen
  const went = await typeIn(key, live, text);
  blog(`给「${s.title}」发了消息：${text.length > 40 ? text.slice(0, 40) + '…' : text}`, s.id);
  console.log(went ? `已发给「${s.title}」，它开始干活了。` : `已发给「${s.title}」，但它还没动，稍后用 chat look 看看。`);
  return { id: s.id, title: s.title };
}
// a single-choice question: from the option the cursor is on to the one chosen, then Enter (as the page's card does).
// ask: the question it was picked on; another one up by now (the first answered) isn't answered with it.
// a tool's permission (Claude Code's "Do you want to proceed?", "…make this edit…?", "…allow this connection?"), not a
// plan's "Would you like to proceed?": yours to answer, never the 管家's
const asksPermission = (ask) => /\bDo you want to\b|Requesting permission for|Run this command\?/i.test(ask ?? ''); // (agy's too)
async function pickOn(id, n, ask, by = 'butler', gem = false) {
  const menu = (await screenOf(id, gem))?.menu, o = menu?.opts.find((x) => x.n === Number(n));
  if (!menu) throw new Error('它现在没在问选择题');
  if (by === 'butler' && asksPermission(menu.ask)) throw new Error('这是工具权限确认，要用户自己在网页上回答');
  if (ask != null && menu.ask !== ask) throw new Error('它问的已经变了，再看一下');
  if (menu.tabs || menu.opts.some((x) => x.check != null)) throw new Error('这是多选题，或者一次问了好几题，请用户在网页上点卡片回答');
  if (!o) throw new Error(`选项号要在 1 到 ${menu.opts.length} 之间`);
  if (/^(Type something|Write-in)/i.test(o.label)) throw new Error('「自己输入」这一项请用户在网页上回答');
  const { key } = await webPost('/api/open', { id, live: true, gem });
  for (let i = 0; i < Math.abs(o.n - menu.cur); i++) await webPost('/api/input', { key, by, data: o.n > menu.cur ? '\x1b[B' : '\x1b[A' });
  await webPost('/api/input', { key, by, data: '\r' });
  return o.label;
}
async function chatPick(ref, n) {
  const s = findChat(ref);
  if (s.oai) throw new Error('GPT 聊天不会问选择题');
  if (s.gpt) throw new Error('GPT 对话的选择题这里还选不了，请用户在网页上打开它回答');
  if (s.gem ? !(await webPost(`/api/gem?id=${encodeURIComponent(s.id)}`, null, 'GET')).pid : !s.pid) throw new Error('它现在没在问选择题');
  const label = await pickOn(s.id, n, undefined, 'butler', !!s.gem);
  blog(`替你给「${s.title}」选了「${label}」`, s.id);
  console.log(`已替用户选了「${label}」。`);
}
// a folder agy trusts from now on (in its own list, ~/.gemini's settings: no question to stop at in one started there)
function gemTrust(dir, home = GEMINI_HOME) {
  const f = path.join(home, 'antigravity-cli', 'settings.json');
  let s = {};
  try { const t = fs.readFileSync(f, 'utf8').trim(); s = t ? JSON.parse(t) : {}; } catch (e) { if (e.code !== 'ENOENT') return; }
  const have = Array.isArray(s.trustedWorkspaces) ? s.trustedWorkspaces : [];
  if (have.some((x) => sameDir(String(x), dir))) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...s, trustedWorkspaces: [...have, path.resolve(dir)] }, null, 2) + '\n');
}
async function chatNew(dir, text, n, before, gpt = false, gem = false) {
  dir = path.resolve(dir ?? '');
  if (!isDir(dir)) throw new Error(`没有这个文件夹：${dir}`);
  if (sameDir(dir, HOME)) throw new Error('主文件夹 Claude 每次都要问是否信任，换一个具体的文件夹');
  if (inLive(dir)) throw new Error(LIVE_NO);
  if (!text) throw new Error('要给它第一句话');
  if (gem) { // a Gemini one, on Gemini account n (the one on when none given), in the web service: its agy up, the first words typed
    const all = geminiAccounts(), on = all.findIndex((g) => g.id === load().geminiOn) + 1;
    n = n || on || 1;
    if (!all[n - 1]) throw new Error(`没有 Gemini 账号 A${n}（用户要先运行 claude-multi new gemini 加一个）`);
    const { key } = await webPost('/api/open', { dir, acct: n, gem: true, cols: 120, rows: 40 });
    if (!(await gemBox(key))) throw new Error(`Gemini 账号 A${n} 的 agy 没能准备好，请用户在网页上新开一个 Gemini 对话看看`);
    await pasteEnter(key, text);
    let id = null; // its conversation once agy made it with the first message (the service finds it a few seconds on)
    for (let k = 0; k < 30 && !id; k++, await sleep(1000)) id = (await webPost(`/api/history?key=${encodeURIComponent(key)}`, null, 'GET')).id ?? null;
    if (!id) throw new Error('第一句已发出，但没找到它的对话编号：稍后用 chat look 按标题找它');
    await before?.(id);
    blog(`新开了对话（${path.basename(dir)}，Gemini 账号 A${n}）：${text.length > 40 ? text.slice(0, 40) + '…' : text}`, id);
    console.log(`已在 Gemini 账号 A${n} 新建对话，编号 ${id}（文件夹 ${dir}）。第一句已发出。`);
    return { id, title: '' };
  }
  if (gpt) { // a GPT one, on GPT account n (G1 when none given), in the web service: its Codex up, the first words typed
    n = n || 1;
    if (!gptAccounts()[n - 1]) throw new Error(`没有 GPT 账号 G${n}（用户要先运行 claude-multi new gpt 加一个）`);
    const { key } = await webPost('/api/open', { dir, acct: n, gpt: true, cols: 120, rows: 40 });
    const stuck = codexBlocked(await screenRows(key, { max: 20000, still: 1500 }));
    if (stuck != null) { // no conversation yet, so not in any list: ended, not left waiting where nobody finds it
      for (let k = 0; k < 2; k++) { await webPost('/api/input', { key, by: 'butler', data: '\x03' }); await sleep(600); }
      throw new Error(`GPT 账号 G${n} 的 Codex 一启动就停在它自己的一个问题上（${stuck}），没有开成对话。请用户在网页上新开一个 GPT 对话（这个账号），切到「终端」回答一次，以后就不会再问`);
    }
    await pasteEnter(key, text);
    // Codex makes its thread with the first message: its id (which a ticket is bound to: before) once it's typed, a second
    // or two into its turn, before that turn can end
    let id = null;
    for (let k = 0; k < 30 && !id; k++, await sleep(1000)) id = (await webPost(`/api/history?key=${encodeURIComponent(key)}`, null, 'GET')).id ?? null;
    if (!id) throw new Error('第一句已发出，但没找到它的对话编号：稍后用 chat look 按标题找它');
    await before?.(id);
    blog(`新开了对话（${path.basename(dir)}，GPT 账号 G${n}）：${text.length > 40 ? text.slice(0, 40) + '…' : text}`, id);
    console.log(`已在 GPT 账号 G${n} 新建对话，编号 ${id}（文件夹 ${dir}）。第一句已发出。`);
    return { id, title: '' };
  }
  const reg = load();
  // none open: all at their limits, or (no recommendation) none read, which isn't the same
  if (!n) { const u = (await usageState(reg)).json; if (!u.open) throw new Error(u.rec == null ? '读不到任何账号的额度，用 --acct N 指定一个账号' : `账号都到上限了，${u.ready} 后恢复`); n = u.rec + 1; }
  const p = reg.profiles[n - 1];
  if (!p) throw new Error('没有这个账号');
  shareTrust(p.configDir, undefined, [dir.replace(/\\/g, '/')]); // no trust question to stop at
  const { key, pid } = await webPost('/api/open', { dir, acct: n, cols: 120, rows: 40 });
  if (!pid) throw new Error('没有取得新终端的 PID，未绑定工单或发送消息；请先在网页确认启动状态');
  const live = await waitLive((j) => j.pid === pid, 60000);
  if (!live) throw new Error('它没能启动起来');
  await untilReady(live, 60000);
  await before?.(live.sessionId);
  const went = await typeIn(key, live, text);
  blog(`新开了对话（${path.basename(dir)}，账号 ${n}）：${text.length > 40 ? text.slice(0, 40) + '…' : text}`, live.sessionId);
  console.log(`已在账号 ${n} 新建对话，编号 ${live.sessionId}（文件夹 ${dir}）。${went ? '第一句已发出，它开始干活了。' : '第一句已发出，但它还没动，稍后用 chat look 看看。'}`);
  return { id: live.sessionId, title: '' };
}
async function chat([sub, ...a]) {
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : undefined; }, flag = (k) => { const i = a.indexOf(k); return i >= 0 && a.splice(i, 1).length > 0; };
  try {
    const ask = { mode: opt('--mode'), effort: opt('--effort') }; // a GPT 聊天 one's, for say and new --oai
    if (sub === 'look') await chatLook(a[0]);
    else if (sub === 'wait') { const until = opt('--until'), note = opt('--note'); await chatWait(a[0], until, note); }
    else if (sub === 'say') await chatSay(a[0], a.slice(1).join(' '), undefined, ask);
    else if (sub === 'pick') await chatPick(a[0], a[1]);
    else if (sub === 'new' && flag('--oai')) await oaiSay(null, a.join(' '), ask); // a GPT 聊天 one: no folder, all of it the first words
    else if (sub === 'new') { const n = Number(String(opt('--acct') ?? '').replace(/^[ga]/i, '')) || 0, gpt = flag('--gpt'), gem = flag('--gemini'); await chatNew(a[0], a.slice(1).join(' '), n, undefined, gpt, gem); }
    else if (sub === 'tell') { if (!a.join(' ').trim()) throw new Error('要告诉用户什么？'); await webPost('/api/tell', { text: a.join(' ') }); console.log('已发到用户手机。'); }
    else console.log('claude-multi chat look <对话> | wait [<对话>] --until 15:40 [--note 备注] | say <对话> <消息> [--mode pro --effort max（GPT 聊天）] | pick <对话> <选项号> | new <文件夹> <第一句话> [--acct N] [--gpt（GPT 对话，--acct 是 G 几）] [--gemini（Gemini 对话，--acct 是 A 几，不写就是在线的那个）] | new --oai <第一句话> [--mode standard|pro] [--effort low|medium|high|xhigh|max]（GPT 聊天） | tell <要告诉用户的话>');
  } catch (e) { process.exitCode = 1; console.log(e.message === 'fetch failed' ? '连不上网页服务，它在运行吗？' : e.message); }
}
// claude-multi ticket …: the 管家's tickets, which the web service keeps. give: to a new conversation (a folder given)
// or one going already, as you would; the work is typed in with what you asked for and how to report back.
async function ticket([sub, ...a]) {
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : undefined; }, flag = (k) => { const i = a.indexOf(k); return i >= 0 && a.splice(i, 1).length > 0; };
  const st = (t) => `${t.stage[0]}${t.stage[2] ? '：' + t.stage[2].replace(/\s+/g, ' ').slice(0, 200) : ''}`;
  try {
    if (sub === 'new') {
      const ask = opt('--ask'), done = opt('--done'), limits = opt('--limits'), inferred = flag('--inferred');
      const t = await webPost('/api/ticket', { op: 'new', name: a.join(' '), ask, done, limits, inferred });
      blog(`${inferred ? '提了个建议' : '新工单'} #${t.id}「${t.name}」`);
      console.log(`已建工单 #${t.id}「${t.name}」。${inferred ? '这是你自己提的：用户同意了再 ticket give。' : '接着用 ticket give 派给一个对话。'}`);
    } else if (sub === 'give') {
      const n = Number(String(opt('--acct') ?? '').replace(/^[ga]/i, '')) || 0, gpt = flag('--gpt'), gem = flag('--gemini'), [id, where, ...rest] = a, text = rest.join(' ');
      const t = (await webPost('/api/tickets', null, 'GET')).find((x) => x.id === Number(id));
      if (!t) throw new Error(`没有工单 #${id}`);
      if (t.end) throw new Error(`工单 #${t.id} 已经结束了`);
      if (!where || !text) throw new Error('用法：ticket give <工单号> <文件夹 或 对话> <交代>');
      const no = `${t.id}-${(t.n ?? 0) + 1}`; // this give's number, which its reports carry
      const brief = `${text}\n\n（这是管家派的工单 #${t.id}「${t.name}」。用户的原话：${t.ask}${t.done ? `\n做到什么算完：${t.done}` : ''}${t.limits ? `\n约束：${t.limits}` : ''}`
        + `\n做完了、要用户决定、或者卡住了，用命令告诉管家（不用等它来问）：\n  claude-multi report ${no} 做完 <一句话结果>\n  claude-multi ask ${no} <要用户决定的问题>\n  claude-multi report ${no} 卡住 <原因>（失败、不用做 也这样报）`
        + '\n只是告一段落、下一步你自己清楚的，不用报告，停下就行，管家会让你接着做。）';
      // not in the claude-multi in use: the conversation given to, by the folder it runs in; not a GPT 聊天 one (no folder)
      const dir = fs.existsSync(where) && fs.statSync(where).isDirectory();
      if (!dir && findChat(where).oai) throw new Error('GPT 聊天只能问问题，不能在电脑上干活，不派工单：要问它就用 chat say');
      if (inLive(dir ? where : findChat(where).cwd)) throw new Error(LIVE_NO);
      const bind = (conv) => webPost('/api/ticket', { op: 'give', id: t.id, n: (t.n ?? 0) + 1, conv, title: dir ? path.basename(path.resolve(where)) : findChat(conv).title });
      const c = dir ? await chatNew(where, brief, n, bind, gpt, gem) : await chatSay(where, brief, bind); // to a GPT or Gemini one going already: it is one
      console.log(`工单 #${t.id} 已交给${dir ? '新开的对话' : `「${c.title}」`}（编号 ${c.id}）。它停下时你会收到通知。`);
    } else if (sub === 'end') {
      const [id, how, ...rest] = a, text = rest.join(' ');
      if (!['done', 'stop'].includes(how)) throw new Error('用法：ticket end <工单号> done|stop [一句话]');
      const t = await webPost('/api/ticket', { op: 'end', id, how, text });
      blog(how === 'done' ? `完成：工单 #${t.id}「${t.name}」${text ? '：' + text : ''}` : `停了工单 #${t.id}「${t.name}」${text ? '：' + text : ''}`);
      console.log(`工单 #${t.id} 已${how === 'done' ? '完成' : '停下'}。`);
    } else if (!sub || sub === 'list') {
      const all = await webPost('/api/tickets', null, 'GET');
      if (!all.length) return console.log('还没有工单。');
      for (const t of all) console.log(`#${t.id} ${t.name} · ${st(t)}${t.end ? '' : `\n   对话：${t.conv ? `${t.convTitle || '（还没标题）'}（编号 ${t.conv}）` : '还没派'}\n   原话：${t.ask}${t.done ? `\n   做到什么算完：${t.done}` : ''}${t.limits ? `\n   约束：${t.limits}` : ''}`}\n`);
    } else console.log('claude-multi ticket [list] | new <名字> --ask <用户原话> [--done <做到什么算完>] [--limits <约束>] [--inferred] | give <工单号> <文件夹 或 对话> <交代> [--acct N] [--gpt] [--gemini] | end <工单号> done|stop [一句话]');
  } catch (e) { process.exitCode = 1; console.log(e.message === 'fetch failed' ? '连不上网页服务，它在运行吗？' : e.message); }
}
// claude-multi report N <word> <一句话> / ask N <问题>: a worker telling the 管家 how its ticket stands
async function reportTo(cmd, [id, ...a]) {
  try {
    const k = cmd === 'ask' ? 'ask' : a.shift(), text = a.join(' ');
    const t = await webPost('/api/ticket', { op: 'report', id, k, text });
    console.log(`已告诉管家（工单 #${t.id}「${t.name}」）。`);
  } catch (e) { process.exitCode = 1; console.log(e.message === 'fetch failed' ? '连不上网页服务，它在运行吗？' : e.message); }
}
// Before account p continues conversation s: its newest record (and side folder) moved into p's config dir.
function copyTo(s, p) {
  const dst = path.join(p.configDir, 'projects', path.basename(path.dirname(s.file)));
  if (sameDir(dst, path.dirname(s.file))) return;
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(s.file, path.join(dst, `${s.id}.jsonl`));
  const side = s.file.slice(0, -6);
  if (fs.existsSync(side)) fs.cpSync(side, path.join(dst, s.id), { recursive: true });
  log('session_copied', { profile_id: p.id, session_id: s.id });
  // then the old one goes (a month of switches left 1.1 GB of them), its tokens counted first as a delete does. Copied,
  // not renamed: a rename keeps the birth time, and usage gives a tie to the older file's account
  try { tokenStats(); fs.rmSync(side, { recursive: true, force: true }); fs.rmSync(s.file, { force: true }); } catch {} // not counted (a full disk), held open: it stays
}

// delete ID: a conversation that isn't running goes to the Recycle Bin: its transcript in every account
// (older versions left copies on a resume) and the side folder beside each. Its tokens are counted first; the usage page keeps
// counting a record once it's gone.
function del(id) {
  const reg = load(), s = listSessions(reg).find((x) => x.id === id);
  if (!s && listGemini(reg).some((x) => x.id === id)) { // a Gemini one: to the Recycle Bin, not while an agy runs it
    if (gemAgyConvs(agyPids()).has(id)) { console.log('这个对话正在运行，先结束它再删。'); process.exit(1); }
    return gemDelete(id).then((r) => console.log(r.said), (e) => { console.log(e.message); process.exitCode = 1; });
  }
  if (!s) { // a GPT one: archived, Codex's own way (codex unarchive brings it back)
    const g = listGpt(reg).find((x) => x.id === id), codex = g && codexCmd();
    if (!g) { console.log(`找不到对话 ${id}。`); process.exit(1); }
    if (g.pid) { console.log('这个对话正在运行，先结束它再删。'); process.exit(1); }
    if (!codex) { console.log('没找到 codex'); process.exit(1); }
    const r = spawnSync(codex.file, [...codex.pre, 'archive', id], { env: codexEnv(codex, g.home), encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) { console.log(`没归档成：${String(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').pop()}`); process.exit(1); }
    log('gpt_archived', { session_id: id });
    return console.log(`已归档「${g.title}」，在 Codex 里用 codex unarchive 能找回。`);
  }
  if (s.pid) { console.log('这个对话正在运行，先关掉它的窗口再删。'); process.exit(1); }
  if (s.mac) { // a Mac's: its record (and its folder, if any) into that Mac's Trash, over ssh (tried again on a drop); the copy here goes too
    const m = macOf(s.mac, reg), folder = path.basename(path.dirname(s.file));
    if (!m) { console.log('找不到它所在的 Mac'); process.exit(1); }
    tokenStats(); // its replies counted first, as below: once its copy here goes, nothing has them (the watcher may drop it first)
    const cmd = `d=${m.config ? macSh(m.config) : '~/.claude'}/projects/${folder}; t=~/.Trash/claude-${id}; `
      + `mkdir -p "$t" && mv "$d/${id}.jsonl" "$t/" && { [ ! -d "$d/${id}" ] || mv "$d/${id}" "$t/"; }`;
    let r;
    for (let k = 0; k < 3 && r?.status !== 0; k++) r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', m.host, cmd], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) { console.log(`删除失败：${String(r.stderr || r.error?.message || '').trim().split('\n').pop()}`); process.exit(1); }
    fs.rmSync(s.file, { force: true }); fs.rmSync(s.file.slice(0, -6), { recursive: true, force: true });
    log('session_deleted', { session_id: id, mac: m.id });
    return console.log(`已删除「${s.title}」，在 ${m.label} 的废纸篓里能找回。`);
  }
  tokenStats();
  const paths = reg.profiles.flatMap((p) => ls(path.join(p.configDir, 'projects')).flatMap((folder) =>
    [`${id}.jsonl`, id].map((n) => path.join(p.configDir, 'projects', folder, n)))).filter((f) => fs.existsSync(f));
  const r = recycle(paths);
  if (r.status !== 0 || paths.some((f) => fs.existsSync(f))) { console.log(`删除失败：${(r.stderr || '').trim().split('\n')[0]}`); process.exit(1); }
  log('session_deleted', { session_id: id, files: paths.length });
  console.log(`已删除「${s.title}」，可以在${TRASH}里找回。`);
}
// Session 0 (ssh, a service) has no Recycle Bin: there it deletes for good without a word, so it's refused (exit 3)
function recycle(paths) {
  if (!WIN) { // macOS: moved into the Trash, a name of its own there (as Finder names a second one: name 2, name 3…), never over one
    const taken = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };
    try {
      for (const p of paths) {
        const t = path.join(HOME, '.Trash', path.basename(p));
        let to = t;
        for (let n = 2; taken(to); n++) to = `${t} ${n}`;
        fs.renameSync(p, to);
      }
      return { status: 0, stderr: '' };
    } catch (e) { return { status: 1, stderr: `没放进废纸篓：${e.message}` }; }
  }
  return recycled(spawnSync('powershell.exe', ['-NoProfile', '-Command', RECYCLE_PS], { env: { ...process.env, CM_DEL: JSON.stringify(paths) }, windowsHide: true, encoding: 'utf8' }));
}
const RECYCLE_PS = 'if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { exit 3 }; '
  + 'Add-Type -AssemblyName Microsoft.VisualBasic; foreach ($p in ($env:CM_DEL | ConvertFrom-Json)) { if (Test-Path -PathType Container $p) '
  + '{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, "OnlyErrorDialogs", "SendToRecycleBin") } '
  + 'else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, "OnlyErrorDialogs", "SendToRecycleBin") } }';
const recycled = (r) => { if (r.status === 3) r.stderr = '从 ssh 这类后台会话放不进回收站（会直接永久删除），所以没删：到电脑桌面上做'; return r; };
// the same in the web service, not holding it up: a file another program holds open brings up Windows' dialog, which
// waits for a click (given up on after 20 s, the dialog with it)
const recycleA = async (paths) => (WIN ? recycled(await execA('powershell.exe', ['-NoProfile', '-Command', RECYCLE_PS], { env: { ...process.env, CM_DEL: JSON.stringify(paths) }, timeout: 20000 })) : recycle(paths));
// remove's check, before an account leaves the list: its folder can go to the Recycle Bin from here
const canRecycle = () => { const r = recycle([]); if (r.status !== 0) { console.log(`没移除：${(r.stderr || '').trim().split('\n')[0]}`); process.exit(1); } };
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
  if (/^g[0-9]+$/i.test(x ?? '')) return removeGpt(Number(x.slice(1))); // a GPT account: G1, G2…
  if (/^a[0-9]+$/i.test(x ?? '')) return removeGemini(Number(x.slice(1))); // a Gemini account: A1, A2…
  const reg = load(), i = /^\d+$/.test(x ?? '') ? Number(x) - 1 : reg.profiles.findIndex((q) => q.id === x), p = reg.profiles[i];
  if (!p) { console.log('用法：claude-multi remove <账号编号或 id，如 acct-20261010-002>'); process.exit(1); }
  if (runsOn(p.configDir)) { console.log('这个账号上有 Claude 正在运行，先关掉再移除。'); process.exit(1); }
  canRecycle();
  tokenStats(); shareMemory(); // while it's still listed
  update((r) => {
    r.profiles = r.profiles.filter((q) => q.id !== p.id);
    (r.removed ??= []).push({ id: p.id, label: p.label, configDir: p.configDir });
    if (r.active === p.id) r.active = r.profiles[0]?.id ?? null;
  });
  log('profile_removed', { profile_id: p.id });
  let r = {}; // a link it couldn't take out: the folder stays (deleted for good past the Recycle Bin, it'd go through the link)
  try { unlinkAll(p.configDir); r = recycle([p.configDir]); } catch {}
  if (fs.existsSync(p.configDir)) console.log(`已移除账号 ${p.label}，但文件夹没能放进${TRASH}（${(r.stderr || '').trim().split('\n')[0] || '可能有程序开着里面的文件'}），可以之后手动删：${p.configDir}`);
  else console.log(`已移除账号 ${p.label}，文件夹在${TRASH}里。`);
}

// True while a helper the conversation started is still at work, read from its transcript's tail. With
// teammates or background tasks, Claude ends a turn each time one of them reports in, long before the job
// is done. A teammate ("Spawned successfully") works until its idle_notification, and again after each
// SendMessage to it; a background agent or command ("Async agent launched", "Command running in
// background") until a task-notification names its tool call.
// Helpers started before this Claude process (since) died with the previous one, when the conversation was
// closed and resumed. ponytail: ones over 6 h old count as gone too, in case their end fell outside the tail
function helpersBusy(tail, since = 0) {
  const busy = new Map(), spawns = new Map(), team = new Set(), tasks = new Map(); // tasks: a background task's id → its launch
  for (const line of tail.split('\n')) {
    if (line.length > 262144) continue; // an image or long output, never a marker: skipping keeps this fast
    let j;
    try { j = JSON.parse(line); } catch { continue; } // the slice's cut-off first line
    if (j.isSidechain) continue;
    const at = Date.parse(j.timestamp) || Date.now();
    const parts = Array.isArray(j.message?.content) ? j.message.content : [];
    // (a task's end delivered mid-turn comes as an attachment, its words in .prompt)
    let text = typeof j.message?.content === 'string' ? j.message.content : typeof j.content === 'string' ? j.content : typeof j.attachment?.prompt === 'string' ? j.attachment.prompt : '';
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
        else if (/^(Async agent launched|Command running in background)/.test(r)) {
          busy.set(p.tool_use_id, at);
          const id = /\b(?:ID|agentId)\s*[:=]\s*([\w-]+)/i.exec(r)?.[1]; // what TaskStop names it by
          if (id) tasks.set(id, p.tool_use_id);
        }
        // stopped by Claude itself (TaskStop): no task-notification ever comes for it, so it's done here
        else if (/(?:stopped task|killed shell):?\s*([\w-]+)/i.test(r)) busy.delete(tasks.get(/(?:stopped task|killed shell):?\s*([\w-]+)/i.exec(r)[1]));
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

// What Claude said last, for a notification: its answer (its words after its last tool call), the opening paragraph
// where it says how it went (the next ones too while that's a few words, "好的。"), without Markdown, cut short. Its
// "No response requested." to a background message isn't an answer.
function gist(tail, max = 150) {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    let j; try { j = JSON.parse(lines[i]); } catch { continue; }
    const t = j.type === 'assistant' && !j.isSidechain ? (j.message?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n') : '';
    const g = gistText(t, max);
    if (g) return g;
  }
  return '';
}
// a reply's gist (a GPT one's too, from its record): its first paragraph, code blocks out, flattened; '' for none
function gistText(t, max = 150) {
  const paras = String(t ?? '').replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const flat = (p) => p.replace(/[*`#>|]/g, '').replace(/^\s*[-•]\s+/gm, '').replace(/\s+/g, ' ').trim();
  if (!paras.length || /^No response requested\.?$/i.test(flat(paras.join(' ')))) return '';
  let s = flat(paras[0]);
  for (const p of paras.slice(1)) { // after "好的。": the next words, not a heading or a table
    if (s.length >= 12) break;
    if (!/^(#|\|)|^\*\*[^*\n]+\*\*[:：]?$/.test(p)) s += ` ${flat(p)}`;
  }
  return s.length > max ? s.slice(0, max) + '…' : s;
}
// a note as a phone shows it: what happened in the title, with the conversation's name; what it said under it. Claude
// asks "needs your permission" for a question as for a tool, mostly without saying which: one case, waiting for you.
function pushText(n) {
  const name = n.title || n.project || 'Claude', tool = /^想使用 (.+)，等你确认$/.exec(n.msg ?? '')?.[1];
  if (n.kind !== 'ask') return { title: `✅ ${name}`, body: n.gist || '回复完了' };
  return { title: `⏸ ${name} 等你确认`, body: `${tool && tool !== 'AskUserQuestion' ? `想用 ${tool}。` : ''}${n.gist || '打开看看它在问什么'}` };
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
  if (kind === 'done' && (lastTyped(tail) ?? '').startsWith('[系统通知]')) return; // the service woke it: not your news
  // the conversation's title, which its terminal tab shows: lets the island drop it once you look
  // (the 管家's is 管家, wherever it shows: the island, the page, the phone)
  // (/rename's sidecar first, as the list reads it: its line may be out of the tail)
  let named = null; try { named = JSON.parse(fs.readFileSync(path.join(j.transcript_path.slice(0, -6), 'custom-title.json'), 'utf8')).customTitle; } catch {}
  const title = sameDir(home || j.cwd || '.', BUTLER) ? '管家' : named || field(tail, 'customTitle', true) || field(tail, 'aiTitle', true);
  // the folder the conversation was opened in: the hook's cwd is wherever Claude last cd'd (a .build inside it, say)
  const dir = home || j.cwd;
  dropNote({ kind, project: dir ? path.basename(dir) : '', msg, title, id: j.session_id ?? null }, Number(process.env.CLAUDE_PID) || null);
}
// A note out: to the island's inbox (written to .tmp then renamed: it reads every 300 ms), with the Claude's pid that lets
// a click find its terminal window; and for the pages and phones, the notes file, which lists the latest ones (trimmed to
// its last 200 now and then). Then the island, made sure it runs.
let noteSeq = 0;
function dropNote(n, pid = null) {
  if (!islandOff()) {
    fs.mkdirSync(INBOX, { recursive: true });
    const f = path.join(INBOX, `${Date.now()}-${process.pid}-${++noteSeq}`); // (two in one millisecond: both kept)
    fs.writeFileSync(`${f}.tmp`, JSON.stringify({ ...n, pid }));
    fs.renameSync(`${f}.tmp`, `${f}.json`);
  }
  fs.appendFileSync(NOTES, JSON.stringify({ at: Date.now(), ...n }) + '\n');
  try { // trimmed whole or not at all: a page reading it then never gets half
    if (fs.statSync(NOTES).size > 262144) {
      const tmp = `${NOTES}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, readNotes(200).reverse().map((x) => JSON.stringify(x)).join('\n') + '\n');
      try { fs.renameSync(tmp, NOTES); } catch { fs.rmSync(tmp, { force: true }); }
    }
  } catch {}
  island();
}

// chats [arrange|tokens]: opens the island's conversation window, its window-arranging board or its token
// page, through the inbox.
function chats(page) {
  if (islandOff()) { console.log('灵动岛在网页的设置里关了，先在那里打开它'); return; }
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
  if (islandOff()) return;
  // ponytail: a crashed island's pid reused by another process skips the start; the login shortcut recovers it
  try { process.kill(Number(fs.readFileSync(`${ISLAND}.pid`, 'utf8')), 0); return; } catch {} // already up: skip ~1.5 s
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '
    + `'-NoProfile -STA -ExecutionPolicy Bypass -File "${ISLAND}"'`], { stdio: 'ignore', windowsHide: true });
}

const WINDOWS = [['five_hour', '5 小时'], ['seven_day', '7 天'], ['seven_day_opus', 'Opus 7 天'], ['seven_day_sonnet', 'Sonnet 7 天']];
const readyAt = (u) => Math.max(0, ...WINDOWS.map(([k]) => u[k])
  .filter((w) => w && w.utilization >= 100 && w.resets_at).map((w) => +new Date(w.resets_at)));
// A Mac's usage, read there at most every 5 minutes (a long-running caller, the web service: each read is a new ssh
// through the server, and one more request from that Mac to Anthropic); macFresh (刷新, 预热) reads it now
const MAC_USAGE_EVERY = 5 * 60000, macUsageSeen = new Map(); // id: {at, r}
const macUsageNow = (m, fresh) => {
  const was = macUsageSeen.get(m.id);
  if (!fresh && was && Date.now() - was.at < MAC_USAGE_EVERY) return was.r;
  const r = macUsage(m);
  macUsageSeen.set(m.id, { at: Date.now(), r });
  return r;
};
// Every account's usage and the pick. json is what the island and the web page read.
async function usageState(reg = load(), { macFresh = false } = {}) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(USAGE_CACHE, 'utf8')); } catch {}
  const macs = macList(reg);
  const [got, states, macGot] = await Promise.all([Promise.all(reg.profiles.map(fetchUsage)), Promise.all(reg.profiles.map((p) => subState(p, cache))),
    Promise.all(macs.map((m) => macUsageNow(m, macFresh)))]);
  const res = keepLast(reg.profiles, got, cache);
  const macRes = keepLast(macs, macGot, cache); // the Macs', apart: none of the accounts here, never recommended
  // counted only with an account at its limit (the island's notice is all that needs it): listing costs a PowerShell
  const running = res.some((r) => WINDOWS.some(([k]) => Math.round(r.u?.[k]?.utilization) >= 100)) ? listSessions(reg).filter((s) => s.pid) : [];
  // whole or not at all: the island and the web service both write it, and a half-written one read would lose them all
  try { fs.writeFileSync(`${USAGE_CACHE}.${process.pid}`, JSON.stringify(cache)); fs.renameSync(`${USAGE_CACHE}.${process.pid}`, USAGE_CACHE); } catch {}
  const ok = res.map((r, i) => ({ ...r, i })).filter((r) => r.u);
  const open = ok.filter((r) => runway(r.u) > 0);
  const rec = open.length ? pickOpen(open) : [...ok].sort((a, b) => readyAt(a.u) - readyAt(b.u))[0];
  // API accounts only (a Mac's, 申请接入's): no quota to read, the first one not refused is the one to use
  const api = reg.profiles.length && reg.profiles.every((p) => p.api) ? res.findIndex((r) => r.api && !r.err) : -1;
  // One column per window. Model windows get a column only once some account used them.
  const cols = WINDOWS.filter(([k]) => !k.startsWith('seven_day_') || ok.some((r) => r.u[k]?.utilization));
  const json = { rec: api >= 0 ? api : rec?.i ?? null, open: open.length > 0 || api >= 0,
    ready: !open.length && rec ? until(readyAt(rec.u)) : null,
    accounts: reg.profiles.map((p, i) => ({ label: p.label, dir: p.configDir, err: res[i].err ?? null, api: !!res[i].api,
      runway: res[i].u ? Math.round(runway(res[i].u) * 10) / 10 : null,
      windows: cols.filter(([k]) => res[i].u?.[k]).map(([k]) => ({ k, pct: Math.round(res[i].u[k].utilization),
        reset: res[i].u[k].resets_at ? until(res[i].u[k].resets_at) : '' })), sub: subscription(p, states[i]),
      running: running.filter((s) => s.acct === i).length })), // conversations running on it: the island's notice at its limit
    macs: macs.map((m, i) => { const mac = macRes[i], sub = macGot[i].sub; return { id: m.id, label: m.label, dir: m.dir, icon: m.icon ?? null, err: mac.err ?? null,
      plan: sub ? `Claude ${sub[0].toUpperCase()}${sub.slice(1)}` : null, runway: mac.u ? Math.round(runway(mac.u) * 10) / 10 : null,
      windows: WINDOWS.filter(([k]) => mac.u?.[k] && (!k.startsWith('seven_day_') || mac.u[k].utilization)).map(([k]) => ({ k, pct: Math.round(mac.u[k].utilization),
        reset: mac.u[k].resets_at ? until(mac.u[k].resets_at) : '' })) }; }),
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
  const renew = (p.renewOn && nextRenewal(new Date(`${p.renewOn}T00:00:00`), new Date(), true)) || nextRenewal(since); // a day set wrong: guessed
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
  if (isNaN(since)) return null; // no date has no anniversary: the loop below would never end
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()), first = new Date(since.getFullYear(), since.getMonth(), since.getDate());
  for (let m = now.getMonth(); ; m++) {
    const d = new Date(now.getFullYear(), m, Math.min(since.getDate(), new Date(now.getFullYear(), m + 1, 0).getDate()));
    if (d >= today && (onIt ? d >= first : d > first)) return d;
  }
}

async function usage(args) {
  const reg = load();
  // --json is the island's: JSON whatever there is (no Claude account, the GPT ones still in it)
  if (!reg.profiles.length && !args.includes('--json')) return console.log('没有已保存账号，请先运行 claude-multi new。');
  const bar = (pct) => {
    const n = Math.round(Math.min(100, pct) / 10);
    return c(pct >= 80 ? 31 : pct >= 50 ? 33 : 32, '█'.repeat(n)) + c(2, '░'.repeat(10 - n));
  };
  const { res, ok, open, rec, cols, json } = await usageState(reg);
  // same numbers as the table below; and each GPT account's usage, as its records last said it (the island's GPT cards)
  if (args.includes('--json')) return console.log(JSON.stringify({ ...json, gpt: gptAccounts(reg).map((g) => ({ label: g.label, plan: g.plan, ...(gptUsage(g.home) ?? { windows: null }) })) }));
  const lw = Math.max(...reg.profiles.map((p) => width(p.label)));
  const pw = Math.max(...reg.profiles.map((p) => width(p.subscriptionType ?? '')));
  const cell = (w) => (w ? `${bar(w.utilization)} ${String(Math.round(w.utilization)).padStart(3)}%  `
    + c(2, pad(w.resets_at ? until(w.resets_at) : '', 10)) : ' '.repeat(27)); // 10 + 1 + 4 + 2 + 10 cols
  console.log(`\n  ${c(1, 'Claude 账号用量')}  ${c(2, new Date().toLocaleString('zh-CN', { hour12: false }))}\n`);
  console.log(c(2, ' '.repeat(9 + lw + pw) + cols.map(([, name]) => '   ' + pad(name, 17) + pad('距重置', 10)).join('')));
  reg.profiles.forEach((p, i) => {
    const mark = p.id === reg.active ? '*' : ' ';
    const tag = rec?.i === i ? '  ' + c('1;32', open.length ? '← 推荐' : '← 最早恢复') : '';
    const cells = res[i].err ? c(33, res[i].err) : res[i].api ? c(2, 'API：没有额度窗口，按用量计费') : cols.map(([k]) => cell(res[i].u[k])).join('   ');
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
// (tunnel.json: ssh, a host in ~/.ssh/config; url), whose nginx serves url over HTTPS and passes it all to the tunnel's
// end there. The page runs Claude here, so it opens only with the key (web-key): `claude-multi web-link` prints a
// link with it, and a browser that opened the link keeps it as a cookie. `web-link new` makes a new key: every
// browser that had the old one is out.
const NOTES = path.join(ROOT, 'notes.jsonl');
const WEB_TERMS = path.join(ROOT, 'web-terms.json'); // pids of the Claudes running in the web service
const WEB_RUN = path.join(ROOT, 'web-running.json'); // the conversations running in it (their ids): continued after a restart
const WEB_USAGE = path.join(ROOT, 'web-usage.json'); // the quota as the page last got it
const WEB_PORT = 7788;
const BUTLER = path.join(__dirname, 'butler'), BUTLER_MODELS = ['sonnet', 'opus', 'haiku'], BUTLER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']; // the page's 管家 runs here (its CLAUDE.md beside the code); its newest conversation is the 管家
// The 管家's tickets (as in DeepSeek's Super-agent): what you asked for, fixed once written (its 原话, 做到什么算完,
// 约束); the conversation doing it; what that one reported, and when its turns ended. Only the web service writes the
// file. Where one stands is worked out from those facts (stageOf), never from words the 管家 wrote.
const TICKETS = path.join(ROOT, 'tickets.json');
function readTickets(f = TICKETS) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; } }
// A folder here, as 新对话 and 浏览 take one: not a network one (\\host\share, //host/share: only looking there makes
// Windows connect to that computer and offer it this login's hash), and there
const netPath = (d) => /^[\\/]{2}/.test(String(d ?? ''));
const isDir = (d) => !netPath(d) && fs.existsSync(d) && fs.statSync(d).isDirectory();
// 新对话's 浏览: the folders in p by name, dot ones last (no links, nor Windows' $Recycle.Bin and the like), its files'
// names (shown dimmed, to know the folder by), and the one above ('' at a drive's top); no p: the places (the home
// folder, its 桌面 文档 下载, the drives). Read without blocking the service: a slow or gone drive holds this answer only.
async function dirsIn(p) {
  const there = (d) => fs.promises.access(d).then(() => d, () => null);
  if (!p) {
    const drives = process.platform !== 'win32' ? ['/'] : [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `${l}:\\`);
    const dirs = await Promise.all([HOME, ...['Desktop', 'Documents', 'Downloads'].map((n) => path.join(HOME, n)), ...drives].map(there));
    return { path: '', up: null, dirs: dirs.filter(Boolean), files: [] };
  }
  if (netPath(p)) throw new Error('网络上的文件夹（\\ 开头）不能浏览');
  const at = path.resolve(p), up = path.dirname(at);
  let es; try { es = await fs.promises.readdir(at, { withFileTypes: true }); } catch { throw new Error(`打不开 ${at}`); }
  const names = (f) => es.filter(f).map((e) => e.name).sort((a, b) => (a[0] === '.') - (b[0] === '.') || a.localeCompare(b, 'zh'));
  const dirs = names((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information');
  // shortcut: a folder's first 500 folders and 500 files only; past that, typed
  return { path: at, up: up === at ? '' : up, dirs: dirs.slice(0, 500).map((n) => path.join(at, n)), files: names((e) => e.isFile()).slice(0, 500) };
}
// 项目: your own groups of conversations, from any folder, account or Mac (the page's 项目 view), [{id, name, at, ids}].
// Only the web service writes the file. A conversation not in the list stays in its project (a look can miss one).
const PROJECTS = path.join(ROOT, 'projects.json');
function readProjects(f = PROJECTS) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; } }
// one change: new {name}, rename {id, name}, drop {id}, add / out {id, conv: [conversation ids]}
function projectOp(all, b, now = Date.now()) {
  const p = b.op === 'new' ? null : all.find((x) => x.id === Number(b.id));
  if (b.op !== 'new' && !p) throw new Error('没有这个项目');
  if (b.op === 'new' || b.op === 'rename') {
    const name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) throw new Error('项目要有名字');
    if (all.some((x) => x !== p && x.name === name)) throw new Error(`已经有叫「${name}」的项目了`);
    if (p) { p.name = name; return p; }
    const n = { id: Math.max(0, ...all.map((x) => x.id)) + 1, name, at: now, ids: [] };
    all.push(n);
    return n;
  }
  if (b.op === 'drop') { all.splice(all.indexOf(p), 1); return { id: p.id }; } // its conversations stay where they are
  const ids = [].concat(b.conv ?? []).map(String);
  if (!ids.length || ids.some((i) => !/^[\w-]{1,80}$/.test(i))) throw new Error('缺少对话 id');
  if (b.op === 'add') { p.ids = [...new Set([...p.ids, ...ids])]; return p; }
  if (b.op === 'out') { p.ids = p.ids.filter((i) => !ids.includes(i)); return p; }
  throw new Error('不认识的操作');
}
const REPORT_WORDS = ['做完', '卡住', '失败', '不用做']; // what a worker reports (claude-multi report N <word> …); ask is apart
// one change, as the service makes it: new, give (to a conversation), report (a worker's word or question), end. What
// you asked for is never changed: no op touches it.
function ticketOp(all, b, now = Date.now()) {
  const [tid, gn] = String(b.id ?? '').split('-'), t = b.op === 'new' ? null : all.find((x) => x.id === Number(tid));
  if (b.op !== 'new' && !t) throw new Error(`没有工单 #${b.id}`);
  if (t?.end) throw new Error(`工单 #${t.id} 已经结束了`);
  const add = (k, text) => { (t.ev ??= []).push({ at: now, k, text: String(text ?? '') }); t.ev.splice(0, Math.max(0, t.ev.length - 60)); };
  if (b.op === 'new') {
    if (!b.name || !b.ask) throw new Error('工单要有名字（ticket new 后面那段）和用户的原话（--ask）');
    const n = { id: Math.max(0, ...all.map((x) => x.id)) + 1, name: String(b.name), at: now, ask: String(b.ask), done: String(b.done ?? ''),
      limits: String(b.limits ?? ''), inferred: !!b.inferred, conv: null, ev: [] };
    all.push(n);
    return n;
  }
  if (b.op === 'give') {
    if (!b.conv) throw new Error('要派给哪个对话？');
    const other = all.find((x) => x !== t && !x.end && x.conv === String(b.conv)); // its turns couldn't be told apart
    if (other) throw new Error(`这个对话已经在做工单 #${other.id}「${other.name}」，先结束它（ticket end），或者换一个对话`);
    // already on it: the number stays (its worker's reports carry it); more to say goes by chat say
    if (String(b.conv) === t.conv) throw new Error(`工单 #${t.id} 已经在这个对话上了，补充说明用 chat say`);
    if (b.n != null && Number(b.n) !== (t.n ?? 0) + 1) throw new Error(`工单 #${t.id} 刚被改派过，再用 ticket 看一下`); // its brief has that number
    t.conv = String(b.conv); t.n = (t.n ?? 0) + 1; add('give', b.title || b.conv);
    return t;
  }
  if (b.op === 'report') {
    if (b.k !== 'ask' && !REPORT_WORDS.includes(b.k)) throw new Error(`报告只能是：${REPORT_WORDS.join('、')}`);
    if (!String(b.text ?? '').trim()) throw new Error(b.k === 'ask' ? '要问什么？' : '写一句话说明');
    // from the conversation it's given to now: one it was taken from may still be running, and report late
    if (Number(gn) !== t.n) throw new Error(`工单 #${t.id} 已经改派给别的对话了，你这边的结果不算数，停下就行`);
    add(b.k, b.text);
    return t;
  }
  if (b.op === 'end') { t.end = { at: now, how: b.how === 'stop' ? 'stop' : 'done', text: String(b.text ?? '') }; return t; }
  throw new Error('不认识的操作');
}
// Where a ticket stands, the first that holds (DeepSeek's order, what waits on you first): [stage, group, text]. s: its
// conversation as listed now. A turn that ended with no report leaves it 停下了 (it doesn't go on by itself), with its
// last words; what it reported counts for the turn it was said in, so a question answered (a new turn) is gone.
const STAGE_ORDER = ['you', 'stuck', 'ask', 'idle', 'queue', 'work', 'end'];
function stageOf(t, s) {
  if (t.end) return [t.end.how === 'stop' ? '已停' : '完成', 'end', t.end.text];
  if (!t.conv) return t.inferred ? ['建议', 'you', '管家自己提的，你同意了才开工'] : ['没派人', 'queue', ''];
  if (s?.busy) return ['在做', 'work', ''];
  if (s?.wait) return ['等确认', 'ask', '它停在一个确认或选择题上'];
  const all = t.ev ?? [], ev = all.slice(all.findLastIndex((e) => e.k === 'give') + 1); // since it was given to this one
  const stops = ev.filter((e) => e.k === 'stop'), from = stops.at(-2)?.at ?? 0, to = stops.at(-1)?.at ?? Infinity;
  const said = ev.filter((e) => e.at > from && e.at <= to), q = said.filter((e) => e.k === 'ask').at(-1), r = said.filter((e) => REPORT_WORDS.includes(e.k)).at(-1);
  if (q) return ['等你回答', 'you', q.text];
  if (r?.k === '做完' || r?.k === '不用做') return [r.k === '做完' ? '等你验收' : '它说不用做', 'you', r.text];
  if (r) return [r.k === '失败' ? '失败' : '卡住了', 'stuck', r.text];
  return ['停下了', 'idle', s?.pid ? (stops.at(-1)?.text ?? '') : '没在运行'];
}
// The notes tickets haven't taken yet: all of the file (notify keeps it under 256 KB: a backlog of any length a restart
// leaves is there), after where the last service left off (its file; none: from the start, which notesInto makes safe),
// each 1.5 s old at least (Claude writes its last words after the note), oldest first.
// ponytail: notify trims the file to its last 200 notes past 256 KB: more than that piling up unread would lose the rest
const TICKETS_SEEN = path.join(ROOT, 'tickets-seen.json');
function readSeen(f = TICKETS_SEEN) { try { return Number(JSON.parse(fs.readFileSync(f, 'utf8'))) || 0; } catch { return 0; } }
function allNotes(f = NOTES) { try { return fs.readFileSync(f, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } }); } catch { return []; } }
const notesUnseen = (notes, seenTo, now = Date.now()) => notes.filter((n) => n.at > seenTo && now - n.at > 1500);
// and what they do to the open tickets: a turn ended (done) is kept with its last words (what it stopped on), one stopped
// on a question as held; each is news for the 管家. Taken twice (the tickets saved, the place not, when the service
// ended), a note changes nothing: each is kept once, by its time, and only those after the ticket was given to this
// conversation count. The ids of the tickets with news; a turn you set going yourself (quiet) is kept, not news: you're
// there, the 管家 stays out of it. Unless the worker reported in it (做完, a question): that still goes to the 管家, to
// check the result against what you asked and close the ticket.
function notesInto(all, notes, words, quiet = () => false) {
  const news = new Set();
  for (const n of notes) for (const t of all) {
    if (!n.id || t.end || t.conv !== n.id) continue;
    const ev = t.ev ?? [], given = ev.findLast((e) => e.k === 'give')?.at ?? 0;
    if (n.at <= given || ev.some((e) => (e.k === 'stop' || e.k === 'held') && e.at === n.at)) continue;
    const from = ev.findLast((e) => e.k === 'stop')?.at ?? given, said = ev.some((e) => (e.k === 'ask' || REPORT_WORDS.includes(e.k)) && e.at > from && e.at <= n.at);
    (t.ev ??= []).push(n.kind === 'done' ? { at: n.at, k: 'stop', text: words(n.id) } : { at: n.at, k: 'held', text: '' });
    t.ev.splice(0, Math.max(0, t.ev.length - 60));
    if (!quiet(n) || said) news.add(t.id);
  }
  return [...news];
}
// Who set a conversation's turn going: what was last typed there (lastTyped: the words, unwrapped; a background task
// finishing doesn't change it) against what the 管家 typed there (its log, the first
// 40): 'butler' (those words, sent in the 6 hours before the turn ended), 'you' (anything else typed), null (none read).
// Whoever set it going gets its end: the 管家 a notice, you a push.
function turnBy(prompt, sent, at) {
  const flat = (t) => String(t ?? '').replace(/\s+/g, ' ').trim(), p = flat(prompt);
  if (!p) return null;
  // the log keeps a message whole up to 40 characters, else its first 40: a short one (「继续」) must be the very words,
  // or the user's own 「继续做第三部分」 would pass for it
  const same = (s) => { const w = flat(s.text); return s.text.length >= 40 ? p.startsWith(w) : p === w; };
  return sent.some((s) => s.at <= at + 60000 && at - s.at < 6 * 3600e3 && same(s)) ? 'butler' : 'you';
}
// of the tickets queued for the 管家: those to tell now, each as it stands, and those kept (back at work, or so a list read
// a moment ago says: told once they stop)
function tellSplit(ids, tickets, list) {
  const items = [], keep = [];
  for (const id of ids) {
    const t = tickets.find((x) => x.id === id), st = t && !t.end && stageOf(t, list.find((x) => x.id === t.conv));
    if (st) (st[1] === 'work' ? keep.push(id) : items.push({ t, st }));
  }
  return { items, keep };
}
// of those a notice didn't get through for, the ones told again: twice at most each, counted for each ticket apart (a
// batch that kept missing doesn't use up the next one's)
const tellAgain = (tries, ids) => ids.filter((i) => { const c = (tries.get(i) ?? 0) + 1; if (c > 2) { tries.delete(i); return false; } tries.set(i, c); return true; });
// the one notice the 管家 gets: the tickets that moved, each as it stands now (the panel's 你 is the user here), and the
// conversations it asked something outside a ticket that answered (or stopped on a question)
function butlerNotice(items, replies = []) {
  const clip = (t) => (t.length > 300 ? t.slice(0, 300) + '…' : t);
  const say = ({ t, st: [stage, , text] }) => `#${t.id}「${t.name}」${stage.replace('你', '用户')}${text ? '：' + clip(text) : ''}`;
  const back = (r) => (r.kind === 'ask' ? `「${r.title}」在你发消息后停在一个确认上（chat look 看它在问什么）` : `「${r.title}」回复了你发的消息${r.text ? '：' + clip(r.text) : ''}`);
  return '[系统通知] ' + [items.length && `工单有动静：${items.map(say).join('；')}。按规矩处理：停下了的推它继续或告诉用户；等用户回答、验收的，攒起来告诉用户；等确认的先 chat look 看它在问什么。`,
    replies.length && `${replies.map(back).join('；')}。你答应过回头告诉用户的，现在告诉用户。`].filter(Boolean).join(' ');
}
// The 管家's waits in the background (chat wait), a file each while it runs; one whose process is gone (a restart
// ended it) is dropped. The soonest first.
const WAITS = path.join(ROOT, 'waits');
function waitsNow(dir = WAITS) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  const out = [];
  for (const n of names) {
    const p = path.join(dir, n);
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (alive(j.pid)) out.push(j); else fs.rmSync(p, { force: true }); } catch {}
  }
  return out.sort((a, b) => (a.until ?? Infinity) - (b.until ?? Infinity) || a.at - b.at);
}
// What the 管家 did, for the 操作台's 今天: a line each, the file kept short
const BLOG = path.join(ROOT, 'butler-log.jsonl');
function blog(text, id = null) {
  try {
    fs.appendFileSync(BLOG, JSON.stringify({ at: Date.now(), text, id }) + '\n');
    if (fs.statSync(BLOG).size > 262144) fs.writeFileSync(BLOG, fs.readFileSync(BLOG, 'utf8').split('\n').slice(-1000).join('\n'));
  } catch {}
}
// what it typed into a conversation (给「…」发了消息：…, 新开了对话（…）：…), the words as logged (their first 40), read
// again when the log changes
let blogMemo = { at: -1, list: [] };
// a long paste as Claude Code records it, inside <pasted_content id="N"> … </pasted_content id="N">: the words alone (as
// the page shows it), for what checks how a message begins
const unwrapPaste = (t) => String(t ?? '').replace(/<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content id="[^"]*">/g, '$1').trim();
function blogSent(id) {
  let at = 0; try { at = fs.statSync(BLOG).mtimeMs; } catch { return []; }
  if (at !== blogMemo.at) {
    const list = [];
    for (const l of fs.readFileSync(BLOG, 'utf8').split('\n')) try {
      const j = JSON.parse(l), m = /^(?:给「[^」]*」发了消息|新开了对话（[^）]*）)：([\s\S]+)$/.exec(j.text ?? '');
      if (m && j.id) list.push({ id: j.id, at: j.at, text: m[1].replace(/…$/, '').trim() });
    } catch {}
    blogMemo = { at, list };
  }
  return blogMemo.list.filter((s) => s.id === id);
}
// /model and /effort typed into a running Claude also save the choice as every new conversation's default (its
// account's settings.json, which the accounts share): what those files say now, and a way to put it back (a key that
// wasn't there goes again). ponytail: a default you change by hand in those 8 s is put back too
function keepDefaults(files) {
  const was = files.flatMap((f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return [[f, j.model, j.effortLevel]]; } catch { return []; } });
  return () => {
    for (const [f, model, effortLevel] of was) try {
      const raw = fs.readFileSync(f, 'utf8'), j = JSON.parse(raw), set = (k, v) => { if (v === undefined) delete j[k]; else j[k] = v; };
      if (j.model === model && j.effortLevel === effortLevel) continue;
      set('model', model); set('effortLevel', effortLevel);
      fs.writeFileSync(f, JSON.stringify(j, null, /\n( +)"/.exec(raw)?.[1] ?? 2) + (raw.endsWith('\n') ? '\n' : ''));
    } catch {}
  };
}
// The server, from tunnel.json here (not in the repository): {"ssh": "myserver", "url": "https://<its address>:8443"}.
// Without it there is no tunnel: the page opens on this computer only. sock: the tunnel's end on the server.
let TUNNEL = null;
try { TUNNEL = { sock: '/run/claude-multi.sock', ...JSON.parse(fs.readFileSync(path.join(ROOT, 'tunnel.json'), 'utf8').replace(/^﻿/, '')) }; } // a BOM: PowerShell 5's files
catch (e) { if (e.code !== 'ENOENT') console.error(`tunnel.json 读不了，远程访问没开：${e.message}`); }
const WEB_URL = TUNNEL?.url ?? `http://127.0.0.1:${WEB_PORT}`;
const WEB_KEY = path.join(ROOT, 'web-key');

function webKey(fresh = false) { // made on first use; in the user's own folder, as each account's login is
  if (!fresh) try { const k = fs.readFileSync(WEB_KEY, 'utf8').trim(); if (k.length >= 32) return k; } catch {}
  const k = require('crypto').randomBytes(32).toString('base64url');
  fs.writeFileSync(`${WEB_KEY}.tmp`, k); fs.renameSync(`${WEB_KEY}.tmp`, WEB_KEY); // whole: a reader meanwhile never sees it empty (and makes its own)
  return k;
}
// true when given (from the link or the cookie) is the key; in constant time
function keyMatch(given, key) {
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(key);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}
const keyCookie = (cookie) => /(?:^|;\s*)cm=([^;]+)/.exec(cookie ?? '')?.[1];
// A request's JSON body (its chunks: req, or any list of Buffers), read whole as bytes and decoded once: a chunk decoded
// on its own broke a Chinese character or an emoji cut between two (the JSON still parsed, the words were wrong).
// undefined (which no JSON is) past max bytes.
async function jsonBody(chunks, max = 1 << 20) {
  const parts = []; let size = 0;
  for await (const ch of chunks) { if ((size += ch.length) > max) return undefined; parts.push(ch); }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
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
  // (said in it since: a Claude one's by its record; a Gemini one's, listGemini has when: said)
  const all = marks.get('*') ?? 0, files = new Map(list.filter((s) => s.file).map((s) => [s.id, s.file])), said = new Map(list.filter((s) => s.gem).map((s) => [s.id, s.said ?? 0])), seen = new Set();
  return notes.filter((n) => {
    const k = n.id ?? n.at;
    if (seen.has(k)) return false;
    seen.add(k);
    return n.at > all && n.at > (marks.get(n.id) ?? 0) && !(files.has(n.id) && lastSaid(files.get(n.id)) > n.at) && !((said.get(n.id) ?? 0) > n.at);
  }).slice(0, 10);
}

// A conversation's record as readable messages, for the page's 记录 view (a window here only shows its
// current screen): what you said, Claude's replies, one line per tool call. Tool output, thinking and
// Claude's own bookkeeping (reminders, background-task notices) are left out. Read in pieces, as byte ranges of
// the file that start at a line: no range given, the last 16 MB; {end}, the 16 MB before end (scrolling back);
// {from}, from there to the end (the newest piece, read again as it grows). start comes back for the next ask.
// What you said on a record line, as parts (text, image): a message, or one sent while Claude was at work, taken in
// later (a queued command, its prompt plain text, or parts when it carries a picture).
function said(j) {
  const c = j.type === 'attachment' ? j.attachment?.prompt : j.message?.content;
  return typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
}
// A first look (no from) gets its last keep items or so, from the start of a message of yours: the page draws them at
// once (all 16 MB of a long one froze it for a second), and asks for the ones before (end: start) as you scroll up.
function history(file, { from, end, keep = 120 } = {}) {
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
  const add = (role, text, at) => { // whole, however long: the page folds a long one, and its 复制 copies all of it
    text = String(text ?? '').trim();
    if (text) out.push({ role, text, at, pos: here });
  };
  let next = a + skip, here = 0; // where each line starts in the file: a picture in it is fetched from there (recordImage)
  const byParent = new Map(); // a line your message hangs on → that message's items
  for (const l of lines) {
    const pos = next;
    here = pos; next += Buffer.byteLength(l) + 1;
    if (!l.includes('"type":"user"') && !l.includes('"type":"assistant"') && !l.includes('"queued_command"') && !l.includes('"turn_duration"')) continue;
    if (l.includes('"structuredPatch":')) { // an Edit's or a Write's result: the file, its lines added and taken out
      try { const j = JSON.parse(l), e = !j.isSidechain && editOf(j.toolUseResult); if (e) out.push({ role: 'edit', ...e, at: Date.parse(j.timestamp) || 0, pos: here }); } catch {}
      continue;
    }
    if (l.includes('"type":"tool_result"')) continue; // tool output, often huge (screenshots): not shown, not parsed
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (j.isMeta || j.isSidechain) continue;
    const at = Date.parse(j.timestamp) || 0, c = j.message?.content;
    const queued = j.attachment?.type === 'queued_command' && j.attachment.origin?.kind === 'human'; // sent while Claude was at work
    if (j.type === 'attachment' && !queued) continue;
    if (j.type === 'system') { // Claude's turn over: how long it took, in ms
      if (j.subtype === 'turn_duration' && j.durationMs > 0) add('done', String(j.durationMs), at);
    } else if (j.type === 'user' || queued) {
      if (j.isCompactSummary) { add('note', '更早的内容已压缩', at); continue; }
      const parts = said(j), first = out.length;
      // your pictures (pasted, dragged in, sent from the page) above what you wrote: "line.k", the line's place and
      // which picture in it. The text has an [Image #N] for each, the page leaves those out.
      parts.filter((p) => p.type === 'image').forEach((p, k) => add('img', `${pos}.${k}`, at));
      for (const p of parts) {
        if (p.type !== 'text') continue;
        let t = p.text.trim();
        // a background task of Claude's over: it was woken by it, what it says next is about that (a line, not yours)
        if (t.startsWith('<task-notification>')) {
          const what = /"([^"]+)"/.exec(/<summary>([\s\S]*?)<\/summary>/.exec(t)?.[1] ?? '')?.[1];
          add('note', `⏳ 后台的事${/<status>completed</.test(t) ? '有结果了' : '结束了'}${what ? `：${what}` : ''}`, at);
          continue;
        }
        // Claude's own bookkeeping, and what another Claude session (a teammate, a subagent) sent it: not yours
        if (/^(?:Another Claude session sent a message:\s*)?<(task-notification|teammate-message|local-command-stdout|local-command-caveat|system-reminder)/.test(t)) continue;
        const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
        if (cmd) t = `${cmd[1]} ${/<command-args>([^<]*)<\/command-args>/.exec(t)?.[1] ?? ''}`; // a slash command, as typed
        add('user', t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ''), at);
      }
      // Stopped before Claude took it in, a message goes back to Claude's input box, and the next one you send hangs on
      // the same line it did: the record keeps both, Claude counts only the later. So the earlier one is left out here
      // when nothing answered it (one Claude answered and you went back to rewrite stays, with its answer), and each
      // message carries its line and parent (p, u) for the page to do the same with one it already shows.
      const mine = out.slice(first);
      if (j.type === 'user' && j.parentUuid && j.uuid && mine.length) {
        const was = byParent.get(j.parentUuid);
        if (was && !out.slice(was.end, first).some((o) => !o.gone && o.role !== 'user' && o.role !== 'img')) for (const o of was.items) o.gone = true;
        byParent.set(j.parentUuid, { items: mine, end: out.length });
        for (const o of mine) Object.assign(o, { p: j.parentUuid, u: j.uuid });
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
  const items = out.filter((o) => !o.gone);
  // ones the 管家 typed here (chat say, chat new: its log has them, the same words within 3 minutes): not yours
  const sent = blogSent(path.basename(file, '.jsonl'));
  if (sent.length) for (const o of items) if (o.role === 'user' && sent.some((s) => Math.abs(s.at - o.at) < 180000 && unwrapPaste(o.text).startsWith(s.text))) o.by = 'butler';
  let cut = 0;
  if (from == null && items.length > keep) {
    cut = items.length - keep;
    while (cut > 0 && items[cut].role !== 'user' && items[cut].role !== 'img') cut--; // back to a message of yours
    while (cut > 0 && items[cut - 1].pos === items[cut].pos) cut--; // its pictures, above its words
  }
  // a message of yours that replaced stopped ones: the look before ends before those too, not between (it wouldn't see
  // the replacement, and they'd come back as you scroll up)
  let start = cut ? items[cut].pos : a + skip;
  if (cut) for (const o of out) if (o.gone && o.p && o.p === items[cut].p && o.pos < start) start = o.pos;
  return { items: items.slice(cut).map(({ pos, ...o }) => o), start, end: last < skip ? a + skip : a + last + 1 };
}
// A file Claude changed, from its Edit's or Write's result (a failed one's is its error, no patch): its path and the lines
// added and taken out, its patch's + and - lines; a new file (Write, an empty patch) all its lines added
const lineCount = (s) => (s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0);
function editOf(r) {
  if (typeof r?.filePath !== 'string' || !Array.isArray(r.structuredPatch)) return null;
  let add = 0, del = 0;
  for (const h of r.structuredPatch) for (const l of h.lines ?? []) { if (l[0] === '+') add++; else if (l[0] === '-') del++; }
  if (r.type === 'create' && !r.structuredPatch.length) add = lineCount(String(r.content ?? ''));
  return { text: r.filePath, add, del };
}
// One of a Codex fileChange's changes the same way: an update's unified diff (its + and - lines after the first @@), a
// new file's whole text (its diff), a deleted one's
function codexEdit(c) {
  const diff = String(c?.diff ?? ''), kind = c?.kind?.type;
  if (kind === 'add' || kind === 'delete') return { text: String(c.path ?? ''), add: kind === 'add' ? lineCount(diff) : 0, del: kind === 'delete' ? lineCount(diff) : 0 };
  let add = 0, del = 0, hunk = false;
  for (const l of diff.split('\n')) { if (l.startsWith('@@')) hunk = true; else if (hunk && l[0] === '+') add++; else if (hunk && l[0] === '-') del++; }
  return { text: String(c?.path ?? ''), add, del };
}
// A running conversation's queue: your messages sent while Claude was at work (from the page, its window, the 管家) that
// it hasn't taken in yet, as the page shows them waiting. Claude Code logs each (queue-operation enqueue) and logs again
// when it takes it: in the middle of the turn (remove; a queued_command line with its words), as the next turn (a message
// of yours with its words), or back in its input box to edit (popAll: ↑ there). Its own (a background task's news) left
// out. A turn's end clears what's left: none waits then, unless a Claude that died with some queued left them behind.
// Read on from where the last look got to; the first, the last 16 MB (as history's first look).
const queues = new Map(); // a record → { pos: read up to, q: [{ text, at }] }
function queueNow(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  let s = queues.get(file);
  if (!s || size < s.pos) queues.set(file, s = { pos: Math.max(0, size - 16777216), q: [], cut: size > 16777216 });
  if (size <= s.pos) return s.q.map(({ text, at }) => ({ text, at }));
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(size - s.pos);
  try { fs.readSync(fd, buf, 0, buf.length, s.pos); } finally { fs.closeSync(fd); }
  const skip = s.cut ? buf.indexOf(10) + 1 : 0, last = buf.lastIndexOf(10); // a line cut at the start skipped, one still being written waits
  if (s.cut && !skip) return [];
  const flat = (t) => String(t ?? '').replace(/\s+/g, ''), words = (j) => said(j).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const take = (t) => { const i = s.q.findIndex((x) => flat(x.text) === flat(t)); if (i >= 0) s.q.splice(i, 1); };
  const lines = last < skip ? [] : buf.toString('utf8', skip, last + 1).split('\n');
  for (const l of lines) {
    const op = l.includes('"queue-operation"'), queued = !op && l.includes('"queued_command"'), end = !op && !queued && l.includes('"turn_duration"');
    const yours = !op && !queued && !end && s.q.length && l.includes('"type":"user"') && !l.includes('"tool_result"');
    if (!op && !queued && !end && !yours) continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (op && j.type === 'queue-operation') {
      const mine = typeof j.content === 'string' && j.content.trim() && !/^\s*<(task-notification|teammate-message)/.test(j.content);
      if (j.operation === 'enqueue' && mine) s.q.push({ text: j.content, at: Date.parse(j.timestamp) || 0 });
      else if (j.operation === 'remove' && mine) take(j.content);
      else if (j.operation === 'popAll') s.q = [];
    } else if (queued && j.attachment?.type === 'queued_command') take(words(j));
    else if (end && j.type === 'system' && j.subtype === 'turn_duration') s.q = [];
    else if (yours && j.type === 'user' && !j.isMeta) take(words(j));
  }
  if (last >= skip) { s.pos += last + 1; s.cut = false; }
  return s.q.map(({ text, at }) => ({ text, at }));
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
  const p = said(JSON.parse(Buffer.concat(parts).toString('utf8'))).filter((x) => x.type === 'image')[k];
  if (!/^image\/(png|jpeg|gif|webp)$/.test(p?.source?.media_type ?? '')) throw new Error('没有这张图片'); // never served as anything else
  return { type: p.source.media_type, data: Buffer.from(p.source.data, 'base64') };
}
// A picture sent from the page, kept for Claude to take in by its path: the page pastes the path, as dragging the file
// into a terminal does, and Claude attaches it ([Image #1]) and copies it into its record. Any other file (name: its
// own) keeps its name, after the time: its path goes in the message, for Claude to read. Kept a week.
const UPLOADS = path.join(ROOT, 'uploads');
function saveUpload(data, ext, dir = UPLOADS, name = null) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) try { if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 7 * 864e5) fs.unlinkSync(path.join(dir, f)); } catch {}
  const stamp = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${require('crypto').randomBytes(3).toString('hex')}`;
  // the name only, no folders; what Windows can't take in a name replaced
  const safe = name && path.basename(name.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(-120);
  const file = path.join(dir, safe ? `${stamp}-${safe}` : `${stamp}.${ext ?? 'bin'}`);
  fs.writeFileSync(file, data);
  return file;
}
// A file sent in a conversation, opened from the page (/api/file?n=its saved name here): its name as sent, and how the
// browser gets it. A PDF, a picture or plain text is shown (text and pictures sandboxed); anything else is downloaded:
// never shown as one of the page's own kind (HTML, SVG), which would run as this page with its key. null: not one of ours.
// Where it is: the uploads, or a GPT 聊天's own folder (its files go there once sent; the saved name stays unique)
const UPLOAD_NAME = /^(\d{8}T\d{6}-[0-9a-f]{6})-([^\\/]+)$/;
const TEXT_EXT = new Set(['txt', 'md', 'csv', 'tsv', 'log', 'json', 'yaml', 'yml', 'ini', 'toml', 'tex', 'bib', 'py', 'js', 'ts', 'm', 'c', 'h', 'cpp', 'hpp', 'java', 'rs', 'go', 'sh', 'ps1']);
function fileServed(n, up = UPLOADS, oai = OAI) {
  const m = UPLOAD_NAME.exec(n ?? '');
  if (!m) return null;
  const name = m[2], ext = path.extname(name).slice(1).toLowerCase();
  const type = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext]
    ?? (TEXT_EXT.has(ext) ? 'text/plain; charset=utf-8' : null);
  let chats = []; try { chats = fs.readdirSync(oai); } catch {}
  const file = [path.join(up, n), ...chats.map((d) => path.join(oai, d, n))].find((p) => fs.existsSync(p)) ?? path.join(up, n);
  return { name, file, headers: { 'content-type': type ?? 'application/octet-stream', 'x-content-type-options': 'nosniff',
    'content-disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`, 'cache-control': 'private, max-age=86400',
    ...(type && ext !== 'pdf' && { 'content-security-policy': 'sandbox' }) } }; // (a sandboxed PDF gets no viewer)
}
// 预览 (a path in a reply, opened from the page): how the browser gets a file of this PC. A PDF, a picture, a video or a
// sound as itself; code, notes and the like as text (a web page or an SVG too: as one of the page's own kind it would run
// with its key); an Office one as the PDF Office makes of it here (peekPdf); anything else downloaded
const PEEK_MEDIA = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac' };
const PEEK_TEXT = new Set([...TEXT_EXT, '', 'html', 'htm', 'svg', 'xml', 'css', 'scss', 'vue', 'jsx', 'tsx', 'mjs', 'cjs', 'bat', 'cmd', 'cfg', 'conf', 'lua', 'rb', 'php', 'kt',
  'swift', 'cs', 'r', 'sql', 'gitignore', 'env', 'ipynb', 'srt', 'vtt', 'out', 'err', 'diff', 'patch', 'lock']);
// 右键 a path on the page (a computer's): 在电脑上打开 with its own program (a program or a script, which that would run,
// shown in Explorer instead), 打开方式 (Windows' own chooser), 在资源管理器中显示; a folder opened in Explorer. [what's
// started, its command line as Windows takes it (a path can't hold a ")]
const RUNS = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|ws|msi|msp|msc|lnk|scr|pif|hta|cpl|reg|inf|scf|jar|url|py|pyw|sh|appref-ms|application|gadget)$/i;
// what a Mac's open would run (or install): besides RUNS's, and a file it may run (chmod +x)
const MAC_RUNS = /\.(command|tool|zsh|bash|csh|pl|rb|pkg|mpkg|dmg|workflow|action|scpt|scptd|applescript|terminal|webloc|inetloc|prefpane|kext|osax)$/i;
const shellCmd = (f, how, dir) => dir ? ['explorer.exe', `"${f}"`] : how === 'with' ? ['rundll32.exe', `shell32.dll,OpenAs_RunDLL ${f}`] // (its path bare, as Windows' own "Open with" has it)
  : how === 'open' && !RUNS.test(f) ? ['explorer.exe', `"${f}"`] : ['explorer.exe', `/select,"${f}"`];
// …then brought to the front: Windows keeps a window a background process opens (the service is one) behind, flashing in
// the taskbar. FRONT_PS finds it (an Explorer window at CM_DIR; Windows' "Open with" chooser; else one titled with the
// file's name, its own program's) and brings it up: the foreground's input borrowed, else an Alt press, else Alt+Tab's own
// switch; what it did, said (set, alt, switch, no; none: no such window came)
const FRONT_PS = `$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class Fg {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool on);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public static IntPtr Find(string part, int pid) {
    IntPtr hit = IntPtr.Zero;
    EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; uint p; GetWindowThreadProcessId(h, out p);
      var s = new StringBuilder(512); GetWindowText(h, s, 512);
      if (pid > 0 ? p == (uint)pid : s.Length > 0 && s.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) { hit = h; return false; } return true; }, IntPtr.Zero);
    return hit;
  }
  public static string Front(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    uint p, me = GetCurrentThreadId(), fg = GetWindowThreadProcessId(GetForegroundWindow(), out p);
    if (fg != me) AttachThreadInput(me, fg, true);
    SetForegroundWindow(h); BringWindowToTop(h);
    if (fg != me) AttachThreadInput(me, fg, false);
    if (GetForegroundWindow() == h) return "set";
    keybd_event(0x12, 0, 0, UIntPtr.Zero); SetForegroundWindow(h); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    if (GetForegroundWindow() == h) return "alt";
    SwitchToThisWindow(h, true);
    return GetForegroundWindow() == h ? "switch" : "no";
  }
}
'@
$p = $env:CM_PATH; $dir = $env:CM_DIR; $how = $env:CM_HOW
$name = [IO.Path]::GetFileName($p); $stem = [IO.Path]::GetFileNameWithoutExtension($p)
$sh = New-Object -ComObject Shell.Application
$end = (Get-Date).AddSeconds($(if ($dir) { 8 } else { 20 })); $h = [IntPtr]::Zero
while ((Get-Date) -lt $end -and $h -eq [IntPtr]::Zero) {
  Start-Sleep -Milliseconds 200
  if ($dir) { foreach ($w in $sh.Windows()) { try { if ($w.Document.Folder.Self.Path -eq $dir) { $h = [IntPtr][long]$w.HWND } } catch {} } }
  elseif ($how -eq 'with') { foreach ($o in Get-Process OpenWith | Sort-Object StartTime -Descending) { $h = [Fg]::Find('', $o.Id); if ($h -ne [IntPtr]::Zero) { break } } }
  else { $h = [Fg]::Find($name, 0); if ($h -eq [IntPtr]::Zero -and $stem.Length -ge 3) { $h = [Fg]::Find($stem, 0) } }
}
if ($h -eq [IntPtr]::Zero) { 'none' } else { [Fg]::Front($h) }
`;
const frontOf = (f, how, dir) => ({ CM_PATH: f, CM_HOW: how, CM_DIR: dir ? f : how === 'with' || (how === 'open' && !RUNS.test(f)) ? '' : path.dirname(f) });
const OFFICE_KIND = { ppt: 'ppt', pptx: 'ppt', doc: 'doc', docx: 'doc', rtf: 'doc', xls: 'xls', xlsx: 'xls' };
function peekHead(name, office = false) {
  const ext = path.extname(name).slice(1).toLowerCase(), type = office ? 'application/pdf' : PEEK_MEDIA[ext] ?? (PEEK_TEXT.has(ext) ? 'text/plain; charset=utf-8' : null);
  return { 'content-type': type ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
    'content-disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(office ? name + '.pdf' : name)}`,
    ...(type && type !== 'application/pdf' && { 'content-security-policy': 'sandbox' }) };
}
// An Office file as a PDF, made by the Office here, unseen (no window), kept a week in peek\ by the file's path, time and
// size (changed: made again). Those asked for together (a folder's, as it's listed) made in one go, Office started once
// for them; one opened goes first (first). PowerPoint is one for the whole PC: a deck of yours open stays, and it's quit
// only if it wasn't running before. Word and Excel are instances of their own, quit once ours are closed
const PEEK_DIR = path.join(ROOT, 'peek');
const OFFICE_APP = { ppt: 'PowerPoint', doc: 'Word', xls: 'Excel' };
const OFFICE_PS = { // each job ({k, in, out}) said done (ok k) or not (fail k why), as it goes
  ppt: `$was = [bool](Get-Process POWERPNT -ErrorAction SilentlyContinue); $app = New-Object -ComObject PowerPoint.Application
try { foreach ($j in ($env:CM_JOBS | ConvertFrom-Json)) { try { $p = $app.Presentations.Open($j.in, -1, 0, 0); try { $p.SaveAs($j.out, 32) } finally { $p.Close() }; "ok $($j.k)" } catch { "fail $($j.k) $($_.Exception.Message)" } } }
finally { if (-not $was -and $app.Presentations.Count -eq 0) { $app.Quit() } }`,
  doc: `$app = New-Object -ComObject Word.Application; $app.Visible = $false; $app.DisplayAlerts = 0
try { foreach ($j in ($env:CM_JOBS | ConvertFrom-Json)) { try { $d = $app.Documents.Open($j.in, $false, $true, $false); try { $d.ExportAsFixedFormat($j.out, 17) } finally { $d.Close(0) }; "ok $($j.k)" } catch { "fail $($j.k) $($_.Exception.Message)" } } }
finally { if ($app.Documents.Count -eq 0) { $app.Quit() } }`,
  xls: `$app = New-Object -ComObject Excel.Application; $app.Visible = $false; $app.DisplayAlerts = $false
try { foreach ($j in ($env:CM_JOBS | ConvertFrom-Json)) { try { $b = $app.Workbooks.Open($j.in, 0, $true); try { $b.ExportAsFixedFormat(0, $j.out) } finally { $b.Close($false) }; "ok $($j.k)" } catch { "fail $($j.k) $($_.Exception.Message)" } } }
finally { if ($app.Workbooks.Count -eq 0) { $app.Quit() } }`,
};
const peekMade = new Map(), peekWait = []; // key -> its PDF on the way (a failure kept 10 min: not tried again at every look); jobs not begun
let peekBusy = false;
function peekPdf(file, { dir = PEEK_DIR, ps = OFFICE_PS, first = false } = {}) {
  const kind = OFFICE_KIND[path.extname(file).slice(1).toLowerCase()], st = fs.statSync(file), at = path.resolve(file);
  const key = require('crypto').createHash('sha1').update(`${at.toLowerCase()}|${st.mtimeMs}|${st.size}`).digest('hex').slice(0, 24), pdf = path.join(dir, key + '.pdf');
  if (fs.existsSync(pdf)) return Promise.resolve(pdf);
  const i = peekWait.findIndex((j) => j.key === key);
  if (first && i > 0) peekWait.unshift(...peekWait.splice(i, 1));
  if (peekMade.has(key)) return peekMade.get(key);
  const made = new Promise((ok, no) => { const job = { key, kind, at, pdf, dir, ps, ok, no }; if (first) peekWait.unshift(job); else peekWait.push(job); });
  peekMade.set(key, made);
  made.then(() => peekMade.delete(key), () => setTimeout(() => peekMade.delete(key), 600000).unref());
  setTimeout(peekTurn, 30); // those asked for at once, together
  return made;
}
function peekTurn() {
  if (peekBusy || !peekWait.length) return;
  peekBusy = true;
  const { kind, ps, dir } = peekWait[0], batch = peekWait.filter((j) => j.kind === kind && j.ps === ps).slice(0, 20);
  for (const j of batch) peekWait.splice(peekWait.indexOf(j), 1);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) try { if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 7 * 864e5) fs.rmSync(path.join(dir, f)); } catch {} // a week old
  const jobs = batch.map((j) => ({ k: j.key, in: j.at, out: path.join(j.dir, `${j.key}.${process.pid}.tmp.pdf`) }));
  const settle = (k, done, why) => {
    const j = batch.find((x) => x.key === k), tmp = jobs.find((x) => x.k === k)?.out;
    if (!j || j.settled) return;
    j.settled = true;
    if (done && fs.existsSync(tmp)) { fs.renameSync(tmp, j.pdf); return j.ok(j.pdf); }
    fs.rmSync(tmp, { force: true });
    j.no(new Error(`${OFFICE_APP[kind]} 没能把它转成 PDF：${why || '没有做完'}`));
  };
  const p = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; ${ps[kind]}`],
    { env: { ...process.env, CM_JOBS: JSON.stringify(jobs) }, windowsHide: true });
  let out = '', err = '';
  const stop = setTimeout(() => p.kill(), 60000 + 30000 * batch.length); // one left hanging (a dialog of Office's): given up
  p.stdout.on('data', (d) => {
    out += d;
    for (let i; (i = out.indexOf('\n')) >= 0; out = out.slice(i + 1)) { const m = /^(ok|fail) (\w+) ?(.*)$/.exec(out.slice(0, i).trim()); if (m) settle(m[2], m[1] === 'ok', m[3]); }
  });
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', (e) => { err ||= e.message; });
  p.on('close', () => { clearTimeout(stop); for (const j of batch) settle(j.key, false, err.trim().split('\n')[0]); peekBusy = false; peekTurn(); });
}
// `/` in the page's box: the commands and skills Claude Code itself lists for a folder and an account, asked as the Agent
// SDK asks (its initialize request: no model call; hooks and MCP servers off), its process let go of cleanly (killed, its
// sessions\<pid>.json stayed). Not the internal ones (_…), nor those it says are gone or renamed.
const slashKeep = (c) => !/^_/.test(c.name) && !/^\(removed\)|^Renamed to /.test(c.description ?? '');
const slashOf = (cmds) => cmds.filter(slashKeep).map((c) => ({ name: c.name, desc: c.description ?? '', hint: c.argumentHint ?? '', also: c.aliases ?? [], builtin: !!c.builtin }));
// `/` in a Mac's conversation: what Claude Code lists there (its skills, commands, plugins), asked the same way over ssh, on
// the account its conversations there use (macEnv), in its folder there; its input ended after the ask (it answers, then
// goes), its keychain unlocked as for anything run there, no session kept (its pid's file gone after)
const SLASH_INIT = JSON.stringify({ type: 'control_request', request_id: 'cm', request: { subtype: 'initialize' } });
const macSlashCmd = (m, cwd) => `security unlock-keychain -p "$LC_MACKC" >/dev/null 2>&1; unset LC_MACKC; { cd ${sq(cwd)} || cd ${macSh(m.dir)}; } 2>/dev/null; `
  + `printf '%s\\n' ${sq(SLASH_INIT)} | ${macEnv(m)}~/.local/bin/claude -p --input-format stream-json --output-format stream-json --verbose --strict-mcp-config --no-session-persistence --settings '{"disableAllHooks":true}' & p=$!; `
  + `wait $p; find ${m.config ? macSh(m.config) : '"$HOME/.claude"'}/sessions -name "$p.*" -delete 2>/dev/null; true`;
// its answer among what it printed: the list, or why not (its error, else the ssh's last words)
const slashParse = (r) => {
  let j = null;
  for (const l of String(r.out ?? '').split('\n')) if (l.includes('"control_response"')) try { j = JSON.parse(l); } catch {}
  if (j?.response?.subtype !== 'success') throw new Error(j?.response?.error || String(r.err ?? '').trim().split('\n').pop() || `退出码 ${r.status}`);
  return slashOf(j.response.response?.commands ?? []);
};
const macSlash = (m, cwd, timeout = 30000) => Promise.race([macRun(m, macSlashCmd(m, cwd)), new Promise((ok) => setTimeout(() => ok({ status: -1, out: '', err: '30 秒没回' }), timeout).unref())]).then(slashParse);
function slashList(exe, configDir, cwd, timeout = 20000) {
  return new Promise((ok, no) => {
    const p = require('child_process').spawn(exe, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}'],
      { cwd, env: childEnv(configDir), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '', done = false;
    const stop = setTimeout(() => p.kill(), timeout);
    const settle = (e, list) => { if (!done) { done = true; e ? no(e) : ok(list); } };
    p.stdout.on('data', (d) => {
      buf += d;
      for (let i; !done && (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        let j; try { j = JSON.parse(buf.slice(0, i)); } catch { continue; }
        if (j.type !== 'control_response') continue;
        if (j.response?.subtype !== 'success') settle(new Error(j.response?.error || '没拿到命令列表'));
        else settle(null, slashOf(j.response.response?.commands ?? []));
        p.stdin.end(); setTimeout(() => p.kill(), 5000).unref(); // it goes on its own at the end of its input
      }
    });
    p.on('error', settle);
    p.on('exit', () => {
      clearTimeout(stop);
      settle(new Error('Claude Code 没给命令列表就退出了'));
      try { for (const f of fs.readdirSync(path.join(configDir, 'sessions'))) if (f.startsWith(`${p.pid}.`)) fs.rmSync(path.join(configDir, 'sessions', f), { force: true }); } catch {}
    });
    p.stdin.on('error', () => {});
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'cm', request: { subtype: 'initialize' } }) + '\n');
  });
}

// The start of a window's history: the reader keeps only what scrolls by from where it began (the screen then),
// and the window's own history can't be read. So that it starts at a question of yours, the record fills in
// what came between the question and the first message the lines show (a row starting ❯ or ●, found by its
// first words), drawn the way Claude Code draws a conversation. skip: the lines before that message.
function lead(items, lines, more = false) { // more: the record goes back further than items
  items = items.filter((it) => it.role !== 'edit'); // the page's 改动 card: no line in a terminal
  const key = (t) => String(t).split('\n')[0].replace(/[\s*`#>]/g, '').slice(0, 16);
  let cut = -1, skip = 0;
  // each message's key at its last place in the record, made once (each row against every message took ~1 s on a long
  // screen and record, every terminal stopped meanwhile)
  const at = new Map();
  items.forEach((it, i) => { if (it.role !== 'tool' && it.role !== 'img') at.set(key(it.text), i); });
  for (let r = 0; r < lines.length && cut < 0; r++) {
    const m = /^[❯●]\s+(.*)/.exec(lines[r].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')), k = m && key(m[1]);
    if (k && k.length >= 4 && at.has(k)) { cut = at.get(k); skip = r; }
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

// Phone notifications (Web Push). The page, opened from the home screen, subscribes; each new notification (the ones
// the island gets) goes to every subscription through its browser's push service (Apple's for an iPhone). push.json
// keeps this service's key (VAPID, RFC 8292: a push service takes pushes only from the key a subscription was made
// for) and the subscriptions. What's pushed is encrypted for the phone alone (aes128gcm, RFC 8291).
const PUSH = path.join(ROOT, 'push.json');
const pushStore = () => { try { return JSON.parse(fs.readFileSync(PUSH, 'utf8')); } catch { return null; } };
const savePush = (s) => { fs.writeFileSync(`${PUSH}.tmp`, JSON.stringify(s)); fs.renameSync(`${PUSH}.tmp`, PUSH); }; // whole: one cut short would read as none, and a new key drop every phone's subscription
function pushKeys() { // made on first use
  const s = pushStore();
  if (s) return s;
  const n = { jwk: require('crypto').generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' }), subs: [] };
  savePush(n);
  return n;
}
const pushPublic = (jwk) => Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
// text encrypted for a subscription's keys (p256dh, auth), as one record; asPriv and salt fixed only by the test
function pushBody(keys, text, asPriv, salt = require('crypto').randomBytes(16)) {
  const crypto = require('crypto'), e = crypto.createECDH('prime256v1');
  if (asPriv) e.setPrivateKey(asPriv); else e.generateKeys();
  const ua = Buffer.from(keys.p256dh, 'base64url'), as = e.getPublicKey();
  const hk = (ikm, s, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, n));
  const ikm = hk(e.computeSecret(ua), Buffer.from(keys.auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32);
  const c = crypto.createCipheriv('aes-128-gcm', hk(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hk(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = Buffer.concat([c.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), c.final(), c.getAuthTag()]); // 2: the last record
  const head = Buffer.alloc(21); salt.copy(head); head.writeUInt32BE(4096, 16); head[20] = as.length;
  return Buffer.concat([head, as, data]);
}
// this service's signature for a push service (the origin of the subscription's endpoint), good for 12 hours
function pushAuth(endpoint, jwk) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const t = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 43200, sub: 'https://github.com/cacdcaecawae/claude-multi' })}`;
  const sig = require('crypto').sign('sha256', Buffer.from(t), { key: require('crypto').createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${t}.${sig.toString('base64url')}, k=${pushPublic(jwk)}`;
}
// {title, body, id} to every subscription (or the one at endpoint only); one its push service says is gone (404, 410:
// the app removed, notifications turned off) is dropped. The push services' answers back: 201 is delivered to them.
// Any other answer goes to the log, with the service's words: why a device got nothing. No answer at all (the connection
// dropped, ECONNRESET, or a timeout: the way abroad does it now and then, a quarter of an hour's pushes some days) is tried
// once more 3 s on, before it's logged; a push that got there twice is still one notification (its tag).
async function pushAll(msg, endpoint) {
  const s = pushStore(), subs = (s?.subs ?? []).filter((x) => !endpoint || x.endpoint === endpoint);
  if (!subs.length) return [];
  const post = (sub) => fetch(sub.endpoint, {
    method: 'POST', body: pushBody(sub.keys, JSON.stringify(msg)), signal: AbortSignal.timeout(15000),
    headers: { authorization: pushAuth(sub.endpoint, s.jwk), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high' },
  });
  const out = await Promise.all(subs.map((sub) => post(sub).catch(() => sleep(3000).then(() => post(sub))).then(async (r) => {
    if (r.status !== 201) log('push_fail', { host: new URL(sub.endpoint).host, status: r.status, said: (await r.text().catch(() => '')).slice(0, 300) });
    return r.status;
  }, (e) => { log('push_fail', { host: new URL(sub.endpoint).host, err: `${e.cause?.code ?? ''} ${e.message}`.trim() }); return e.cause?.code ?? e.message; })));
  const gone = new Set(subs.filter((_, i) => out[i] === 404 || out[i] === 410).map((x) => x.endpoint));
  if (gone.size) { const now = pushStore(); now.subs = now.subs.filter((x) => !gone.has(x.endpoint)); savePush(now); }
  return out;
}
// Or through the Bark app (an iOS app: its notifications have no "from <web app>" line, which iOS adds to a home screen
// page's), when bark.json here (not in the repository) has its address: {"url": "https://api.day.app/<key>"}. Its icon
// and a tap's page (that conversation) from the public address. The answer back: 200 is delivered to Bark's server.
const BARK = path.join(ROOT, 'bark.json');
const barkUrl = () => { try { return JSON.parse(fs.readFileSync(BARK, 'utf8').replace(/^﻿/, '')).url?.replace(/\/+$/, '') || null; } catch { return null; } };
// What Bark gets: under the title a line with where it runs (its folder, its account); grouped by conversation, so each
// one's notifications stack apart; one waiting for you time-sensitive (shown through Focus) with its own sound.
function barkMsg(msg, pub = '') {
  return { title: msg.title, ...(msg.sub && { subtitle: msg.sub }), body: msg.body, group: msg.group || 'Claude',
    ...(msg.ask && { level: 'timeSensitive', sound: 'bell' }),
    ...(pub && { icon: `${pub}/icon-180.png`, url: `${pub}/${msg.id ? `?open=${encodeURIComponent(msg.id)}` : ''}` }) };
}
async function bark(msg) {
  const r = await fetch(barkUrl(), { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(barkMsg(msg, WEB_URL.startsWith('https://') ? WEB_URL : '')) });
  if (r.status !== 200) log('bark_fail', { status: r.status, said: (await r.text().catch(() => '')).slice(0, 300) });
  return r.status;
}
// The page's helper, run by the browser apart from it: shows what's pushed (iOS takes a push away from a page that shows
// nothing), and a tap opens the page at that conversation.
const PUSH_SW = `self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || 'Claude', { body: d.body || '', tag: d.id || undefined, data: { id: d.id }, icon: '/icon-180.png' }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    if (ws[0]) { if (id) ws[0].postMessage({ open: id }); return ws[0].focus(); }
    return clients.openWindow(id ? '/?open=' + encodeURIComponent(id) : '/');
  }));
});`;
// what the home screen keeps of the page: a manifest of its own, which Web Push on iOS asks of a web app
const MANIFEST = JSON.stringify({ name: 'Claude 多账号', short_name: 'Claude', start_url: '/', display: 'standalone', background_color: '#181818', theme_color: '#181818',
  icons: [{ src: '/icon-180.png', sizes: '180x180', type: 'image/png' }] });

// What the web service is doing to a conversation, by id: 'switch' (asked, till its new Claude has started) or 'change'
// (a rename or a delete, till its command is done). A change is refused while anything goes on, a start or a switch
// while a change does: a deletion between a switch's two Claudes, or a start between a deletion's checks and its
// PowerShell, would lose the record. A second switch (the island and the page both) goes on as before, the first lets go.
// ponytail: the service's own doings only; `claude-multi delete` typed meanwhile in a terminal isn't held off
const doing = new Map();
function hold(id, what) {
  const was = doing.get(id);
  if (was === 'change') throw new Error('这个对话正在改名或删除，稍等一下');
  if (was && what === 'change') throw new Error('这个对话正在换账号，换完再改');
  if (was) return () => {};
  doing.set(id, what);
  return () => doing.delete(id);
}

// Claude Code's part of this computer: its processes ('<pid> <cpu ms> <memory bytes> <path>' a line, CLAUDE_PS), CPU since
// the sample before (prev: pid → cpu ms, ms before) across all cores, and memory. The desktop app is a claude.exe too: not
// counted. cpu null: no sample before.
const CLAUDE_PS = "Get-Process -Name claude -ErrorAction SilentlyContinue | % { '{0} {1} {2} {3}' -f $_.Id, [long]$_.TotalProcessorTime.TotalMilliseconds, $_.WorkingSet64, $_.Path }";
function claudeShare(text, prev, ms, ncpu) {
  const now = new Map();
  let mem = 0, used = 0;
  for (const l of text.split(/\r?\n/)) {
    const m = /^(\d+) (\d+) (\d+) ?(.*)$/.exec(l.trim());
    if (!m || /\\(AnthropicClaude|WindowsApps)\\/i.test(m[4])) continue;
    now.set(+m[1], +m[2]); mem += +m[3];
    used += Math.max(0, +m[2] - (prev?.get(+m[1]) ?? 0)); // one started since: all of its time is since
  }
  return { cpu: prev && ms > 0 ? Math.min(100, Math.round((100 * used) / (ms * ncpu))) : null, mem, n: now.size, prev: now };
}

// A terminal's private modes (mouse reporting, the full screen, bracketed paste...) as its output last set them. The
// switches come once, as the program starts (or tmux joins it); a busy screen's output soon pushes them out of the
// 256 KB a page is given first, and a page that opened later had no mouse (the band's buttons dead), no paste mode
// (each line of a paste sent on its own), no full screen. So the replay starts with them. Left out: 2026 (synchronized
// output), which a frame cut halfway would leave on.
const MODES = /\x1b\[\?([\d;]+)([hl])/g;
function keepOut(t, d) {
  for (const m of (t.buf.slice(-20) + d).matchAll(MODES)) for (const n of m[1].split(';')) if (n && n !== '2026') (t.modes ??= {})[n] = m[2]; // -20: one cut between two pieces
  t.buf = (t.buf + d).slice(-262144);
}
const replayPty = (t) => Object.entries(t.modes ?? {}).map(([n, v]) => `\x1b[?${n}${v}`).join('') + t.buf;

async function web() {
  procStarts.beside = true; // its process checks never hold up the terminals
  // A private extension, when profiles.json names one (ext: a CommonJS file's absolute path, trusted as this code is):
  // its routes join the page's behind the same key, its page part (/ext.js) runs before the page's script. One that
  // won't load is logged and left out: the conversations here go on without it.
  const ext = (() => {
    try {
      const f = load().ext;
      if (!f) return null;
      if (!path.isAbsolute(f)) throw Error('ext 要写绝对路径');
      return require(f)({ load, root: ROOT });
    } catch (e) { log('ext_error', { err: e.message }); return null; }
  })();
  const quota = require('./quota-panel').createQuotaPanel({ source: quotaSource, configured: () => quotaOn() });
  // delta.js send for 申请接入's accounts (viaDelta), a child of this service: a conversation here ends with it anyway.
  // shortcut: one started from a terminal (claude-multi start, the island) needs this service up too, as setup keeps it
  // Accounts go through it once it says it listens (pointJoins); one that ends before it did (its port taken) points
  // them straight back. One that ends after: started again in 5 s, its accounts left on it
  const deltaLog = fs.openSync(path.join(ROOT, 'delta.log'), 'a');
  let deltaUp = false;
  const delta = () => {
    let ready = false;
    require('child_process').fork(path.join(ROOT, 'delta.js'), ['send', '--port', String(WEB_PORT + 1), '--profiles', REGISTRY],
      { stdio: ['ignore', 'ignore', deltaLog, 'ipc'], windowsHide: true })
      .on('message', (m) => { if (m?.listening) { ready = deltaUp = true; pointJoins(true); } })
      .on('exit', () => { deltaUp = false; if (!ready) pointJoins(false); setTimeout(delta, 5000); });
  };
  delta();
  let joining = false; // 申请接入: one round of asking at a time (the minute's, or 设置 opened)
  const joinRound = async () => { // a new account: 额度 read again on the page's next look, not up to a minute later
    if (joining) return;
    joining = true;
    try { if (await checkJoins()) { usageAt = 0; pointJoins(deltaUp); } } finally { joining = false; }
  };
  setInterval(() => { if (readJoins().some((j) => j.state === 'pending')) joinRound().catch(() => {}); }, 60000);
  // 有新版本 (updateCheck): asked a minute after the start, then every hour. head: the code this service runs, for a page
  // that asked to update to see it's on the new one. updBusy, updErr: the page's 更新 running, how it ended if not restarted
  let upd = null, updBusy = false, updErr = null;
  const head = spawnSync('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() || null;
  const checkUpd = () => updateCheck().then((u) => { upd = u; }, () => {});
  setTimeout(checkUpd, 60000); setInterval(checkUpd, 3600000);
  const http = require('http'), pty = require('@lydell/node-pty');
  const claudeExe = claudeCmd();
  const codex = codexCmd(); // GPT conversations: none started without it
  const sshExe = whereIs('ssh') || 'ssh'; // the Mac's
  const terms = new Map(); // key -> { kind: 'pty' | 'pc', sid, pid, proc, clients: Set, buf, w, h, gone }
  const slashCache = new Map(); // `${configDir}|${folder}` -> { at, list }: / in a conversation's box
  // the quota as the page last got it, kept on disk: after a restart the page shows it at once (read again behind it)
  let usageCache = (() => { try { return JSON.parse(fs.readFileSync(WEB_USAGE, 'utf8')); } catch { return null; } })();
  let usageAt = 0, usageNow = null, sessCache = null, sessAt = 0;

  const send = (t, ev, data) => { for (const res of t.clients) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
  const sessions = () => {
    if (!sessCache || Date.now() - sessAt > 3000) { sessCache = listSessions(load()); sessAt = Date.now(); }
    return sessCache;
  };
  // The GPT conversations, kept apart from the Claude ones (sessions(): what's written for those reads their records),
  // and which of them run here. A Codex started here is bound to its thread once Codex has one (in that account, in that
  // folder, made since it started: there before its first message); a resumed one knows its own. One running here is
  // busy while its last turn is going (its record says), idle otherwise, whatever an ended one left there.
  // Its marker (gpt-live) as any Codex's, for the CLI and the island: written once its pid is known, its thread added when
  // bound (here, or by a notify or a listing first: taken from it then), gone when it ends.
  const gptLive = () => [...terms.values()].filter((t) => t.gpt && !t.gone);
  const markWeb = (t) => gptMark({ pid: t.pid, home: t.gpt.home, cwd: t.cwd, since: t.gpt.since, id: t.gpt.id, web: true });
  function bindGpt() {
    const live = gptLive(), marks = gptMarks();
    for (const t of live.filter((x) => !x.gpt.id)) try {
      t.gpt.id = marks.find((m) => m.pid === t.pid)?.id ?? null;
      if (!t.gpt.id) {
        const d = codexDb(t.gpt.home, 'state_5.sqlite'), taken = new Set([...live.map((x) => x.gpt.id), ...marks.map((m) => m.id)].filter(Boolean));
        try {
          t.gpt.id = d.prepare("select id, cwd from threads where created_at_ms >= ? and source not like '%subagent%' order by created_at_ms").all(t.gpt.since - 5000)
            .find((r) => !taken.has(r.id) && sameDir(longPath(r.cwd), t.cwd))?.id ?? null;
        } finally { d.close(); }
        if (t.gpt.id && t.marked) markWeb(t);
      }
      if (t.gpt.id) gptCache = null;
    } catch {}
  }
  let gptCache = null, gptAt = 0;
  const gptSessions = () => {
    bindGpt();
    if (gptCache && Date.now() - gptAt < 3000) return gptCache;
    const list = listGpt(load()), live = gptLive();
    for (const s of list) {
      const t = live.find((x) => x.gpt.id === s.id);
      if (t) { s.pid = t.pid; s.web = true; s.since = t.gpt.since; }
      if (!s.pid) continue; // running here, or in a terminal window (its marker)
      // its last turn going, and begun since this Codex started: one that died mid-turn left its turn marked going for good
      // ponytail: its records opened afresh each look (3 s) for each one running; cache on the database's change, as listGpt does, if many run
      const last = gptTurn(s.home, s.id);
      s.busy = last?.status === 'inProgress' && last.started >= (s.since ?? 0) - 5000;
    }
    gptCache = list; gptAt = Date.now();
    return list;
  };
  // each GPT account and its usage as its records last said it (read again after 30 s)
  let gptUse = null, gptUseAt = 0;
  const gptState = () => {
    if (!gptUse || Date.now() - gptUseAt > 30000) { gptUse = gptAccounts().map((g) => ({ label: g.label, plan: g.plan, ...(gptUsage(g.home) ?? { windows: null }) })); gptUseAt = Date.now(); }
    return gptUse;
  };
  // A Gemini conversation started or continued here: agy in a pseudo-terminal, its account switched on first (refused
  // while an agy runs on another). A new one's id: the conversation its agy's log names (gemRead), or the one of its
  // account and folder whose first message came a few seconds after an Enter typed in it from a page; till then it has
  // none, and nobody watching it for 30 s ends it (it couldn't be found again)
  const gemLive = () => [...terms.values()].filter((t) => t.gem && !t.gone);
  // Every agy.exe running (tasklist, every 10 s) and what each one's log says (read every 2 s, only what it added):
  // gemAgys id → { pid, since, cut, ask }; of those, the ones not run here (a terminal window's): gemPc. One run here that
  // moved to another conversation (/clear, /new, /resume, /fork typed in it) is followed, as a Claude one's session file
  // is: its 对话, the list and its notes go with it, and the new one isn't started a second time. (An agy of ours just
  // ended isn't taken for a terminal window's till tasklist says it's gone)
  let gemPids = new Set(), gemAgys = new Map(), gemPc = new Map(), gemSeen = '';
  const gemRead = () => {
    const all = [...terms.values()].filter((t) => t.gem), ours = new Map(all.filter((t) => !t.gone).map((t) => [t.pid, t])), mine = new Set(all.map((t) => t.pid));
    gemAgys = gemAgyConvs(new Set([...[...gemPids].filter((p) => !mine.has(p)), ...ours.keys()]));
    gemPc = new Map([...gemAgys].filter(([, m]) => !ours.has(m.pid)));
    for (const [id, m] of gemAgys) {
      const t = ours.get(m.pid);
      if (t && t.gem.id !== id) { t.gem.id = id; saveRun(); }
    }
    const seen = JSON.stringify([...gemAgys]); // (the list worked out again only when there's something new)
    if (seen !== gemSeen) { gemSeen = seen; gemCache = null; }
  };
  const gemPcScan = async () => {
    if (!WIN || !geminiAccounts().length) { gemPids = new Set(); gemAgys = new Map(); gemPc = new Map(); return; }
    const r = await execA('tasklist', ['/fi', 'imagename eq agy.exe', '/fo', 'csv', '/nh']);
    gemPids = new Set([...r.stdout.matchAll(/^"agy\.exe","(\d+)"/gim)].map((m) => +m[1]));
    gemRead();
  };
  setInterval(() => gemPcScan().catch(() => {}), 10000);
  setTimeout(() => gemPcScan().catch(() => {}), 2000);
  async function startGem(acct, cwd, resume, cols = 100, rows = 30) {
    const g = geminiAccounts()[acct - 1], agy = agyCmd();
    if (!g) throw new Error('没有这个 Gemini 账号');
    if (!agy) throw new Error(`没找到 agy，先装好 Antigravity 的命令行：${AGY_GET}`);
    if (sameDir(cwd, BUTLER)) throw new Error('管家的文件夹里不开 Gemini 对话');
    await gemOn(g);
    const twice = resume && gemLive().find((x) => x.gem.id === resume); // opened again while this one's switch ran: the first's
    if (twice) return twice;
    try { gemTrust(cwd); } catch {} // its folder trusted first, as a GPT one's (agy's question there isn't one 对话 can show)
    const key = `p${Date.now().toString(36)}${(++ptys).toString(36)}`;
    const proc = pty.spawn(agy, resume ? ['--conversation', resume] : [], { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, TERM: 'xterm-256color' } });
    const t = { kind: 'pty', key, get pid() { return proc.pid; }, proc, clients: new Set(), buf: '', w: cols, h: rows, cwd, gem: { id: resume ?? null, since: Date.now(), enters: [] } };
    proc.onData((d) => { keepOut(t, d); send(t, 'data', d); });
    proc.onExit(() => { t.gone = true; gemCache = null; send(t, 'gone', {}); saveRun(); setTimeout(() => terms.delete(key), 60000); }); // (ended: not started again after a restart)
    terms.set(key, t); gemCache = null;
    if (!resume) gemIdle(t); // (a page that never connects: its tab closed while this started)
    log('web_session', { profile_id: g.id, cwd, args: resume ? `--conversation ${resume}` : '' });
    return t;
  }
  // a new one nothing was ever sent to, unwatched 30 s on: ended (the list couldn't find it again, and it would hold up
  // every switch)
  // A Gemini one running (here, or in a terminal window), a note as a Claude one's (the page, the island, the phones),
  // looked for every 2 s: its turn over (its record: a reply calling no tool, or an error: said so, since its agy began;
  // however short it was), once each; a question to you (its log: a permission, or its own question, up), once each. A
  // new one's id found first (no page open to ask for the list: no note without it). What was so before this service
  // began isn't news
  const GEM_QUOTA = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted|rate.?limit|credits balance/i;
  const gemNote = (x, kind, s) => {
    const err = kind === 'done' && s?.err;
    dropNote({ kind, project: path.basename(x.cwd), msg: kind === 'ask' ? '需要你确认一下' : !err ? '任务完成，等你下一步指示' : GEM_QUOTA.test(err) ? `额度用完了，可以换个 Gemini 账号接着聊：${err}` : `出错停下了：${err}`,
      title: listGemini().find((g) => g.id === x.id)?.title ?? null, id: x.id, gem: true }, x.pid);
  };
  const gemFrom = Date.now(), told = new Map(); // id → { done: its steps at the last end told, ask: the last question told (its time) }
  setInterval(() => {
    if (gemPids.size || gemLive().length) gemRead();
    if (gemLive().some((t) => !t.gem.id && t.gem.enters.length)) gemSessions();
    const gl = gemPc.size ? listGemini() : [], run = [...gemLive().filter((t) => t.gem.id).map((t) => ({ id: t.gem.id, pid: t.pid, cwd: t.cwd, since: t.gem.since })),
      ...[...gemPc].map(([id, m]) => ({ id, pid: m.pid, since: m.since, cwd: gl.find((g) => g.id === id)?.cwd }))];
    for (const x of run.filter((y) => y.cwd)) try {
      const s = gemSum(x.id), e = gemEnded(s, x.since), a = gemAgys.get(x.id)?.ask;
      if (!told.has(x.id)) told.set(x.id, { done: s && Date.now() - s.lastAt > 15000 ? e : null, ask: null }); // first seen (this service just begun): an old end isn't news
      const k = told.get(x.id);
      if (e != null && k.done !== e) { k.done = e; gemNote(x, 'done', s); }
      if (a && k.ask !== a.at) { k.ask = a.at; if (a.at >= gemFrom - 5000) gemNote(x, 'ask'); }
    } catch {}
    for (const id of told.keys()) if (!run.some((x) => x.id === id)) told.delete(id);
  }, 2000);
  const gemIdle = (t) => setTimeout(() => { gemCache = null; gemSessions(); if (!t.clients.size && !t.gem.id && !t.gem.enters.length && !t.gone) t.proc.kill(); }, 30000);
  let gemCache = null, gemAt = 0;
  const gemSessions = () => {
    if (gemCache && Date.now() - gemAt < 3000) return gemCache;
    const list = listGemini(load()), live = gemLive(), taken = new Set(live.map((t) => t.gem.id).filter(Boolean));
    for (const t of live.filter((x) => !x.gem.id)) { // (the earliest such: its first message)
      const s = list.filter((x) => !taken.has(x.id) && x.made >= t.gem.since - 5000 && sameDir(x.cwd, t.cwd)
        && t.gem.enters.some((e) => x.made >= e - 3000 && x.made <= e + 10000)).sort((a, b) => a.made - b.made)[0];
      if (s) { t.gem.id = s.id; taken.add(s.id); }
    }
    for (const s of list) {
      const t = live.find((x) => x.gem.id === s.id);
      // what its record says, from steps this agy wrote (one an earlier agy left mid-turn isn't at work now); to the second
      // (one cut short since its last step: not at work). Waiting on you: a question up, as its log says (its record has
      // no step for it), and no step since (one whose answer it didn't log)
      const m = !t && gemPc.get(s.id), lg = gemAgys.get(s.id), now = (t ? s.lastAt >= t.gem.since - 1000 : m && s.lastAt >= m.since - 1000) && !(lg?.cut >= s.lastAt);
      if (t) { s.pid = t.pid; s.key = t.key; s.web = true; } else if (m) { s.pid = m.pid; s.web = false; } // (one in a terminal window: not here)
      if (t || m) { s.wait = !!(lg?.ask && !(s.lastAt > lg.ask.at + 2000)) || (!!now && s.going === 'wait'); s.busy = !s.wait && !!now && s.going === 'busy'; }
    }
    gemCache = list; gemAt = Date.now();
    return list;
  };
  // a conversation already being continued here: until its Claude has written its session file the list says it
  // isn't running, so a second open (a double tap, a second device) would start a second Claude on the same record
  let ptys = 0;
  // only till its Claude has written its session file (then it's listed with its pid): after a /clear or /resume there,
  // it runs another conversation, and this one, tapped, would open that
  const resuming = (id) => [...terms.values()].find((t) => t.resume === id && !t.gone
    && !(t.pid && (t.mac ? macLive({ id: t.mac }).some((j) => -j.pid === t.pid) : fs.existsSync(path.join(t.dir, 'sessions', `${t.pid}.json`)))));
  // `claude-multi <cmd> <id> …` for a conversation, apart from this process: what it printed, or that as the error
  const command = (what, id, ...more) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('没有这个对话');
    if (resuming(id)) throw new Error('这个对话正在运行，先结束它');
    sessCache = null;
    if (!sessions().some((x) => x.id === id)) throw new Error('找不到这个对话，可能已经删了'); // (rename's own words: its usage line)
    const free = hold(id, 'change');
    return new Promise((ok, no) => require('child_process').execFile(process.execPath, [__filename, what, id, ...more], { windowsHide: true },
      (e, stdout) => { sessCache = null; const said = String(stdout ?? '').trim(); if (e) no(new Error(said || e.message)); else ok({ said }); })).finally(free);
  };
  // 删除 for a GPT one: archived, Codex's own way (codex archive; codex unarchive brings it back), not while it runs here
  function archiveGpt(id) {
    const s = gptSessions().find((x) => x.id === id);
    if (!s) throw new Error('找不到这个对话，可能已经删了');
    if (s.pid || gptLive().some((t) => t.gpt.id === id)) throw new Error('这个对话正在运行，先结束它');
    if (!codex) throw new Error('没找到 codex');
    const free = hold(id, 'change');
    return new Promise((ok, no) => require('child_process').execFile(codex.file, [...codex.pre, 'archive', id], { env: codexEnv(codex, s.home), windowsHide: true },
      (e, stdout, stderr) => {
        gptCache = null;
        if (e) no(new Error(`没归档成：${String(stderr || stdout || e.message).trim().split('\n').pop()}`));
        else ok({ said: `已归档「${s.title}」，在 Codex 里用 codex unarchive 能找回。` });
      })).finally(free);
  }
  // a conversation started or continued here: claude in a pseudo-terminal, its output kept (last 256 KB) for
  // whoever opens it later
  function startPty(p, cwd, args, cols = 100, rows = 30) {
    const key = `p${Date.now().toString(36)}${(++ptys).toString(36)}`; // the count too: two started in one ms were one key
    shareMemory([[p.configDir, projectFolder(cwd)]]);
    shareMcp(p.configDir); shareTrust(p.configDir);
    // TERM: the page's terminal is an xterm. Without it (the service starts hidden, no WT_SESSION) Claude thinks the
    // console can't draw its symbols and falls back to plain ones: "> No, exit", not "❯", and the page saw no menu
    const proc = pty.spawn(claudeExe, args, { name: 'xterm-256color', cols, rows, cwd, env: { ...childEnv(p.configDir), TERM: 'xterm-256color' } });
    // pid read live: node-pty only knows it once the pseudo-terminal is ready (it is 0 right after spawn)
    const t = { kind: 'pty', key, get pid() { return proc.pid; }, proc, clients: new Set(), buf: '', w: cols, h: rows, cwd, dir: p.configDir,
      resume: args[0] === '--resume' ? args[1] : null };
    proc.onData((d) => {
      if (!t.listed && proc.pid) { t.listed = true; saveTerms(); }
      keepOut(t, d); send(t, 'data', d);
    });
    // ended to go on with another account (switching): its pages are sent to the new one instead of told it's gone
    proc.onExit(() => { t.gone = true; saveTerms(); saveRun(); if (!t.switching) send(t, 'gone', {}); setTimeout(() => terms.delete(key), 60000); });
    terms.set(key, t);
    log('web_session', { profile_id: p.id, cwd, args: args.join(' ') });
    return t;
  }
  // a GPT conversation started or continued here: codex in a pseudo-terminal, in its account's CODEX_HOME (acct from 1),
  // the folder trusted there first (Codex asks of a new one, and the page has no card for its question yet)
  function startGpt(acct, cwd, resume, cols = 100, rows = 30) {
    const g = gptAccounts()[acct - 1];
    if (!g) throw new Error('没有这个 GPT 账号');
    if (!codex) throw new Error('没找到 codex，先装好 Codex：npm i -g @openai/codex');
    gptTrust(g.home, cwd);
    const key = `p${Date.now().toString(36)}${(++ptys).toString(36)}`;
    const proc = pty.spawn(codex.file, [...codex.pre, ...gptNotifyArgs(g.home), ...(resume ? ['resume', resume] : [])], { name: 'xterm-256color', cols, rows, cwd, env: { ...codexEnv(codex, g.home), TERM: 'xterm-256color' } });
    const t = { kind: 'pty', key, get pid() { return proc.pid; }, proc, clients: new Set(), buf: '', w: cols, h: rows, cwd, gpt: { acct: acct - 1, home: g.home, id: resume ?? null, since: Date.now() } };
    // its pid once the pseudo-terminal is ready (0 before): its marker, and the web-terms list the island reads
    proc.onData((d) => {
      if (!t.marked && proc.pid) { t.marked = proc.pid; markWeb(t); saveTerms(); }
      keepOut(t, d); send(t, 'data', d);
    });
    proc.onExit(() => { t.gone = true; gptCache = null; if (t.marked) gptUnmark(t.marked); saveTerms(); send(t, 'gone', {}); setTimeout(() => terms.delete(key), 60000); });
    terms.set(key, t); gptCache = null;
    log('web_session', { profile_id: g.id, cwd, args: resume ? `resume ${resume}` : '' });
    return t;
  }
  // A conversation on the Mac (resume: its id), started, continued or joined here: ssh in a pseudo-terminal, its Claude
  // in a tmux there (macCmd). Its pid and tmux session come first, as an OSC that's taken out: the pid this one has is
  // that one's, negative, as the list has it. What a last try that never got there said is shown.
  // ⏺, the Mac's reply mark, as ● (a Windows one's): this PC's fonts draw it as a blue emoji.
  // o: {resume, cwd} continues one in its folder there; {pc} starts one for a folder here, in a project folder of its own
  // there named after it (made the first time, with a CLAUDE.md saying where it is here); {} starts one in the Mac's folder
  // id: which Mac (the registry's entry)
  function startMac(id, o, cols = 100, rows = 30) {
    const m = macOf(id, load());
    if (!m) throw new Error('没有这台 Mac');
    const pw = macPassword(m);
    if (!pw) throw new Error(macNoPw(m));
    const key = `p${Date.now().toString(36)}${(++ptys).toString(36)}`, resume = o.resume ?? null;
    let into = `cd ${m.dir}`;
    if (o.resume) { const pc = o.cwd && macPcOf(o.cwd, m); into = `cd ${sq(o.cwd)}${pc ? ` && ${macRules(pc)}` : ''}`; }
    else if (o.pc) {
      const name = macName(o.pc), at = o.pc.replace(/\\/g, '/');
      const md = `# 项目：${name}\n\n这个项目在用户 Windows 电脑上的 \`${at}\`，不在这台 Mac 上；这个文件夹只是它在 Mac 上启动的地方（怎么连那台电脑，见上一层的 CLAUDE.md）。\n\n`
        + `- 先 \`ssh pc\` 看看那边有没有 \`${at}/CLAUDE.md\`，有就读一遍，照它的规矩来。\n- 读、改、编译、运行、用 git，都在那边的 \`${at}\` 里做。\n`;
      into += ` && mkdir -p ${sq(name)} && cd ${sq(name)} && { [ -f CLAUDE.md ] || echo ${Buffer.from(md).toString('base64')} | base64 -D > CLAUDE.md; } && ${macRules(o.pc)}`;
      macFolders(m, { [name]: o.pc });
    }
    const cmd = macCmd({ into, resume, name: `cm-${key}`, cols, rows, config: m.config });
    const t = { kind: 'pty', key, mac: m.id, macPid: 0, macSess: null, back: 0, get pid() { return -this.macPid; }, clients: new Set(), buf: '', w: cols, h: rows, cwd: o.pc ?? o.cwd ?? m.dir, resume };
    let tries = 0, pre = '';
    const go = () => {
      const proc = t.proc = pty.spawn(sshExe, ['-tt', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'SendEnv=LC_MACKC', m.host,
        t.macSess ? macCmd({ sess: t.macSess }) : cmd], { name: 'xterm-256color', cols: t.w, rows: t.h, env: { ...process.env, LC_MACKC: pw, TERM: 'xterm-256color' } });
      proc.onData((d) => {
        if (!t.macPid) {
          const k = /\x1b\]1337;cmpid=(\d+);([\w-]+)\x07/.exec(pre += d);
          if (!k) return;
          t.macPid = +k[1]; t.macSess = k[2]; d = pre.slice(k.index + k[0].length); pre = ''; saveTerms();
        }
        t.back = 0; // joined (again): a next drop tried again afresh
        d = d.replace(/⏺/g, '●');
        keepOut(t, d); send(t, 'data', d);
      });
      // ssh's 255: the link. Before it got there, tried again (3 times in all); once there, its Claude works on in its tmux,
      // joined again every 5 s for 10 minutes. Anything else (Claude ended, so its tmux; a refusal said): it's gone.
      proc.onExit(({ exitCode }) => {
        if (exitCode === 255 && (t.macPid ? ++t.back <= 120 : ++tries < 3)) { pre = ''; return setTimeout(go, t.macPid ? 5000 : 1500); }
        if (!t.macPid && pre) { keepOut(t, pre); send(t, 'data', pre); } // why it never got there
        t.gone = true; saveTerms(); saveRun(); send(t, 'gone', {}); setTimeout(() => terms.delete(key), 60000);
      });
    };
    go();
    terms.set(key, t);
    log('web_session', { profile_id: m.id, cwd: t.cwd, args: resume ? `--resume ${resume}` : '' });
    return t;
  }
  // The copy here of the Mac's records and of which of its conversations run (MAC_WATCH there, one ssh connection
  // kept up: again 2 s after a drop, waiting longer, to a minute, while each try fails at once). One of yours there that
  // stops answering, or asks, is a note, as a hook's here.
  // One per Mac entry (w: its watcher's state, by id: proc, wait, other: its other folders' records, how far each was
  // read there, others.json); macSys: each Mac's newest {sys}, and when it came, by host.
  // shortcut: an entry added to the registry is watched from the next start of this service
  const macWs = new Map(), macSys = new Map();
  const macWatch = () => { for (const m of macList(load())) macWatchOne(m.id); };
  function macWatchOne(id) {
    const m = macOf(id, load()), w = macWs.get(id) ?? { proc: null, wait: 2000, other: {} };
    macWs.set(id, w);
    if (!m || w.proc) return;
    const home = macHome(m), have = {}, since = Date.now();
    for (const d of ls(path.join(home, 'projects'))) for (const n of ls(path.join(home, 'projects', d))) {
      if (n.endsWith('.jsonl')) try { have[`${d}/${n}`] = fs.statSync(path.join(home, 'projects', d, n)).size; } catch {}
      else for (const a of ls(path.join(home, 'projects', d, n, 'subagents'))) if (a.endsWith('.jsonl')) try { have[`${d}/${n}/subagents/${a}`] = fs.statSync(path.join(home, 'projects', d, n, 'subagents', a)).size; } catch {}
    }
    const proc = w.proc = require('child_process').spawn(sshExe, ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3', m.host, 'python3', '-u', '-'], { windowsHide: true });
    proc.stdin.on('error', () => {});
    try { w.other = JSON.parse(fs.readFileSync(path.join(home, 'others.json'), 'utf8')); } catch { w.other = {}; }
    proc.stdin.end(`DIR = ${JSON.stringify(m.dir)}\nCFG = ${pyVal(m.config)}\nHAVE = ${JSON.stringify(have)}\nOTHER = ${JSON.stringify(w.other)}\n${MAC_WATCH}`);
    let line = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      line += d;
      for (let k; (k = line.indexOf('\n')) >= 0; line = line.slice(k + 1)) {
        let o; try { o = JSON.parse(line.slice(0, k)); } catch { continue; }
        try { macCopy(m, w, o, proc); } catch (e) { log('mac_copy_fail', { mac: id, err: e.message }); }
      }
    });
    proc.on('exit', () => {
      w.proc = null;
      w.wait = Date.now() - since > 60000 ? 2000 : Math.min(60000, w.wait * 2);
      setTimeout(() => macWatchOne(id), w.wait);
    });
  }
  // (a name the Mac sends is a project folder and one name in it, or a record in that one's subagents, nothing else:
  // never a way out of its copy here, accounts\<id>)
  const macPath = (home, k, top = 'projects') => { if (!/^[\w.-]+\/[\w.-]+(\/subagents\/[\w.-]+)?\/?$/.test(k) || k.includes('..')) throw new Error(`不认识的名字：${k}`); return path.join(home, top, ...k.split('/').filter(Boolean)); };
  function macCopy(m, w, o, proc) {
    const home = macHome(m);
    if (o.f) {
      const f = macPath(home, o.f), size = fs.existsSync(f) ? fs.statSync(f).size : 0;
      if (o.at > size) return proc.kill(); // a gap (this copy cut short meanwhile): the next connection sends from what's here
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (o.at < size) fs.truncateSync(f, o.at);
      fs.appendFileSync(f, Buffer.from(o.d, 'base64'));
    } else if (o.o) { // a record of another folder there, its replies' usage only: kept apart (others\), counted as its own row
      const f = macPath(home, o.o, 'others');
      if (o.at && o.at !== (w.other[o.o] ?? 0)) return proc.kill(); // a piece missed (a write failed): sent again from here's
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (!o.at) fs.rmSync(f, { force: true }); // from its start (the first of it, or rewritten there)
      fs.appendFileSync(f, Buffer.from(o.d, 'base64'));
      w.other[o.o] = o.to; fs.writeFileSync(path.join(home, 'others.json'), JSON.stringify(w.other));
    } else if (o.t) {
      fs.mkdirSync(macPath(home, o.t), { recursive: true });
      fs.writeFileSync(path.join(macPath(home, o.t), 'custom-title.json'), Buffer.from(o.d, 'base64'));
    } else if (o.gone) {
      fs.rmSync(o.gone.endsWith('/') ? path.join(macPath(home, o.gone), 'custom-title.json') : macPath(home, o.gone), { force: true });
    } else if (o.sys) {
      macSys.set(m.host, { ...o.sys, at: Date.now() });
    } else if (o.live) {
      const was = new Map(macLive(m).map((j) => [j.sessionId, j.status])), going = (st) => st === 'busy' || st === 'shell';
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'live.json.tmp'), JSON.stringify(o.live));
      fs.renameSync(path.join(home, 'live.json.tmp'), path.join(home, 'live.json'));
      sessCache = null;
      for (const j of o.live) {
        if (j.kind && j.kind !== 'interactive') continue; // a claude -p's is for whoever ran it
        const before = was.get(j.sessionId), kind = going(before) && !going(j.status) && j.status !== 'waiting' ? 'done'
          : j.status === 'waiting' && before && before !== 'waiting' ? 'ask' : null;
        if (!kind) continue;
        const s = sessions().find((x) => x.id === j.sessionId);
        dropNote({ kind, project: path.basename(s?.cwd ?? m.dir), msg: kind === 'done' ? '任务完成，等你下一步指示' : '需要你确认一下', title: s?.title ?? null, id: j.sessionId });
      }
    }
  }
  // a conversation open in a terminal window here: its screen through the console bridge, while anyone watches
  function mirror(pid, dir) {
    if (!WIN) throw new Error('这个对话正在别处的终端里运行，网页接不上它：在那个终端里接着用，或者先关掉它');
    const key = `w${pid}`;
    if (terms.has(key) && !terms.get(key).gone) return terms.get(key);
    const proc = require('child_process').spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(ROOT, 'console-bridge.ps1'), String(pid)], { windowsHide: true });
    const t = { kind: 'pc', key, pid, dir, proc, clients: new Set(), frame: null, w: 0, h: 0, hist: [], waiting: [] }; // hist: lines scrolled off, colored
    proc.stdin.on('error', () => {}); // write callbacks report failures to their requests; the event must not crash the service
    let line = '';
    proc.stdout.setEncoding('utf8'); // decoded as one stream: a Chinese character split between two chunks stays whole
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
    proc.on('exit', () => { // its own entry only: a new reader of the same window may have its key by now
      t.gone = true; send(t, 'gone', {}); t.waiting.splice(0).forEach((f) => f());
      if (terms.get(key) === t) terms.delete(key);
    });
    setTimeout(() => { if (!t.clients.size) proc.kill(); }, 30000); // opened but nobody came to watch: not left running
    terms.set(key, t);
    return t;
  }
  const where = (s) => [...terms.values()].find((t) => !t.gone && t.pid === s.pid); // ours, or a window here
  // what a page gets first: our terminal's output; for a window here, the record before what its reader kept,
  // the kept lines, then pushed off the screen (a newline per row) so the frame doesn't cover them, and the frame
  function replay(t) {
    if (t.kind === 'pty') return replayPty(t);
    let l = { text: '', skip: 0 };
    const rows = (t.frame ?? '').replace(/^\x1b\[H/, '').split('\r\n');
    try { if (t.file && t.w) { const h = history(t.file, { keep: Infinity }); l = lead(h.items, [...t.hist, ...rows], h.start > 0); } } catch {} // all of it: the window's kept lines reach further back than a page's first look
    const above = (l.text ? [l.text] : []).concat(t.hist.slice(l.skip)).join('\r\n');
    return (above ? above + '\r\n'.repeat(t.h) : '') + (t.frame ?? '');
  }
  // for the island and `claude-multi attach`: which running conversations are ours
  function saveTerms() {
    const up = [...terms.values()].filter((t) => t.kind === 'pty' && !t.gone && t.pid); // a GPT one's too: the island opens it here
    try { fs.writeFileSync(WEB_TERMS, JSON.stringify(up.map((t) => t.pid))); } catch {}
  }
  // and which conversations run here, by id (one just started has it once listed: looked at every 10 s too). A service
  // killed never writes again, so after a restart this says what ran, and each is continued.
  // Run from a timer and from a terminal's exit: whatever goes wrong here (the list unreadable a moment) waits for the next
  // time, never ends the service.
  let ranHere = null;
  function saveRun() {
    try {
      const pids = new Set([...terms.values()].filter((t) => t.kind === 'pty' && !t.gone && t.pid).map((t) => t.pid));
      const now = JSON.stringify([...sessions().filter((s) => s.pid && pids.has(s.pid)).map((s) => s.id), // (a Gemini one's: gem:<id>)
        ...gemLive().filter((t) => t.gem.id).map((t) => `gem:${t.gem.id}`)]);
      if (now !== ranHere) { fs.writeFileSync(WEB_RUN, now); ranHere = now; }
    } catch {}
  }

  // the record of the conversation asked for (?key, ?id): by the open terminal's key, else by its id. By the key, the
  // conversation its Claude runs now, asked each time: a /clear or /resume typed there moves it to another one (its
  // session file says which; a window's, the list), and the page went on showing the first while you typed into the
  // other. One with nothing said yet has no record: none (file null) till it has; not read yet (its session file not
  // written yet, file undefined): by the id asked for, as before.
  function recordOf(q) {
    const t = terms.get(q.get('key') ?? '');
    if (t?.dir && t.pid) try {
      const id = JSON.parse(fs.readFileSync(path.join(t.dir, 'sessions', `${t.pid}.json`), 'utf8')).sessionId;
      if (path.basename(t.file ?? '', '.jsonl') !== id) {
        t.file = null;
        for (const d of ls(path.join(t.dir, 'projects'))) if (fs.existsSync(path.join(t.dir, 'projects', d, `${id}.jsonl`))) t.file = path.join(t.dir, 'projects', d, `${id}.jsonl`);
      }
    } catch {} // caught mid-write: as it was
    else if ((t?.kind === 'pc' || t?.mac) && t.pid) { const s = sessions().find((x) => x.pid === t.pid); if (s) t.file = s.file; } // a window's, a Mac's: by the list
    // (a path gone since: a 换账号继续 moved the record to the other account; found again by its id)
    return { t, file: t?.file === undefined || (t.file && !fs.existsSync(t.file)) ? sessions().find((x) => x.id === q.get('id'))?.file : t.file };
  }

  // A new notification to the phones, but none for a conversation a page shows you right now: each page in front says
  // which ones it shows with its look every 5 s (a page in the background, or a locked phone, stops looking).
  const viewing = new Map(); // conversation id → when a page last said it shows it
  // Its text has Claude's last words (gist), read from the record here a moment after the note: the hook runs before
  // Claude has written them (the hook found the words before them).
  let pushedTo = Date.now(); // the ones before the service started were for the island
  const lastWords = (f, max) => {
    if (!f) return '';
    const fd = fs.openSync(f, 'r'), size = fs.fstatSync(fd).size, tail = slice(fd, Math.max(0, size - 4194304), 4194304);
    fs.closeSync(fd);
    return gist(tail, max);
  };
  // a conversation by its id, Claude's or GPT's; its last reply's gist (a note's text)
  const anyChat = (id) => sessions().find((x) => x.id === id) ?? gptSessions().find((x) => x.id === id) ?? gemSessions().find((x) => x.id === id);
  const wordsOf = (s, max) => (s?.gem ? gistText(gemLast(s.id), max) : s?.gpt ? gistText(gptLast(s.home, s.id, 'agentMessage'), max) : lastWords(s?.file, max));
  // who set a conversation's latest turn going (turnBy), by its record (a GPT one's: its last message of yours)
  // (null when its record can't be read now, deleted since the list was read: the push timer asks outside its try)
  // the same for the page, on each note it gets (by: the 管家's turns aren't marked as answered for you), kept once read,
  // none found too (a GPT 聊天 one's has no record to read): it doesn't change, and a record's tail is 4 MB to read. Never
  // in the way of the list: one that can't be told is null
  const owners = new Map();
  const noteBy = (n) => {
    const k = `${n.id}|${n.at}`;
    if (!owners.has(k)) {
      let o = null;
      try { o = ownerOf(n); } catch {}
      if (owners.size > 500) owners.clear();
      owners.set(k, o);
    }
    return owners.get(k);
  };
  // (the 管家's own turn: 'notice' when the service set it going, a [系统通知] typed into it; else 'you'. A GPT 聊天 one's:
  // its last message of yours, against what the 管家 sent it)
  const ownerOf = (n) => {
    if (/^oai-/.test(n.id ?? '')) { let c; try { c = oaiRead(n.id); } catch { return null; } return turnBy(c.msgs.findLast((m) => m.role === 'user')?.text, blogSent(n.id), n.at); }
    if (n.gem) return turnBy(gemLast(n.id, true), blogSent(n.id), n.at); // a Gemini one's: its last message of yours, as a GPT one's
    const s = sessions().find((x) => x.id === n.id), f = s?.file;
    if (!f) { const g = gptSessions().find((x) => x.id === n.id); return g ? turnBy(gptLast(g.home, g.id, 'userMessage'), blogSent(n.id), n.at) : null; }
    let tail;
    try { const fd = fs.openSync(f, 'r'); try { tail = slice(fd, Math.max(0, fs.fstatSync(fd).size - 4194304), 4194304); } finally { fs.closeSync(fd); } } catch { return null; }
    // what was typed by the time the note came (5 s over it, for a clock a little off): one you type later is the next turn's
    const p = lastTyped(tail, n.at + 5000);
    if (sameDir(s.cwd, BUTLER)) return p ? (p.startsWith('[系统通知]') ? 'notice' : 'you') : null;
    return turnBy(p, blogSent(n.id), n.at);
  };
  setInterval(() => {
    const fresh = readNotes(20).filter((n) => n.at > pushedTo && Date.now() - n.at > 1500).reverse();
    if (!fresh.length) return;
    pushedTo = fresh.at(-1).at;
    // the 管家 running: a turn it set going is its to tell you (chat tell), not pushed; its own reply only to what you asked
    // it (not to a [系统通知]: what's worth it there it tells you), and its own question (stuck on that, it can't tell you);
    // the rest, the ones you set going, as ever
    const me = sessions().find((x) => x.pid && sameDir(x.cwd, BUTLER));
    for (const n of fresh) if (!(n.id && Date.now() - (viewing.get(n.id) ?? 0) < 12000) && (!me || (n.id === me.id ? n.kind === 'ask' || ownerOf(n) === 'you' : ownerOf(n) !== 'butler')))
      try {
        const s = n.id && anyChat(n.id), mine = s && sameDir(s.cwd, BUTLER), name = mine ? '管家' : n.title || n.project || 'Claude', folder = s ? (mine ? '' : path.basename(s.cwd)) : n.project;
        const m = { ...pushText({ ...n, gist: s ? wordsOf(s, 150) : n.gist }), id: n.id, group: name, ask: n.kind === 'ask', // a GPT 聊天 one's: on its note
          sub: [folder !== name && folder, s && (s.gem ? `Gemini 账号 A${s.acct + 1}` : s.gpt ? `GPT 账号 G${s.acct + 1}` : `账号 ${s.acct + 1}`)].filter(Boolean).join(' · ') };
        (barkUrl() ? bark(m) : pushAll(m)).catch(() => {}); // Bark set up: it alone, not twice
      } catch {}
  }, 2000);
  setInterval(() => oaiPoll().catch(() => {}), 4000); // the GPT 聊天 answers pending at OpenAI

  // A ticket's conversation ended a turn (its last words kept: what it stopped on), or stopped on a question: the 管家 told.
  // Read from where the last service left off (kept in a file): one written just before a restart, or during it, isn't
  // missed; one taken twice changes nothing (notesInto). Phones go on from the start: older ones were the island's.
  let seenTo = readSeen();
  setInterval(() => {
    const fresh = notesUnseen(allNotes(), seenTo);
    if (!fresh.length) return;
    try {
      const oaiWords = (id) => { try { return gistText(oaiLast(oaiRead(id)), 300); } catch { return ''; } }; // a GPT 聊天 one's answer
      const words = (id) => (/^oai-/.test(id) ? oaiWords(id) : wordsOf(anyChat(id), 300)), owner = new Map();
      const by = (n) => (owner.has(n) ? owner.get(n) : owner.set(n, ownerOf(n)).get(n)), open = readTickets().filter((t) => !t.end);
      if (fresh.some((n) => n.id && open.some((t) => t.conv === n.id))) // the tickets first, then the place
        for (const i of editTickets((all) => notesInto(all, fresh, words, (n) => by(n) === 'you'))) { toTell.add(i); tries.delete(i); } // news: its tries start again
      // a conversation the 管家 asked something outside a ticket (chat say, chat new): its answer goes back to it (a recent
      // one: the notes from the start, read after no place was saved, aren't news)
      for (const n of fresh) if (n.id && Date.now() - n.at < 600000 && !open.some((t) => t.conv === n.id) && by(n) === 'butler') {
        replies.set(n.id, { title: n.title || n.project || n.id, kind: n.kind, text: n.kind === 'done' ? words(n.id) : '' });
        tries.delete(`c:${n.id}`);
      }
      seenTo = fresh.at(-1).at;
      fs.writeFileSync(TICKETS_SEEN, JSON.stringify(seenTo));
    } catch (e) { log('ticket_note_fail', { err: e.message }); }
  }, 2000);

  // For the 管家's 操作台: this computer's CPU, busy since the last sample (taken 2 s apart at least: pages ask within
  // moments of each other, and a tiny gap reads wild), and memory in use
  const cpuSum = () => os.cpus().reduce(([all, idle], c) => [all + Object.values(c.times).reduce((x, y) => x + y, 0), idle + c.times.idle], [0, 0]);
  let cpuPrev = cpuSum(), cpuAt = Date.now(), cpuPct = null;
  const pcNow = () => {
    if (Date.now() - cpuAt >= 2000) {
      const now = cpuSum(), all = now[0] - cpuPrev[0];
      if (all > 0) cpuPct = Math.round(100 * (1 - (now[1] - cpuPrev[1]) / all));
      cpuPrev = now; cpuAt = Date.now();
    }
    return { cpu: cpuPct, mem: os.totalmem() - os.freemem(), memAll: os.totalmem() };
  };
  // 额度's CPU and memory (id here: this one's, under 推荐账号), Claude Code's part in it (read with PowerShell every 3 s at most, whoever asks: the newest
  // sample given at once, the next read meanwhile). A read that failed starts over (no CPU till the next one).
  const UNREAD = { cpu: null, mem: null, n: null, prev: null };
  let share = { ...UNREAD, at: 0 }, sharing = false;
  const machines = () => {
    if (WIN && !sharing && Date.now() - share.at >= 3000) { // macOS: no Claude part (CLAUDE_PS is PowerShell)
      sharing = true; const at = Date.now();
      require('child_process').execFile('powershell.exe', ['-NoProfile', '-Command', CLAUDE_PS], { windowsHide: true, timeout: 15000 }, (e, out) => {
        sharing = false;
        share = { ...(e ? UNREAD : claudeShare(out, share.prev, at - share.at, os.cpus().length)), at };
      });
    }
    const pc = pcNow(), within = (x, all) => (x == null || all == null ? x : Math.min(x, all)); // its CPU over its own 2 s, Claude's over 3
    // each Mac once (by host: its accounts share it), named as its first entry; id mac:<host>, which its cards show
    const seen = new Set(), mac = macList(load()).filter((m) => !seen.has(m.host) && seen.add(m.host))
      .map((m) => { const x = macSys.get(m.host); return { id: `mac:${m.host}`, name: m.label, ...(x && Date.now() - x.at < 30000 ? x : { err: '读不到：还没连上 Mac' }) }; });
    return [{ id: 'here', name: os.hostname(), cpu: pc.cpu, mem: pc.mem, memAll: pc.memAll, n: share.n, cpuClaude: within(share.cpu, pc.cpu), memClaude: within(share.mem, pc.mem) }, ...mac];
  };
  // its tickets, as the 操作台 shows them: the open ones, what waits on you first, then the last 5 ended. Only this service
  // writes them (written whole, then swapped in: a crash mid-write leaves the old file)
  const editTickets = (fn) => { const all = readTickets(), r = fn(all); fs.writeFileSync(`${TICKETS}.tmp`, JSON.stringify(all, null, 1)); fs.renameSync(`${TICKETS}.tmp`, TICKETS); return r; };
  const editProjects = (fn) => { const all = readProjects(), r = fn(all); fs.writeFileSync(`${PROJECTS}.tmp`, JSON.stringify(all, null, 1)); fs.renameSync(`${PROJECTS}.tmp`, PROJECTS); return r; };
  const ticketsNow = (list = [...sessions(), ...gptSessions(), ...gemSessions()]) => { // a ticket's conversation: Claude's, GPT's or Gemini's
    const all = readTickets().map((t) => { const s = list.find((x) => x.id === t.conv); return { ...t, ev: undefined, stage: stageOf(t, s), convTitle: s?.title ?? null }; });
    const open = all.filter((t) => !t.end).sort((a, b) => STAGE_ORDER.indexOf(a.stage[1]) - STAGE_ORDER.indexOf(b.stage[1]) || a.id - b.id);
    return [...open, ...all.filter((t) => t.end).sort((a, b) => b.end.at - a.end.at).slice(0, 5)];
  };
  // today, newest first, the 管家's own doings (its log)
  const timeline = () => {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const t0 = d0.getTime(), out = [];
    let log = ''; try { log = fs.readFileSync(BLOG, 'utf8'); } catch {}
    for (const l of log.split('\n')) try { const j = l && JSON.parse(l); if (j?.at >= t0 && j.who !== 'you') out.push({ ...j, kind: 'butler' }); } catch {}
    return out.sort((a, b) => b.at - a.at).slice(0, 30);
  };
  let tokAt = 0, tokCache = null, tokNow = null;
  // the model and effort it starts with (model, effortLevel): its folder's settings.local.json (chosen on the page) over
  // settings.json
  const butlerSet = (k) => { for (const n of ['settings.local.json', 'settings.json']) try { const m = JSON.parse(fs.readFileSync(path.join(BUTLER, '.claude', n), 'utf8'))[k]; if (m) return m; } catch {} return null; };
  const asks = new Map(); // conversation id → its question as last read off its screen {at, menu (a promise)}
  const api = {
    ...ext?.api,
    // claude-multi web restart: this service ends, as any stop ends it (a conversation answering is cut; wakeUp takes it up
    // on the next start), with its exit handlers run: the tunnel's ssh goes too. The command starts the next one
    'POST /api/quit': () => { log('web_quit', {}); setTimeout(() => process.exit(0), 200); return { ok: true }; },
    // 更新: claude-multi update on its own (detached), to outlive this service when its setup restarts it, and not as a
    // Claude conversation's (one that started this service), which setup would leave unrestarted. Its words in update.log;
    // when it ends with this service still here (it failed, or found nothing new), its last line for the page
    'POST /api/update': () => {
      if (updBusy) return { ok: true };
      const f = path.join(ROOT, 'update.log'), out = fs.openSync(f, 'w'), { CLAUDECODE, ...env } = process.env;
      const p = require('child_process').spawn(process.execPath, [__filename, 'update'], { detached: true, stdio: ['ignore', out, out], env, windowsHide: true });
      fs.closeSync(out);
      updBusy = true; updErr = null; log('web_update', {});
      p.on('exit', (code) => {
        let last = '';
        try { last = fs.readFileSync(f, 'utf8').trim().split('\n').pop(); } catch {}
        updBusy = false; updErr = code ? last || `更新退出了（${code}）` : null; checkUpd();
      }).unref();
      return { ok: true };
    },
    // 代理额度: read when its view is shown (a minute's cache); one account, or all, asked again by hand (30 s apart)
    'GET /api/local-quota': () => quota.get(),
    'POST /api/local-quota/refresh': (q, b) => quota.refresh(b?.id),
    // the questions other conversations wait on, as their screens show them (管家 mode has them as cards): each read again
    // 3 s after the last read at most, one read for every page asking
    // (a Mac's only when it runs in this service: one in a terminal on the Mac can't be read, and asking ssh'd there each time)
    // (a Gemini one's: its agy's screen, here or in its terminal window)
    'GET /api/asks': async () => Promise.all([...sessions().filter((s) => s.wait && s.pid && !(BUTLER && sameDir(s.cwd, BUTLER)) && (!s.mac || where(s))),
      ...gemSessions().filter((s) => s.wait && s.pid)].map(async (s) => {
      let a = asks.get(s.id);
      if (!a || Date.now() - a.at > 3000) asks.set(s.id, a = { at: Date.now(), menu: screenOf(s.id, !!s.gem).then((r) => r?.menu ?? null, () => null) });
      return { id: s.id, title: s.title, acct: s.acct + 1, gem: !!s.gem, menu: await a.menu };
    })),
    // one answered from such a card: by you, so it isn't held back as the 管家's typing is
    // the 管家's model or effort, for its next start (the page also tells a running one, with /model or /effort: that
    // would make it every new conversation's default too, so the accounts' defaults are put back 8 s on)
    'POST /api/butler-model': (q, b) => {
      if (b.model != null && !BUTLER_MODELS.includes(b.model)) throw new Error('没有这个模型');
      if (b.effort != null && !BUTLER_EFFORTS.includes(b.effort)) throw new Error('没有这个思考强度');
      const shared = [...new Set(load().profiles.flatMap((p) => { try { return [fs.realpathSync(path.join(p.configDir, 'settings.json'))]; } catch { return []; } }))];
      setTimeout(keepDefaults(shared), 8000);
      const f = path.join(BUTLER, '.claude', 'settings.local.json');
      let j = {}; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      fs.writeFileSync(f, JSON.stringify({ ...j, ...(b.model && { model: b.model }), ...(b.effort && { effortLevel: b.effort }) }, null, 2));
      return { model: b.model, effort: b.effort };
    },
    'POST /api/pick': async (q, b) => {
      try {
        return { label: await pickOn(String(b.id), b.n, b.ask, 'you', gemSessions().some((x) => x.id === String(b.id))) };
      } finally { asks.delete(String(b.id)); }
    },
    // the quota as last read, at once: reading it again (each account's, over the network) takes a second or
    // more, so one over a minute old is read again in the background, for the next look. That read goes abroad
    // through this computer's proxy, and hung the page for up to 20 s while its node was bad: 刷新 (?fresh) waits
    // 3 s at most, then shows the last numbers; the page's next look (10 s) has the new ones.
    'GET /api/state': async (q) => {
      for (const id of (q.get('view') ?? '').split(',').filter(Boolean)) viewing.set(id, Date.now()); // shown in a page in front
      // (a page in the background, bg: there for its tab's unread count only, it doesn't keep the quota read)
      if (!usageCache || (!q.has('bg') && (q.has('fresh') || Date.now() - usageAt > 60000))) usageNow ??= usageState(undefined, { macFresh: q.has('fresh') || !usageAt }).then((r) => {
        usageCache = r.json; usageAt = Date.now();
        fs.writeFile(WEB_USAGE, JSON.stringify(r.json), () => {});
      }, () => {}).finally(() => { usageNow = null; });
      if (!usageCache) await usageNow; // nothing read ever: nothing to show before it
      if (!usageCache) throw new Error('额度读取失败，稍后再试'); // the page can't draw without it
      else if (q.has('fresh')) await Promise.race([usageNow, sleep(3000)]);
      // a running one with what its terminal's status line shows (model, effort, context used), for the page's status bar
      const all = sessions(), list = all.map(({ file, ...s }) => ({ ...s, where: !s.pid ? null : where(s)?.kind === 'pty' ? 'web' : 'pc', line: s.pid ? readLine(s.id) : null }));
      // and the GPT ones among them, by when they were last written (a GPT one runs here or not at all)
      for (const { home, ...s } of gptSessions()) list.push({ ...s, where: !s.pid ? null : s.web ? 'web' : 'pc', line: s.pid ? { model: s.model, effort: s.effort } : null });
      // and the Gemini ones (running: here), with what agy's status line shows; key: a new one's tab finds its id by it
      for (const { made, going, lastAt, said, ...s } of gemSessions()) list.push({ ...s, where: s.pid ? (s.web === false ? 'pc' : 'web') : null, line: s.pid ? readLine(s.id) : null });
      // and the GPT 聊天 ones: no folder, no account, none running anywhere (busy: an answer pending at OpenAI)
      for (const c of oaiChats()) list.push({ id: c.id, title: c.title, at: c.at, cwd: '', acct: -1, gpt: true, oai: true, pid: null, busy: !!c.pending,
        prompt: c.msgs.findLast((m) => m.role === 'user')?.text.split('\n')[0].slice(0, 80) ?? '' });
      list.sort((a, b) => b.at - a.at);
      // the Macs (the Mac mini, more): 新对话 offers them
      const reg = load(), macs = macList(reg).map((m) => ({ id: m.id, label: m.label, dir: m.dir, host: m.host, icon: m.icon ?? null }));
      return { user: reg.user ?? null, usage: usageCache, gpt: gptState(), gemini: geminiAccounts(reg).map((g) => ({ label: g.label, on: g.id === reg.geminiOn, ...gemUsage(g) })), oai: fs.existsSync(OAI_KEY), quota: quotaOn(reg), macs, sessions: list, notes: unreadNotes([...all, ...gemSessions()]).map((n) => ({ ...n, by: noteBy(n) })), me: os.hostname(), butler: BUTLER, butlerOn: butlerOn(), butlerModel: butlerSet('model'), butlerEffort: butlerSet('effortLevel'), pc: pcNow(),
        tickets: ticketsNow([...all, ...gptSessions(), ...gemSessions()]), timeline: timeline(), waits: waitsNow(), projects: readProjects(), win: WIN,
        head, update: upd || updBusy || updErr ? { ...upd, busy: updBusy, err: updErr } : null };
    },
    'POST /api/project': (q, b) => editProjects((all) => projectOp(all, b)),
    'GET /api/dirs': (q) => dirsIn(q.get('path') ?? ''),
    // `/` in a conversation's box ({id}, or {dir, acct} for one not begun): what Claude Code lists there (slashList), by
    // account and folder, kept 10 min. A Mac's ({mac} one not begun): Claude Code's own commands only, as listed here (its
    // skills are the Mac's, and nothing is run there to ask)
    'GET /api/commands': async (q) => {
      if (q.get('gem')) { const l = await agySlash(); return { commands: l, note: l.length ? '' : '没读到 agy 的命令，可以直接打完整的命令' }; } // a Gemini one's: agy's own
      const s = q.get('id') ? sessions().find((x) => x.id === q.get('id')) : null, reg = load(), mac = s ? s.mac : q.get('mac');
      const got = (k, make) => { let c = slashCache.get(k); if (!c || Date.now() - c.at > 600000) { c = { at: Date.now(), list: make() }; slashCache.set(k, c); c.list.catch(() => slashCache.delete(k)); } return c.list; };
      const pc = (p, cwd) => got(`${p.configDir}|${path.resolve(cwd).toLowerCase()}`, () => slashList(claudeExe, p.configDir, cwd));
      if (s?.gpt) return { commands: [] };
      if (mac) { // the Mac's own list; that Mac not answering: Claude Code's own commands, as listed here, and why
        const m = macOf(mac, reg), at = s?.macCwd ?? m?.dir ?? '';
        try { // (one without its own config dir, the Mac mini: its default account, the owner's to keep to: not run there)
          if (!m) throw new Error('没有这台 Mac');
          if (!m.config) throw new Error(`${m.label} 用的是那台 Mac 默认的账号，不在上面跑 Claude Code`);
          return { commands: await got(`mac|${m.id}|${at}`, () => macSlash(m, at)) }; } catch (e) {
          const list = reg.profiles[0] ? await pc(reg.profiles[0], ROOT).catch(() => []) : [];
          return { commands: list.filter((x) => x.builtin), note: `没读到 Mac 上的命令和技能（${e.message}），这里只列内置命令；技能可以直接打完整的名字` };
        }
      }
      const p = reg.profiles[s ? s.acct : (Number(q.get('acct')) || 0) - 1], cwd = s ? s.cwd : q.get('dir') ?? '';
      if (!p || !isDir(cwd)) return { commands: [] };
      return { commands: await pc(p, cwd) };
    },
    // your name, for the page's avatar (its first character; none: the gear), kept in the registry
    'POST /api/me': (q, b) => {
      const name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
      update((r) => { if (name) r.user = name; else delete r.user; });
      return { user: name || null };
    },
    // the tickets (claude-multi ticket), and a change to one: from the 管家 (new, give, end) or its worker (report)
    'GET /api/tickets': () => ticketsNow(),
    'POST /api/ticket': (q, b) => editTickets((all) => ticketOp(all, b)),
    'GET /api/machines': () => machines(),
    'GET /api/tokens': async (q) => {
      if (!tokCache || q.has('fresh') || Date.now() - tokAt > 30000) // counted beside, one count at a time; the child failed: here, as before
        await (tokNow ??= tokensBeside().catch(() => ({ ...tokenStats(), butler: butlerCost() }))
          .then((t) => { tokCache = t; tokAt = Date.now(); }).finally(() => { tokNow = null; }));
      return tokCache;
    },
    'GET /api/push/key': () => ({ key: pushPublic(pushKeys().jwk) }),
    'POST /api/push/sub': (q, b) => { // a page's subscription, one per endpoint
      if (!/^https:\/\/[^/]+\//.test(b.endpoint ?? '') || !b.keys?.p256dh || !b.keys?.auth) throw new Error('通知订阅不完整');
      const s = pushKeys();
      s.subs = [...s.subs.filter((x) => x.endpoint !== b.endpoint), { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth }, at: Date.now() }];
      savePush(s);
      return { n: s.subs.length };
    },
    // the island, from the page's settings: off closes it (the web service it started at login runs on its own) and
    // clears its inbox; on starts it
    // off: the 管家 running here stops too (its record kept: switched on again, 接着聊 takes it up)
    'POST /api/butler': (q, b) => {
      if (b.on) { fs.writeFileSync(BUTLER_ON, ''); return { on: true }; }
      try { fs.unlinkSync(BUTLER_ON); } catch {}
      for (const t of terms.values()) if (t.kind === 'pty' && !t.gone && sameDir(t.cwd, BUTLER)) t.proc.kill();
      return { on: false };
    },
    'GET /api/island': () => ({ on: !islandOff() }),
    // 设置's 申请接入: the applications still out (an approved one is an account by then); opening it asks them once
    'GET /api/join': async () => { await joinRound().catch(() => {}); return joinsShown(); },
    'POST /api/join': (q, b) => joinApply(b),
    'POST /api/island': (q, b) => {
      if (b.on) { try { fs.unlinkSync(ISLAND_OFF); } catch {} island(); return { on: true }; }
      fs.writeFileSync(ISLAND_OFF, '');
      // the island's own process only: its pid file outlives it, and Windows hands the number on. The file goes too,
      // or a reused number would later keep 「打开」 from starting it (island() takes it for running)
      try {
        const pid = Number(fs.readFileSync(`${ISLAND}.pid`, 'utf8'));
        const cmd = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true }).stdout;
        if (/island\.ps1/i.test(cmd)) process.kill(pid);
      } catch {}
      fs.rmSync(`${ISLAND}.pid`, { force: true });
      try { for (const f of fs.readdirSync(INBOX)) fs.rmSync(path.join(INBOX, f), { force: true }); } catch {}
      return { on: false };
    },
    'POST /api/push/off': (q, b) => { const s = pushStore(); if (s) { s.subs = s.subs.filter((x) => x.endpoint !== b.endpoint); savePush(s); } return {}; },
    // the 管家 telling you something worth it, on the phone (Bark, or the pages' pushes), whatever page is in front
    'POST /api/tell': async (q, b) => {
      const text = String(b.text ?? '').trim();
      if (!text) throw new Error('要告诉用户什么？');
      const m = { title: '管家', body: text.slice(0, 500), group: '管家', id: sessions().find((x) => sameDir(x.cwd, BUTLER))?.id };
      await (barkUrl() ? bark(m) : pushAll(m));
      blog(`告诉了你：${text.length > 40 ? text.slice(0, 40) + '…' : text}`);
      return {};
    },
    'POST /api/push/test': async (q, b) => { // to the device asking (its endpoint), not every one
      const r = await pushAll({ title: 'Claude 多账号', body: '测试通知：这台设备的通知开好了。对话回复完、等你确认时，会这样提醒你。' }, b.endpoint);
      return { sent: r.filter((x) => x === 201).length, results: r };
    },
    // asked every second while shown, mostly from where the last answer ended. By the open terminal's key: one
    // started here has a record once Claude wrote the first message (its session file, named by its pid, says
    // which conversation it is), until then none.
    // a GPT conversation as the 管家's chat look asks: running here (its Codex is nowhere else), and at work
    'GET /api/gpt': (q) => { const s = gptSessions().find((x) => x.id === q.get('id')); return { pid: s?.pid ?? null, web: !!s?.web, busy: !!s?.busy }; },
    // a Gemini one as the 管家's chat look asks: running (here, or in a terminal window), at work, asking (its record)
    'GET /api/gem': (q) => { const s = gemSessions().find((x) => x.id === q.get('id')); return { pid: s?.pid ?? null, web: s?.web !== false, busy: !!s?.busy, wait: !!s?.wait }; },
    'GET /api/history': (q) => {
      const gt = terms.get(q.get('key') ?? '');
      if (gt?.gem || q.has('gem')) { // a Gemini one's: its record. Started here and not found yet (nothing said): nothing
        if (gt?.gem && !gt.gem.id) gemSessions();
        const id = gt?.gem ? gt.gem.id : q.get('id');
        if (!id) return { items: [], start: 0, end: 0 };
        const live = (!!gt?.gem && !gt.gone) || gemLive().some((x) => x.gem.id === id) || gemPc.has(id); // running (here, or in a terminal window): a reply mid-stream waits
        return { ...gemHistory(id, { from: q.get('from') || undefined, end: q.get('end') || undefined, live }), id };
      }
      const g = gt?.gpt;
      if (g || q.has('gpt')) { // a GPT one's: its thread's items. Started here and no thread yet: nothing
        if (g && !g.id) bindGpt();
        const id = g ? g.id : q.get('id'), home = g ? g.home : gptSessions().find((x) => x.id === id)?.home;
        if (g && !id) return { items: [], start: 0, end: 0 };
        if (!home) throw new Error('找不到这个对话');
        const live = !!g || gptLive().some((x) => x.gpt.id === id) || !!gptSessions().find((x) => x.id === id)?.pid; // running (here, or in a terminal): a reply mid-stream waits
        return { ...gptHistory(home, id, { from: q.get('from') || undefined, end: q.get('end') || undefined, live }), id };
      }
      const { t, file } = recordOf(q);
      // its terminal on a conversation with no record yet (a /clear typed there): id null, for the page to let the other go
      if (!file) { if (t) return { items: [], start: 0, end: 0, ...(t.file === null && { id: null }) }; throw new Error('找不到这个对话'); }
      // running, the newest piece: what waits in its queue too
      return { ...history(file, { from: q.get('from') || undefined, end: q.get('end') || undefined }), id: path.basename(file, '.jsonl'), ...(t?.pid && !t.gone && !q.get('end') && { queue: queueNow(file) }) };
    },
    'POST /api/read': (q, b) => { // {id} one conversation's notifications, {all: true} every one; the island drops them too
      const id = b.all ? '*' : /^[\w-]{1,80}$/.test(b.id ?? '') ? b.id : null;
      if (!id) throw new Error('缺少对话 id');
      markRead(id);
      if (!islandOff()) { // (off: nothing would ever take it out)
        fs.mkdirSync(INBOX, { recursive: true });
        const f = path.join(INBOX, `${Date.now()}-read`);
        fs.writeFileSync(`${f}.tmp`, JSON.stringify({ kind: 'read', id }));
        fs.renameSync(`${f}.tmp`, `${f}.json`);
      }
      return {};
    },
    'POST /api/warmup': () => new Promise((ok) => { // not spawnSync: the terminals keep streaming meanwhile
      require('child_process').execFile(process.execPath, [__filename, 'warmup'], { env: { ...process.env, NO_COLOR: '1' }, windowsHide: true },
        (e, stdout) => { usageAt = 0; ok({ out: String(stdout || e?.message || '').trim() }); }); // read again on the page's next look
    }),
    // 重命名 and 删除 from the page's list: the commands themselves, their checks and their words (a running one is
    // refused), run apart as warmup is: a deletion's PowerShell would hold up every terminal's stream meanwhile. One just
    // continued here isn't listed as running yet: refused here first. The list read afresh after.
    // 右键 a path of this PC on the page (shellCmd): opened on this PC's screen, where the service runs (your session)
    'POST /api/shell': (q, b) => {
      const p = String(b.path ?? ''), how = String(b.how ?? '');
      if (WIN ? !/^[A-Za-z]:[\\/]/.test(p) || netPath(p) : !path.isAbsolute(p)) throw new Error(`只能打开这台电脑上的文件（像 ${WIN ? 'D:\\…' : '/Users/…'} 这样的完整路径）`);
      const f = path.resolve(p);
      let st; try { st = fs.statSync(f); } catch { throw new Error(`没有这个文件：${p}`); }
      const dir = st.isDirectory();
      if (!WIN) { // a Mac's Finder: opened, else shown in its folder (-R). A program, script or app (one it can run) only shown, never run
        const runs = dir ? /\.app$/i.test(f) : RUNS.test(f) || MAC_RUNS.test(f) || !!(st.mode & 0o111);
        require('child_process').spawn('open', how === 'open' && !runs ? [f] : ['-R', f], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        return { said: how === 'open' && runs ? `${path.basename(f)} 是程序或脚本，没有运行它，在访达里选中了它` : '' };
      }
      const [exe, line] = shellCmd(f, how, dir);
      require('child_process').spawn(exe, [line], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).on('error', () => {}).unref();
      const env = frontOf(f, how, dir); // (its window to the front: logged, to see what Windows let it do)
      require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(FRONT_PS, 'utf16le').toString('base64')],
        { env: { ...process.env, ...env }, windowsHide: true, encoding: 'utf8', timeout: 30000 }, (e, out) => log('shell_front', { how, dir, front: String(out || e?.message || '').trim().slice(-80) }));
      return { said: !dir && how === 'open' && RUNS.test(f) ? `${path.basename(f)} 是程序或脚本，没有运行它，在资源管理器里选中了它` : '' };
    },
    'POST /api/rename': (q, b) => {
      const id = String(b.id ?? ''), name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (!name) throw new Error('名字不能是空的');
      if (b.oai) { const c = oaiRead(id); c.title = name; oaiSave(c); return { said: `已改名：${name}` }; }
      if (b.gem) { const r = gemRename(id, name, gemLive().some((x) => x.gem.id === id) || gemPc.has(id)); gemCache = null; return r; }
      if (b.gpt) throw new Error('GPT 对话暂时不能在这里改名');
      if (sessions().find((x) => x.id === id)?.mac) throw new Error('Mac 上的对话暂时不能在这里改名'); // its record there, not here
      return command('rename', id, name);
    },
    'POST /api/delete': async (q, b) => {
      if (b.gem) { // a Gemini one: not while its agy runs here, nor opened meanwhile (as a Claude one: held)
        const id = String(b.id ?? '');
        if (gemLive().some((x) => x.gem.id === id)) throw new Error('正在运行：先结束对话再删');
        const free = hold(id, 'change');
        try {
          await gemPcScan().catch(() => {}); // (as it is now: one just started in a terminal window too)
          if (gemPc.has(id)) throw new Error('它在电脑的终端窗口里运行：先在那里结束它再删');
          return await gemDelete(id, recycleA);
        } finally { free(); gemCache = null; }
      }
      if (!b.oai) return b.gpt ? archiveGpt(String(b.id ?? '')) : command('delete', String(b.id ?? ''));
      const c = oaiRead(String(b.id ?? '')); // a GPT 聊天 one: an answer on its way stopped (not paid for), then its files to the Recycle Bin
      if (c.pending) await oaiApi(`responses/${c.pending}/cancel`, {}).catch(() => {});
      const r = recycle([path.join(OAI, `${c.id}.json`), path.join(OAI, c.id)].filter((p) => fs.existsSync(p)));
      if (r.status !== 0) throw new Error(`删除失败：${(r.stderr || '').trim().split('\n')[0]}`);
      return { said: `已删除「${c.title}」，可以在回收站里找回。` };
    },
    // a GPT 聊天 one: its messages and the mode and effort it was last sent with (the page asks every 2 s while it's
    // shown); one sent; the answer on its way stopped
    'GET /api/oai': (q) => { const c = oaiRead(q.get('id')); return { items: oaiItems(c), busy: !!c.pending, since: c.since ?? null, title: c.title, opts: c.opts ?? OAI_OPTS }; },
    'POST /api/oai/send': (q, b) => oaiSend(b),
    'POST /api/oai/stop': (q, b) => oaiStop(String(b.id ?? '')),
    // open a conversation's terminal: {id, acct?} continues one (its window here if it runs in one),
    // {dir, acct} starts one. acct is 1-based; the page proposes it like the island does. One started (or starting) here
    // comes back with its Claude's pid, once the pseudo-terminal knows it (a moment): the 管家's chat new and say find
    // its Claude by that, not by its folder (two started in one folder at once got each other's)
    'POST /api/open': async (q, b) => {
      const opened = async (t) => {
        for (let k = 0; k < (t.mac ? 450 : 50) && !t.pid && !t.gone; k++) await sleep(100); // a Mac's: ssh first, tried again on a drop
        if (t.gone || !t.pid) throw new Error('终端尚未就绪或已结束，未取得 PID；请先确认启动状态再重试');
        return { key: t.key, kind: 'pty', pid: t.pid };
      };
      const reg = load(), cols = Math.max(40, Math.min(300, b.cols | 0 || 100)), rows = Math.max(10, Math.min(200, b.rows | 0 || 30));
      if (b.dir != null) b.dir = String(b.dir).trim().replace(/^"(.*)"$/, '$1'); // a typed path, maybe as Explorer's 复制为路径 quotes it
      if (b.gpt) { // a GPT one: {id} its Codex here, or continued here on its own account (a GPT one changes none); {dir, acct}
        if (!b.id) {
          if (!isDir(b.dir)) throw new Error('文件夹不存在');
          return { key: startGpt(Number(b.acct) || 1, b.dir, null, cols, rows).key, kind: 'pty' };
        }
        const t = gptLive().find((x) => x.gpt.id === b.id);
        if (t) return { key: t.key, kind: 'pty' };
        const s = gptSessions().find((x) => x.id === b.id);
        if (!s) throw new Error('找不到这个对话');
        if (s.pid && !s.web) { const t = mirror(s.pid); t.codex = true; return { key: t.key, kind: t.kind }; } // in a terminal window: shown from there, as a Claude is (not a second Codex on it)
        if (b.live) throw new Error('这个对话已经不在运行了');
        if (doing.get(s.id) === 'change') throw new Error('这个对话正在改名或删除，稍等一下');
        return { key: startGpt(s.acct + 1, s.cwd, s.id, cols, rows).key, kind: 'pty' };
      }
      if (b.gem) { // a Gemini one: {id} its agy here, or continued here (acct: on that account, else the one on); {dir, acct} a new one
        if (!b.id) {
          if (!isDir(b.dir)) throw new Error('文件夹不存在');
          return opened(await startGem(Number(b.acct) || 1, b.dir, null, cols, rows));
        }
        const t = gemLive().find((x) => x.gem.id === b.id), s = gemSessions().find((x) => x.id === b.id), cwd = t?.cwd ?? s?.cwd;
        if (!t && s?.pid && s.web === false) { // in a terminal window: shown from there, as a Claude is (not a second agy on it)
          if (b.swap) throw new Error('它在电脑的终端窗口里运行：在那里结束它，再换账号');
          const w = mirror(s.pid);
          return { key: w.key, kind: w.kind };
        }
        // {id, acct, swap}: 换账号继续. Its record is every account's: its agy here ended (an answer on its way cut short),
        // started again on that one; not while another runs (one account on at a time); that switch failing: back on its own
        if (t && b.swap) {
          const g = geminiAccounts()[Number(b.acct) - 1];
          if (!g) throw new Error('没有这个 Gemini 账号');
          if (gemLive().some((x) => x !== t)) throw new Error('还有别的 Gemini 对话在运行：同一时间只能一个 Gemini 账号在线，先结束它们再换');
          // any other agy (a terminal window's, the one that read the / menu): the switch would be refused once this one's ended
          const ps = g.id === load().geminiOn ? null : await execA('tasklist', ['/fi', 'imagename eq agy.exe', '/fo', 'csv', '/nh']);
          if (ps && (ps.status !== 0 || [...ps.stdout.matchAll(/^"agy\.exe","(\d+)"/gim)].some((m) => +m[1] !== t.pid)))
            throw new Error('电脑上还有别的 agy 在运行（终端窗口里的，或刚读过 / 命令的那个）：同一时间只能一个 Gemini 账号在线，等它们结束再换');
          const free = hold(b.id, 'swap'); // (not deleted meanwhile)
          try {
            require('child_process').execFile('taskkill', ['/pid', String(t.pid), '/t', '/f'], { windowsHide: true }, () => {});
            for (let k = 0; k < 50 && !t.gone; k++) await sleep(100);
            if (!t.gone) throw new Error('它的 agy 没能停下来，稍后再试');
            try { return await opened(await startGem(Number(b.acct), cwd, b.id, cols, rows)); } catch (e) {
              const back = geminiAccounts().findIndex((x) => x.id === load().geminiOn) + 1;
              let on = false;
              if (back) try { await startGem(back, cwd, b.id, cols, rows); on = true; } catch {}
              throw new Error(`没换成：${e.message}${on ? `（已在 A${back} 上接着开着）` : ''}`);
            }
          } finally { free(); }
        }
        if (t) return { key: t.key, kind: 'pty' };
        if (!s) throw new Error('找不到这个对话');
        if (b.live) throw new Error('这个对话已经不在运行了');
        if (doing.get(s.id) === 'change') throw new Error('这个对话正在改名或删除，稍等一下');
        return opened(await startGem(Number(b.acct) || s.acct + 1, s.cwd, s.id, cols, rows));
      }
      if (b.mac && !b.id) { // {mac: its id (true: the Mac mini), dir?}: one started on that Mac, for that folder here (its project folder there), or in the Mac's folder
        if (b.dir && !isDir(b.dir)) throw new Error('文件夹不存在');
        return opened(startMac(b.mac === true ? 'mac' : String(b.mac), b.dir ? { pc: path.resolve(b.dir) } : {}, cols, rows));
      }
      if (b.id) {
        sessCache = null;
        const s = sessions().find((x) => x.id === b.id);
        if (!s) throw new Error('找不到这个对话');
        // the Mac's: ours if it runs here; else joined in its tmux there (this service restarted meanwhile) or continued
        // (one in a terminal on the Mac is refused there: it can't be shown)
        if (s.mac) {
          const t = s.pid && where(s), r = resuming(s.id);
          if (t || r) return t ? { key: t.key, kind: t.kind } : opened(r);
          if (b.live && !s.pid) throw new Error('这个对话已经不在运行了');
          return opened(startMac(s.mac, { resume: s.id, cwd: s.macCwd }, cols, rows));
        }
        if (s.pid) { const t = where(s) ?? mirror(s.pid, reg.profiles[s.acct].configDir); t.file = s.file; return { key: t.key, kind: t.kind }; }
        const r = resuming(s.id);
        if (r) return opened(r);
        if (b.live) throw new Error('这个对话已经不在运行了'); // the page reconnecting: an ended one isn't started anew
        if (doing.get(s.id) === 'change') throw new Error('这个对话正在改名或删除，稍等一下');
        if (sameDir(s.cwd, BUTLER) && !butlerOn()) throw new Error(BUTLER_SHUT);
        const p = reg.profiles[b.acct - 1] ?? reg.profiles[s.acct];
        copyTo(s, p); sessCache = null; // listed a moment ago at the old copy, gone now
        return opened(startPty(p, s.cwd, ['--resume', s.id], cols, rows));
      }
      if (b.dir && sameDir(b.dir, BUTLER) && !butlerOn()) throw new Error(BUTLER_SHUT);
      const p = reg.profiles[b.acct - 1];
      if (!p) throw new Error('没有这个账号');
      if (!isDir(b.dir)) throw new Error('文件夹不存在');
      // the 管家 is one: two screens starting it at once (it isn't listed before its first message) get the same
      const one = sameDir(b.dir, BUTLER) && [...terms.values()].find((t) => t.kind === 'pty' && !t.gone && sameDir(t.cwd, BUTLER));
      if (one) return opened(one);
      if (sameDir(b.dir, BUTLER)) shareTrust(p.configDir, undefined, [BUTLER.replace(/\\/g, '/')]); // on any account, no trust question
      sessCache = null;
      return opened(startPty(p, b.dir, [], cols, rows));
    },
    // 换账号继续 {id, acct, now}: the conversation goes on with account acct (nothing sent: it waits for you).
    // Not running: started here like a continued one. Running here: ended once its answer is over (now: at once; at a
    // usage limit: at once), started again on acct, and its pages moved to it (event switched). In a window: switchWindow.
    // Answers at once; the switch itself happens when it can.
    'POST /api/switch': (q, b) => {
      sessCache = null;
      const reg = load(), s = sessions().find((x) => x.id === b.id), p = reg.profiles[b.acct - 1];
      if (!s) throw new Error('找不到这个对话');
      if (s.mac) throw new Error('Mac 上的对话用的是 Mac 自己的账号，换不了');
      if (!p) throw new Error('没有这个账号');
      const args = ['--resume', s.id];
      if (!s.pid && resuming(s.id)) throw new Error('这个对话还在启动，等它起来再换'); // a second Claude on the record, or the page told it switched
      const free = hold(s.id, 'switch');
      let later = null; // a switch still to happen: held till it has
      try {
        if (!s.pid) { copyTo(s, p); sessCache = null; return { key: startPty(p, s.cwd, args, b.cols | 0 || 100, b.rows | 0 || 30).key, kind: 'pty' }; }
        const t = where(s);
        if (t?.kind !== 'pty') { later = switchWindow(s, b.acct, !!b.now).catch((e) => t && send(t, 'swapfail', { err: `没换成：${e.message}` })); return { window: true }; }
        later = (async () => {
          await untilFree(t.dir, t.pid, b.now || atLimit(reg.profiles[s.acct]));
          if (t.gone || t.switching) return; // a second request (the island and the page both): one new Claude, not two
          // removed while it answered: not started there (its folder gone, no login), the old one left running
          if (!load().profiles.some((x) => x.id === p.id)) throw new Error('要换去的账号已经移除了');
          t.switching = true;
          t.proc.kill();
          while (!t.gone) await sleep(100); // it has stopped writing its record: the copy is whole
          copyTo(s, p); sessCache = null;
          send(t, 'switched', { key: startPty(p, s.cwd, args, t.w, t.h).key });
        })().catch((e) => send(t, 'swapfail', { err: `没换成：${e.message}` })); // its pages stop waiting
        return { pty: true };
      } finally { if (later) later.finally(free); else free(); }
    },
    'POST /api/input': async (q, b) => {
      const t = terms.get(b.key);
      if (!t || t.gone) throw new Error('这个终端已经结束');
      // the 管家 (chat say, pick) doesn't type where you typed words in the last 2 minutes: yours and its would mix.
      // Keys a page sends by itself (focus reports, arrows, Enter) aren't words.
      if (b.by === 'butler') { if (Date.now() - (t.typed ?? 0) < 120000) throw new Error('用户两分钟内在这个对话里打过字，先别发，过一会儿再试'); }
      else if (/[^\x00-\x1f\x7f]/.test(String(b.data).replace(/\x1b(\[[0-9;?]*[A-Za-z~]|O.)/g, ''))) t.typed = Date.now();
      if (t.gem && !t.gem.id && String(b.data).includes('\r')) t.gem.enters = [...t.gem.enters.slice(-20), Date.now()];
      if (t.gem && b.data === '\x1b') setTimeout(() => gemPcScan().catch(() => {}), 800); // Esc: a turn it cut short, in its log by then

      const write = (d) => t.kind === 'pty' ? t.proc.write(d)
        : new Promise((resolve, reject) => t.proc.stdin.write(JSON.stringify({ k: d }) + '\n', (e) => e ? reject(e) : resolve()));
      if (!t.gpt && !t.codex) { await write(String(b.data)); return {}; }
      // a Codex: in turn, an Enter alone waits until 600 ms after the last words (sooner, it's a new line in them). Answered
      // once written: one that didn't get there (its Codex gone meanwhile) says so, for the page to put the message back
      // (one failing doesn't stop the next in the queue)
      const { data, words } = codexKeys(b.data);
      await (t.q = (t.q ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (data === '\r') { const w = (t.wordsAt ?? 0) + 600 - Date.now(); if (w > 0) await sleep(w); }
        if (t.gone) throw new Error('这个终端已经结束');
        await write(data);
        if (words) t.wordsAt = Date.now();
      }));
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
      // the notifications' helper and the home screen's manifest, to anyone too: the browser fetches them on its own
      const own = { '/sw.js': [PUSH_SW, 'text/javascript; charset=utf-8'], '/manifest.json': [MANIFEST, 'application/manifest+json; charset=utf-8'] }[url.pathname];
      if (req.method === 'GET' && own) return out(200, own[0], own[1]);
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('key')) { // the link: kept as a cookie, a year
        if (!keyMatch(url.searchParams.get('key'), webKey())) return out(403, '这个链接的钥匙不对，或者已经换了新的。在电脑上运行 claude-multi web-link 拿新链接。', text);
        res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'set-cookie': `cm=${webKey()}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` });
        return res.end();
      }
      if (!keyMatch(keyCookie(req.headers.cookie), webKey())) return out(403, '要用链接打开：在电脑上运行 claude-multi web-link。', text);
      if (req.method === 'GET' && url.pathname === '/') return out(200, fs.readFileSync(path.join(ROOT, 'web.html'), 'utf8'), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/screen.js') return out(200, fs.readFileSync(path.join(ROOT, 'screen.js'), 'utf8'), 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/ext.js') return out(200, ext?.page?.() ?? '', 'text/javascript; charset=utf-8'); // none: empty
      // the terminal's files, KaTeX's (the math in messages, its fonts too) and highlight.js's (code's colors in 预览), from
      // our node_modules: from the CDN abroad they took 7-8 s, and the page waits for them. Kept a year: the page asks with
      // the version, ?6.0.0, so a new one is a new address.
      const lib = /^\/lib\/((?:@xterm\/[\w-]+\/(?:lib|css)|katex\/dist(?:\/fonts)?|@highlightjs\/cdn-assets(?:\/languages)?)\/[\w.-]+\.(js|css|woff2))$/.exec(url.pathname);
      if (req.method === 'GET' && lib) {
        const type = { css: 'text/css', js: 'text/javascript', woff2: 'font/woff2' }[lib[2]];
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
        // a named event: the page sees it and knows the stream lives. The key asked again each time: a stream opened with
        // one since replaced (web-link new) is cut (the key is only asked as a request comes in, and this one stays open)
        const beat = setInterval(() => { if (!keyMatch(keyCookie(req.headers.cookie), webKey())) return res.destroy(); sse.write('event: ping\ndata: {}\n\n'); }, 15000);
        req.on('close', () => {
          closed = true; clearInterval(beat); t.clients.delete(sse); z?.destroy();
          // nobody watching: the reader stays 20 min, still keeping what scrolls by, for when you come back
          if (t.kind === 'pc') setTimeout(() => { if (!t.clients.size) t.proc.kill(); }, 1200000);
          if (t.gem) gemIdle(t);
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
      // a picture in a GPT 聊天 one (?ref "message.k" from its items): only one that chat holds
      if (req.method === 'GET' && url.pathname === '/api/oai/file') {
        const [i, k] = (url.searchParams.get('ref') ?? '').split('.'), p = oaiRead(url.searchParams.get('id')).msgs[i]?.files?.[k];
        if (!p || !oaiPic(p) || !fs.existsSync(p)) return out(404, { err: '没有这张图片' });
        res.writeHead(200, { 'content-type': OAI_TYPES[path.extname(p).slice(1).toLowerCase()], 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
        return res.end(fs.readFileSync(p));
      }
      // 预览: a file or folder of this PC named in a reply (?path as Claude wrote it): a folder's folders and files; a file as
      // peekHead says, a part of it when asked (Range: a video's seek), text its first 2 MB; an Office one as its PDF
      // (?warm: only made, for when it's opened, a folder's Office ones too; a file's type said, for the page to know one
      // it can't show)
      if (req.method === 'GET' && (url.pathname === '/api/peek' || url.pathname.startsWith('/api/peek/'))) { // (/api/peek/<name>: its name for the PDF viewer's title)
        const p = url.searchParams.get('path') ?? '';
        if (WIN ? !/^[A-Za-z]:[\\/]/.test(p) : !path.isAbsolute(p)) return out(400, `只能预览这台电脑上的文件（像 ${WIN ? 'D:\\…' : '/Users/…'} 这样的完整路径）`, text);
        let st; try { st = await fs.promises.stat(p); } catch { return out(404, `没有这个文件：${p}`, text); }
        // an Office one as its PDF: made by Office on Windows; a Mac's as the file itself
        const raw = url.searchParams.has('raw'), office = WIN && !raw && !!OFFICE_KIND[path.extname(p).slice(1).toLowerCase()], warm = url.searchParams.has('warm'); // raw: the file itself, downloaded
        if (st.isDirectory()) { // listed: its Office files' PDFs made meanwhile (20 at most), for when one's opened
          const ls = await dirsIn(p);
          if (warm) for (const f of ls.files.filter((n) => OFFICE_KIND[path.extname(n).slice(1).toLowerCase()]).slice(0, 20)) peekPdf(path.join(ls.path, f)).catch(() => {});
          return out(200, warm ? {} : ls);
        }
        if (warm) { if (office) peekPdf(p).catch(() => {}); return out(200, { type: peekHead(p, office)['content-type'] }); } // what it'll be
        let file = p;
        if (office) try { file = await peekPdf(p, { first: true }); } catch (e) { return out(500, e.message, text); }
        const head = raw ? { ...peekHead(path.basename(p)), 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}` }
          : peekHead(path.basename(p), office), size = office ? fs.statSync(file).size : st.size, plain = head['content-type'].startsWith('text/');
        const range = !plain && size && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        let start = 0, end = (plain ? Math.min(size, 2 << 20) : size) - 1;
        if (range && (range[1] || range[2])) {
          start = range[1] ? +range[1] : Math.max(0, size - +range[2]);
          end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
          if (start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
          res.writeHead(206, { ...head, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
        } else res.writeHead(200, { ...head, 'accept-ranges': plain ? 'none' : 'bytes', 'content-length': Math.max(0, end - start + 1) });
        if (end < start) return res.end();
        const r = fs.createReadStream(file, { start, end });
        r.on('error', () => res.destroy()); req.on('close', () => r.destroy());
        return r.pipe(res);
      }
      // a file sent in a conversation (附件：… in a message of yours), for the page's card of it to open
      if (req.method === 'GET' && url.pathname === '/api/file') {
        const f = fileServed(url.searchParams.get('n'));
        if (!f || !fs.existsSync(f.file)) return out(404, '这个附件已经不在了：发过的文件只留 7 天', text);
        res.writeHead(200, f.headers);
        return res.end(fs.readFileSync(f.file));
      }
      // only from our own page: from the same origin, as JSON or a picture's own type (another site's page can't send
      // either cross-origin without asking first, and nothing here answers that)
      if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return out(403, { err: '来源不对' });
      // a picture's bytes, or a file's (application/octet-stream, its name in x-name: neither type can come cross-origin
      // without asking first): saved, its path back for the page to paste
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        const ct = req.headers['content-type'], ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[ct];
        let name = null;
        if (ct === 'application/octet-stream') try { name = decodeURIComponent(req.headers['x-name'] ?? '') || 'file'; } catch { name = 'file'; }
        if (!ext && !name) return out(415, { err: '只能发图片或文件' });
        const parts = []; let size = 0;
        for await (const ch of req) { if ((size += ch.length) > 20 << 20) return out(413, { err: `${name ? '文件' : '图片'}太大了（最大 20 MB）` }); parts.push(ch); }
        const saved = saveUpload(Buffer.concat(parts), ext, UPLOADS, name);
        const xm = req.headers['x-mac']; // x-mac: for a conversation on a Mac, its id ('1': the Mac mini, as the page said it before)
        return out(200, { path: xm ? await macPut(saved, macOf(xm === '1' ? 'mac' : xm, load())) : saved });
      }
      const fn = api[`${req.method} ${url.pathname}`];
      if (!fn) return out(404, { err: '没有这个地址' });
      let body = {};
      if (req.method === 'POST') {
        if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return out(415, { err: '只收 JSON' });
        body = await jsonBody(req);
        if (body === undefined) return out(413, { err: '太大' });
      }
      out(200, await fn(url.searchParams, body));
    } catch (e) { out(500, { err: e.message }); }
  });
  server.keepAliveTimeout = 5000; // the relay's nginx lets its idle ones go at 4 s, before: it never reuses one closing here
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') process.exit(0); throw e; }); // already running
  // The last guard: a throw nothing caught (a timer's, a handler's: a write on a full disk, a file unreadable a moment) is
  // logged, the same one once in 10 minutes, and the service goes on: ended, it took every conversation running here with
  // it, and nothing starts it again. Before it listens (the port refused, say) it ends, as before.
  const fell = new Map();
  const keepOn = (e) => {
    if (!server.listening) { console.error(e); process.exit(1); }
    const k = String(e?.stack ?? e).split('\n').slice(0, 2).join(' ').slice(0, 300);
    if (Date.now() - (fell.get(k) ?? 0) < 600000) return;
    fell.set(k, Date.now());
    try { log('web_error', { err: k }); } catch {} // the log itself on the full disk
  };
  process.on('uncaughtException', keepOn).on('unhandledRejection', keepOn);
  // A restart ended the conversations running here (as the last service last wrote, read before this one writes), and
  // the 管家's reminders with it (chat wait --until, still ahead, its process gone)
  const ranBefore = (() => { try { return JSON.parse(fs.readFileSync(WEB_RUN, 'utf8')); } catch { return []; } })();
  const lost = (() => { try { return fs.readdirSync(WAITS); } catch { return []; } })()
    .flatMap((n) => { try { return [JSON.parse(fs.readFileSync(path.join(WAITS, n), 'utf8'))]; } catch { return []; } })
    .filter((w) => w.until > Date.now() && !alive(w.pid));
  setInterval(saveRun, 10000);
  // a [系统通知] typed into the 管家's terminal as you'd paste it, then Enter (only once it's idle: typed while it waits on
  // a question, it would answer it)
  const tellIn = async (t, text) => { t.proc.write(`\x1b[200~${text}\x1b[201~`); await sleep(400); t.proc.write('\r'); };
  const ptyStatus = (t) => { try { return JSON.parse(fs.readFileSync(path.join(t.dir, 'sessions', `${t.pid}.json`), 'utf8')).status; } catch { return null; } };
  // what's waiting to be told: the tickets that moved, given once it's idle (and you aren't typing there), each as it
  // stands then (one back at work by then left out). Taken only if it got to work within 20 s; else (a menu was up, it
  // was starting) told again the next round, twice at most.
  // replies: conversation id → the answer to what it asked outside a ticket {title, kind, text}
  const toTell = new Set(), replies = new Map(), tries = new Map(); // tries: ticket id, or c:<conversation id> → notices that didn't get through
  let telling = false;
  setInterval(async () => {
    const t = (toTell.size || replies.size) && !telling && [...terms.values()].find((x) => x.kind === 'pty' && !x.gone && x.pid && sameDir(x.cwd, BUTLER));
    if (!t || Date.now() - (t.typed ?? 0) < 10000 || ptyStatus(t) !== 'idle') return; // not running: kept till it is
    const ids = [...toTell], list = [...sessions(), ...gptSessions(), ...gemSessions()], rs = [...replies];
    toTell.clear(); replies.clear();
    const { items, keep } = tellSplit(ids, readTickets(), list);
    keep.forEach((i) => toTell.add(i));
    if (!items.length && !rs.length) return;
    const keys = [...items.map((o) => o.t.id), ...rs.map(([id]) => `c:${id}`)];
    telling = true;
    try {
      await tellIn(t, butlerNotice(items, rs.map(([, r]) => r)));
      for (let k = 0; k < 10; k++) { await sleep(2000); if (['busy', 'shell'].includes(ptyStatus(t))) { keys.forEach((i) => tries.delete(i)); return log('butler_told', { n: keys.length }); } }
      const again = tellAgain(tries, keys);
      for (const i of again) if (typeof i === 'number') toTell.add(i); else replies.set(i.slice(2), rs.find(([id]) => `c:${id}` === i)[1]);
      log('butler_tell_missed', { n: keys.length, again: again.length });
    } finally { telling = false; }
  }, 3000);
  // After a restart each one that ran here is continued on its account, back idle (one cut mid-answer isn't told to go
  // on: the 管家 is, for those it watches). The 管家 also (switched on) when it has tickets open; then told to look at them all again,
  // and to set again the reminders that ended. (A Claude ended with its terminal takes its session file.)
  async function wakeUp() {
    const all = sessions(), reg = load(), me = all.find((x) => sameDir(x.cwd, BUTLER));
    for (const id of ranBefore) {
      // a Mac's still running in its tmux there is joined again (startMac finds it)
      const s = all.find((x) => x.id === id), p = s && s !== me && (s.mac || (!s.pid && reg.profiles[s.acct]));
      if (p) try { if (s.mac) startMac(s.mac, { resume: s.id, cwd: s.macCwd }); else startPty(p, s.cwd, ['--resume', s.id]); log('web_resumed', { session_id: s.id }); } catch (e) { log('web_resume_fail', { session_id: s.id, err: e.message }); }
    }
    // a Gemini one (gem:<id>): on the account on (its record is every account's: nothing to switch)
    const on = geminiAccounts(reg).findIndex((g) => g.id === reg.geminiOn) + 1, gl = ranBefore.some((x) => String(x).startsWith('gem:')) ? listGemini(reg) : [];
    if (gl.length) await gemPcScan().catch(() => {}); // one opened in a terminal window meanwhile: not a second agy on it
    for (const x of ranBefore.filter((y) => String(y).startsWith('gem:'))) {
      const s = gl.find((g) => g.id === x.slice(4));
      if (s && on && !gemPc.has(s.id)) try { await startGem(on, s.cwd, s.id); log('web_resumed', { session_id: s.id, gem: true }); } catch (e) { log('web_resume_fail', { session_id: s.id, gem: true, err: e.message }); }
    }
    const open = readTickets().some((x) => !x.end), p = butlerOn() && me && !me.pid && (ranBefore.includes(me.id) || open) && reg.profiles[me.acct];
    if (!p) return;
    const t = startPty(p, me.cwd, ['--resume', me.id]);
    if (!open && !lost.length) return log('butler_woken', { session_id: me.id }); // nothing it was watching: back, waiting for you
    const hm = (ms) => new Date(ms).toTimeString().slice(0, 5);
    const again = lost.length ? `你设的这些定时提醒也断了，还要的就重新设：${lost.map((w) => `${hm(w.until)} ${w.note || w.title || ''}`.trim()).join('；')}。` : '';
    for (let k = 0; k < 60 && !t.gone; k++, await sleep(1000)) {
      if (ptyStatus(t) !== 'idle') continue;
      await tellIn(t, `[系统通知] 网页服务刚重启。用 claude-multi ticket 看一遍工单，按规矩处理（重启时正在回复的对话被切断了，现在是停下的）。${again}`);
      return log('butler_woken', { session_id: me.id, reminders: lost.length });
    }
  }
  server.listen(WEB_PORT, '127.0.0.1', () => { saveTerms(); tunnel(); macWatch(); setTimeout(() => wakeUp().catch((e) => log('wake_fail', { err: e.message })), 3000); console.log(`网页：${WEB_URL}/  （第一次用 claude-multi web-link 给的链接打开）`); });
  // the way in from outside, kept up: dialed again 5 s after a drop, waiting longer (up to a minute) while each try
  // fails at once (the server or the network down). A connection the network swallowed (a proxy's TUN switched on or
  // off moves it to another interface) is found dead within 15 s, by either side. On the server its end is a socket
  // file, not a port: the next tunnel replaces it at once (StreamLocalBindUnlink), where a port stayed taken until the
  // server gave up on the dead one, and every try in between failed.
  let tun = null, wait = 5000;
  process.on('exit', () => tun?.kill());
  function tunnel() {
    if (!TUNNEL) return; // no tunnel.json: this computer only
    // the first: a tunnel left by a service killed hard (its 'exit' never ran, nor tun.kill()) ended, or it stays up
    // for good, with a session on the server. Only this service gets here: a second one quits on the port in use.
    if (!tun) spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | `
      + `? { $_.CommandLine -like '*-R ${TUNNEL.sock}:*' } | % { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true, timeout: 4000 });
    const at = Date.now();
    // a session (-tt, a command that never ends) and not -N: only a session makes both ends send small packets at once
    // (TCP_NODELAY); with -N each new connection through took ~150 ms, not ~50. The tty: the command dies with the link.
    tun = require('child_process').spawn('ssh', ['-tt', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=5',
      '-o', 'ServerAliveCountMax=3', '-R', `${TUNNEL.sock}:127.0.0.1:${WEB_PORT}`, TUNNEL.ssh, 'sleep infinity'], { windowsHide: true, stdio: 'ignore' });
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
    .map((p) => ({ id: p.id, label: p.label, dir: path.join(p.configDir, 'projects') }))
    // each Mac's records, as copied here; and what its other folders cost (others\: their replies' usage only), an amount
    // beside its own (those last: tokenStats takes them out of the rows)
    .concat(macList(reg).map((m) => ({ id: m.id, label: m.label, dir: path.join(macHome(m), 'projects'), mac: m.id, icon: m.icon ?? null })),
      // each Gemini account (gem: its A number): all of theirs in agy's one folder of records (brain), told apart in tokenStats
      geminiAccounts(reg).map((g, i) => ({ id: g.id, label: g.label, gem: i + 1, brain: path.join(GEMINI_HOME, 'antigravity-cli', 'brain') })),
      // each GPT account (gpt: its G number; a removed one's after them, as a removed Claude account's): its Codex's
      // records, the archived ones too (删除 archives one)
      [...gptAccounts(reg), ...(reg.removedGpt ?? []).map((g) => ({ ...g, label: `${g.label}（已移除）` }))]
        .map((g, i) => ({ id: g.id, label: g.label, gpt: i + 1, dir: path.join(g.home, 'sessions'), arch: path.join(g.home, 'archived_sessions') })),
      macList(reg).map((m) => ({ id: `${m.id}-other`, of: m.id, label: '', dir: path.join(macHome(m), 'others'), other: true })));
}
// What the tokens would cost on the API: $ per million [input, output, cache read]; cache writes are 1.25x
// input (5 min) or 2x (1 h), fast mode doubles it all. The longest matching name wins (opus-5 vs opus-5-5); a gateway's
// name for it (本地代理's claude/claude-opus-5-5) by what follows its provider/.
// ponytail: copied by hand from Anthropic's price list (2026-06; Fable 5.2 from Claude Code 2.1.321's notes); a model not
// listed is priced as Opus 5.5, so add a row when a new one shows up
// Gemini's (agy names one with its effort after it: gemini-4-neon-high): Google's Standard paid tier, AI Studio's price
// page as of 2026-11-21 (output includes thinking). A price that changes on a day: the day, then the new three (a reply
// priced by its own day)
const PRICES = { 'claude-fable-5-2': [8, 40, 0.2], 'claude-fable-5-1': [10, 50, 0.25], 'claude-fable-5': [10, 50, 1], 'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5], 'claude-opus-4': [5, 25, 0.5], 'claude-sonnet-5': [2, 10, 0.2], 'claude-sonnet-4': [3, 15, 0.3],
  'claude-haiku-4': [1, 5, 0.1], '<synthetic>': [0, 0, 0],
  'gemini-4-neon': [3, 15, 0.15], 'gemini-4-hydrogen': [1.5, 7.5, 0.075], 'gemini-4-argon': [2, 10, 0.1, '2026-12-01', 4, 20, 0.2],
  'gemini-4-carbon': [2, 10, 0.1, '2026-12-01', 4, 20, 0.2], 'gemini-3.8-flash': [0.75, 3.75, 0.075, '2027-01-01', 1.5, 7.5, 0.15],
  // GPT's (Codex's): OpenAI's Standard tier, developers.openai.com/api/docs/pricing as of 2026-11-21 (output includes
  // reasoning); Fast (Codex's service_tier priority) is 2x, as fast is here. shortcut: short context only (≤272K input;
  // Codex's window is 258K): a long-context row once a model's window passes it
  'gpt-6.2-astra': [8, 40, 0.4], 'gpt-6-astra': [10, 50, 1], 'gpt-6.2-sol': [2, 10, 0.1], 'gpt-6.1-sol': [2, 10, 0.1],
  'gpt-6.1-terra': [1, 5, 0.05], 'gpt-6-sol': [2, 10, 0.2], 'gpt-6-luna': [0.1, 0.5, 0.01] };
function replyCost([, day, i, o, w5, w1, r, model, fast]) {
  const name = (model ?? '').replace(/^[\w.-]+\//, ''), k = Object.keys(PRICES).filter((p) => name.startsWith(p)).sort((a, b) => b.length - a.length)[0];
  const p = PRICES[k ?? 'claude-opus-5-5'], [pi, po, pr] = p[3] && String(day) >= p[3] ? p.slice(4) : p;
  return ((i + w5 * 1.25 + w1 * 2) * pi + o * po + r * pr) / 1e6 * (fast ? 2 : 1);
}
// The page's usage (as GET /api/tokens gives it) counted in a child node: reading the records takes ~0.3 s, and in the web
// service the whole service, every terminal with it, stood still meanwhile.
const tokensBeside = () => new Promise((ok, no) => require('child_process').execFile(process.execPath,
  ['-e', `const m = require(${JSON.stringify(__filename)}); process.stdout.write(JSON.stringify({ ...m.tokenStats(), butler: m.butlerCost() }))`],
  { windowsHide: true, maxBuffer: 256 << 20 }, (e, out) => { try { if (e) throw e; ok(JSON.parse(out)); } catch (x) { no(x); } }));
function tokenStats(roots = tokenRoots(), cacheFile = path.join(ROOT, 'tokens-cache.json'), logFile = LOG) {
  let cache = { v: 4, files: {} }, dirty = false; // dirty: something read further, or dropped: the cache is written
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') try { fs.copyFileSync(cacheFile, `${cacheFile}.bad`); } catch {} // unreadable: keep it for a hand rescue
  }
  // replies now carry their time (who made one goes by it), then the advisor's calls (v4): the records read again;
  // deleted ones keep theirs, without
  if (cache.v !== 4) dirty = true, cache = { v: 4, files: Object.fromEntries(Object.entries(cache.files ?? {}).filter(([f]) => !fs.existsSync(f))) };
  const num = (s, k) => +(s.match(new RegExp(`"${k}":(\\d+)`))?.[1] ?? 0);
  const day = (t) => ymd(new Date(t));
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
  const gemOnAt = []; // [[ms, profile id]]: a Gemini account on from then (registered, switched to, signed in again), oldest first
  try {
    for (const l of fs.readFileSync(logFile, 'utf8').split('\n')) {
      if (/"event":"gemini_(on|registered|relogin)"/.test(l)) { const j = JSON.parse(l); gemOnAt.push([Date.parse(j.timestamp), j.profile_id]); continue; }
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
    for (const f of r.arch ? walk(r.arch, walk(r.dir)) : walk(r.dir)) {
      let st; try { st = fs.statSync(f); } catch { continue; } // gone since the walk (Claude's cleanup, a delete): its cached replies stay, below
      const size = st.size;
      let c = cache.files[f] ?? { size: 0, recs: [] };
      const was = cache.files[f] && `${c.size} ${c.born}`;
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
            // a GPT one's (Codex's record): a response's usage (input with its cached part in it), under the model its turn
            // named and Standard or Fast as its settings said (kept with the file: read on from where it was)
            if (r.gpt) {
              if (!/"(turn_context|thread_settings_applied|token_usage_record)"/.test(l)) continue;
              let j; try { j = JSON.parse(l); } catch { continue; }
              if (j.type === 'turn_context') c.m = j.payload?.model;
              else if (j.payload?.type === 'thread_settings_applied') c.f = +/priority|fast/.test(j.payload.thread_settings?.service_tier ?? '');
              else if (j.type === 'token_usage_record' && j.payload?.usage && j.payload.response_id) {
                const u = j.payload.usage, rd = u.cached_input_tokens ?? 0, w = u.cache_write_input_tokens ?? 0, ts = Date.parse(j.timestamp);
                const y = [`gpt:${j.payload.response_id}`, day(ts), Math.max(0, (u.input_tokens ?? 0) - rd - w), u.output_tokens ?? 0, w, 0, rd, c.m ?? '', c.f ?? 0, ts];
                const i = at.get(y[0]);
                if (i === undefined) { at.set(y[0], c.recs.length); c.recs.push(y); } else c.recs[i] = y;
              }
              continue;
            }
            if (!l.includes('"type":"assistant"') || !l.includes('"usage":')) continue;
            const id = l.match(/"id":"(msg_[^"]+)"/)?.[1], ts = l.match(/"timestamp":"([^"]+)"/)?.[1];
            if (!id || !ts) continue;
            const u = l.slice(l.indexOf('"usage":')), w = num(u, 'cache_creation_input_tokens'), w1 = Math.min(w, num(u, 'ephemeral_1h_input_tokens'));
            const x = [`${id}:${l.match(/"requestId":"([^"]+)"/)?.[1] ?? ''}`, day(ts), num(u, 'input_tokens'), num(u, 'output_tokens'),
              w - w1, w1, num(u, 'cache_read_input_tokens'), l.match(/"model":"([^"]+)"/)?.[1] ?? '', +/"speed":"fast"/.test(u), Date.parse(ts)];
            // the advisor's calls (Fable, at its price) ride in the reply's usage.iterations, apart from its own tokens
            const its = u.includes('"advisor_message"') ? (() => { try { return JSON.parse(l).message.usage.iterations ?? []; } catch { return []; } })() : [];
            const xs = [x, ...its.filter((t) => t.type !== 'message' && t.model).map((t, k) => [`${x[0]}:${k}`, x[1], t.input_tokens ?? 0, t.output_tokens ?? 0,
              t.cache_creation?.ephemeral_5m_input_tokens ?? 0, t.cache_creation?.ephemeral_1h_input_tokens ?? 0, t.cache_read_input_tokens ?? 0, t.model, 0, x[9]])];
            // kept as fresh strings: a match is a slice holding its whole 32 MB piece alive (V8), and a first read of
            // every record (no cache yet, or a new version) ran out of memory with them
            for (const y of xs.map((z) => JSON.parse(JSON.stringify(z)))) {
              const i = at.get(y[0]);
              if (i === undefined) { at.set(y[0], c.recs.length); c.recs.push(y); } else if (sum(y) > sum(c.recs[i])) c.recs[i] = y;
            }
          }
          c.size += end;
        }
        fs.closeSync(fd);
      }
      next[f] = c;
      if (`${c.size} ${c.born}` !== was) dirty = true;
      count(c, ri, sidOf(ri, f));
    }
  });
  // The Gemini ones (agy's records, every account's in one folder): a model step's usage (input not cached, output with
  // its thinking, cache reads), each the account's that was on when it was made (before any switch logged, or one
  // removed since: the first's). A step once, by its index and time (a /rewind writes over an index: both counted).
  // shortcut: a record read whole the first time (agy's are a few MB at most); read in pieces as Claude's if one grows to hundreds
  const gems = roots.map((r, ri) => [r, ri]).filter(([r]) => r.gem);
  const gemCount = (c) => { for (const x of c.recs) { let id = null; for (const [t, p] of gemOnAt) if (t <= x[9]) id = p; best.set(x[0], { x, ri: (gems.find(([r]) => r.id === id) ?? gems[0])[1], born: 0, rank: 0 }); } };
  if (gems.length) {
    let ids = []; try { ids = fs.readdirSync(gems[0][0].brain); } catch {}
    for (const id of ids) {
      const f = path.join(gems[0][0].brain, id, '.system_generated', 'logs', 'transcript.jsonl');
      let size; try { size = fs.statSync(f).size; } catch { continue; }
      const c = cache.files[f] ?? { size: 0, recs: [], gem: true }, was = c.size;
      if (size < c.size) c.size = 0; // written anew (a /rewind): read again, what was counted stays
      if (size > c.size) try {
        const fd = fs.openSync(f, 'r'), buf = Buffer.alloc(size - c.size);
        try { fs.readSync(fd, buf, 0, buf.length, c.size); } finally { fs.closeSync(fd); }
        const end = buf.lastIndexOf(10) + 1, at = new Map(c.recs.map((x, i) => [x[0], i])); // (a line still being written: next time)
        for (const l of buf.toString('utf8', 0, end).split('\n')) {
          if (!l.includes('"output_tokens"')) continue;
          let s; try { s = JSON.parse(l); } catch { continue; }
          const ts = gemTime(s.created_at);
          if (!s.model || !ts) continue;
          const x = [`gem:${id}:${s.step_index}:${s.created_at}`, day(ts), s.input_tokens ?? 0, s.output_tokens ?? 0, 0, 0, s.cache_read_tokens ?? 0, s.model, 0, ts];
          const i = at.get(x[0]);
          if (i === undefined) { at.set(x[0], c.recs.length); c.recs.push(x); } else c.recs[i] = x;
        }
        c.size += end;
      } catch {} // (unreadable now: as it was, read again next time)
      next[f] = c;
      if (c.size !== was) dirty = true;
      gemCount(c);
    }
  }
  // Claude Code deletes records older than 30 days (cleanupPeriodDays): their replies stay counted from here (a Gemini
  // one deleted: its too, while there's a Gemini account; kept in the cache all the same).
  // ponytail: the cache keeps every reply forever (~2 MB per busy fortnight); fold old files into day totals if it gets slow
  for (const [f, c] of Object.entries(cache.files)) {
    if (c.gem) { if (!next[f]) { next[f] = c; if (gems.length) gemCount(c); } continue; }
    const ri = roots.findIndex((r) => f.startsWith(r.dir + path.sep) || (r.arch && f.startsWith(r.arch + path.sep)));
    if (next[f] || ri < 0 || fs.existsSync(f)) continue;
    next[f] = c;
    count(c, ri, sidOf(ri, f));
  }
  // whole or not at all: this cache is the only record left of deleted transcripts, so a cut-off write must
  // never replace it (two runs at once: the later rename wins, each file whole)
  // nothing new since the last run: not written again (13 MB each time, for nothing)
  if (dirty || Object.keys(next).length !== Object.keys(cache.files).length) {
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 4, files: next }));
    try { fs.renameSync(tmp, cacheFile); } catch { fs.rmSync(tmp, { force: true }); } // held open by another run: it saves
  }
  // per day, and inside each day per account (by[n]); usd is the API price of the same tokens
  const zero = () => ({ i: 0, o: 0, cw: 0, cr: 0, usd: 0, n: 0 });
  const add = (t, x, usd) => { t.i += x[2]; t.o += x[3]; t.cw += x[4] + x[5]; t.cr += x[6]; t.usd += usd; t.n++; };
  const days = {}, accounts = roots.map((r) => ({ label: r.label, total: 0, usd: 0, ...(r.mac && { mac: r.mac, icon: r.icon ?? null }), ...(r.gem && { gem: r.gem }), ...(r.gpt && { gpt: r.gpt }) }));
  const plus = {}; // what each Mac's other folders cost (by its id): in no total and no day, one amount beside that Mac's (plus)
  for (const { x, ri } of best.values()) {
    const usd = replyCost(x);
    if (roots[ri].other) { plus[roots[ri].of] = (plus[roots[ri].of] ?? 0) + usd; continue; }
    const t = (days[x[1]] ??= { d: x[1], ...zero(), by: roots.map(zero) });
    add(t, x, usd); add(t.by[ri], x, usd);
    accounts[ri].total += sum(x); accounts[ri].usd += usd;
  }
  roots.forEach((r, i) => { if (r.of) { const m = accounts[roots.findIndex((q) => q.id === r.of)]; if (m) m.plus = plus[r.of] ?? 0; } });
  // (the other folders' roots come last: the rows left keep their places in each day's by)
  const firstOther = roots.findIndex((r) => r.other);
  if (firstOther >= 0) accounts.length = firstOther;
  return { days: Object.values(days).sort((a, b) => (a.d < b.d ? -1 : 1)), accounts, total: accounts.reduce((s, a) => s + a.total, 0),
    usd: accounts.reduce((s, a) => s + a.usd, 0), today: day(Date.now()) };
}

// What the 管家 costs (its replies at the API price, as 用量 counts them), by what woke it: you, the service's
// [系统通知], a background task of its own; and the watchdog's Haiku questions (logged with their cost). Today, the
// last 7 days, in all. ponytail: its records read whole each time (cached 30 s with the token counts); keep sizes if slow
function butlerCost(roots = tokenRoots(), logFile = LOG, now = Date.now()) {
  const day = (t) => ymd(new Date(t));
  const seen = new Map(), folder = projectFolder(BUTLER); // a reply (its id, its request) → [usd, kind, day], a copy (another account's) once
  for (const r of roots) {
    let files = []; try { files = fs.readdirSync(path.join(r.dir, folder)).filter((n) => n.endsWith('.jsonl')); } catch {}
    for (const n of files) {
      let kind = 'you';
      for (const l of fs.readFileSync(path.join(r.dir, folder, n), 'utf8').split('\n')) {
        let j; try { j = JSON.parse(l); } catch { continue; }
        if (j.type === 'user' && !j.isMeta) {
          const c = j.message?.content, t = (typeof c === 'string' ? c : Array.isArray(c) ? c.find((p) => p.type === 'text')?.text : '') ?? '';
          if (!t || /^<(local-command|command-|system-reminder)/.test(t.trimStart())) continue; // a tool's result, a command: the same turn
          const w = unwrapPaste(t); // a long [系统通知] comes as a paste
          kind = w.startsWith('[系统通知]') ? 'notice' : w.startsWith('<task-notification>') ? 'bg' : 'you';
        } else if (j.type === 'assistant' && j.message?.usage) {
          const u = j.message.usage, w = u.cache_creation_input_tokens ?? 0, w1 = Math.min(w, u.cache_creation?.ephemeral_1h_input_tokens ?? 0), at = Date.parse(j.timestamp);
          const usd = replyCost([0, 0, u.input_tokens ?? 0, u.output_tokens ?? 0, w - w1, w1, u.cache_read_input_tokens ?? 0, j.message.model, u.speed === 'fast']);
          const k = `${j.message.id}:${j.requestId ?? ''}`;
          if (!(seen.get(k)?.[0] >= usd)) seen.set(k, [usd, seen.get(k)?.[1] ?? kind, day(at), j.message.model ?? '']);
        }
      }
    }
  }
  try { for (const l of fs.readFileSync(logFile, 'utf8').split('\n')) if (l.includes('"watchdog"') && l.includes('"usd"')) { const j = JSON.parse(l); if (j.usd) seen.set(l, [j.usd, 'dog', day(Date.parse(j.timestamp)), 'claude-haiku-4-5']); } } catch {}
  const zero = () => ({ usd: 0, n: 0, you: 0, notice: 0, bg: 0, dog: 0, models: {} }), out = { today: zero(), week: zero(), all: zero() };
  const today = day(now), weekFrom = day(now - 6 * 864e5);
  for (const [usd, kind, d, m] of seen.values()) for (const [k, on] of [['all', true], ['week', d >= weekFrom], ['today', d === today]]) if (on && usd) { const o = out[k]; o.usd += usd; o[kind] += usd; o.n++; o.models[m] = (o.models[m] ?? 0) + usd; }
  return out;
}

const ACCOUNT_COLORS = ['38;2;57;135;229', '38;2;217;89;38', '38;2;25;158;112', '38;2;201;133;0', '38;2;213;81;129', '38;2;0;131;0', '38;2;144;133;233', '38;2;230;103;103']; // the island's and the web page's (dark) account colors
function statusline(input = {}) {
  const paint = (code, s) => (process.env.NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`);
  const dir = process.env.CLAUDE_CONFIG_DIR;
  const key = (d) => (process.platform === 'win32' ? path.resolve(d).toLowerCase() : path.resolve(d));
  const reg = load(), profiles = reg.profiles;
  const i = dir ? profiles.findIndex((q) => key(q.configDir) === key(dir)) : -1;
  // agy's (Gemini): the account by the email it says; one whose email Google never told (no way through), by being on
  const gi = input.product === 'antigravity' ? geminiAccounts(reg).findIndex((g) => (g.email ? g.email === input.email : g.id === reg.geminiOn)) : -1;
  const who = input.product === 'antigravity' ? paint(1, gi >= 0 ? `Gemini 账号 A${gi + 1}` : 'Gemini')
    : i >= 0 ? `${paint(2, `账号 ${i + 1}`)} ${paint(`1;${ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]}`, profiles[i].label)}`
      : paint(1, dir ? '未登记的账号' : '~/.claude');
  const parts = [who];
  const model = [input.model?.display_name, input.effort?.level ?? input.model?.effort].filter(Boolean).join(' · ');
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
  const line = JSON.stringify({ model: input.model?.display_name ?? null, effort: input.effort?.level ?? input.model?.effort ?? null, ctx: input.context_window?.used_percentage ?? null });
  const f = path.join(dir, `${id}.json`);
  try { if (fs.readFileSync(f, 'utf8') === line) return; } catch { // a conversation new here: ones untouched for a month go
    fs.mkdirSync(dir, { recursive: true });
    for (const x of fs.readdirSync(dir)) try { if (Date.now() - fs.statSync(path.join(dir, x)).mtimeMs > 30 * 864e5) fs.unlinkSync(path.join(dir, x)); } catch {}
  }
  fs.writeFileSync(`${f}.tmp`, line); fs.renameSync(`${f}.tmp`, f); // whole, for the service reading it meanwhile
}
const readLine = (id, dir = LINES) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')); } catch { return null; } };
// A Gemini account's quota, as agy hands it to its status line each time (per window: what's left, when it resets; its
// plan): kept for that account (by the email it says, else the one on) in gem-quota\<id>.json, written when it changes
const GEM_QUOTA = path.join(ROOT, 'gem-quota');
function saveGemQuota(input, dir = GEM_QUOTA) {
  if (input.product !== 'antigravity' || !input.quota || typeof input.quota !== 'object') return;
  const reg = load(), all = geminiAccounts(reg), g = all.find((x) => x.email && x.email === input.email) ?? all.find((x) => !x.email && x.id === reg.geminiOn);
  if (!g) return;
  const q = Object.fromEntries(Object.entries(input.quota).map(([k, v]) => [k, { left: v?.remaining_fraction ?? null, reset: v?.reset_time ?? null }]));
  const line = JSON.stringify({ plan: input.plan_tier ?? null, q }), f = path.join(dir, `${g.id}.json`);
  try { if (fs.readFileSync(f, 'utf8') === line) return; } catch { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(`${f}.tmp`, line); fs.renameSync(`${f}.tmp`, f);
}
// its Gemini models' windows as the page shows a GPT account's: how much used, when it resets (one past its reset: 0)
function gemUsage(g, dir = GEM_QUOTA) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, `${g.id}.json`), 'utf8')); } catch { return { windows: null }; }
  const win = (k, name) => {
    const x = j.q?.[k], at = Date.parse(x?.reset ?? ''), over = at > 0 && at < Date.now();
    return typeof x?.left === 'number' ? { k: name, pct: over ? 0 : Math.round((1 - x.left) * 100), reset: at > 0 && !over ? until(at) : '' } : null;
  };
  return { plan: j.plan ?? null, windows: [win('gemini-5h', 'five_hour'), win('gemini-weekly', 'seven_day')].filter(Boolean) };
}

// claude-multi setup: what install.sh / install.ps1 run once the code is in ~/.claude-multi (run again: an update). Your
// ~/.claude/settings.json gets the notes and the status line (added to what's there; the file as it was kept beside it),
// the web service starts at login and now (a Mac's restarted, on the new code), and its page opens.
const LOGIN_LABEL = 'com.claude-multi.web'; // the Mac's launch agent
// the notes (Stop, Notification) and the status line, ours added once; a status line of your own kept (theirs)
function withHooks(s, script) {
  const cmd = (a) => `node "${script}" ${a}`;
  const has = (list, a) => (list ?? []).some((e) => (e.hooks ?? []).some((h) => String(h.command ?? '').includes(`claude-multi.js" ${a}`)));
  const hooks = { ...s.hooks };
  if (!has(hooks.Stop, 'notify done')) hooks.Stop = [...(hooks.Stop ?? []), { hooks: [{ type: 'command', command: cmd('notify done') }] }];
  if (!has(hooks.Notification, 'notify ask')) hooks.Notification = [...(hooks.Notification ?? []), { matcher: 'permission_prompt', hooks: [{ type: 'command', command: cmd('notify ask') }] }];
  const theirs = !!s.statusLine && !String(s.statusLine.command ?? '').includes('claude-multi.js');
  return { s: { ...s, hooks, ...(!theirs && { statusLine: { type: 'command', command: cmd('statusline') } }) }, theirs };
}
// The web service started on its own, as island.ps1 starts it on Windows (a hidden console of its own for what it runs)
const webStart = () => WIN
  ? spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Process $env:CM_NODE -ArgumentList (\'"\' + $env:CM_JS + \'" web\') -WindowStyle Hidden -WorkingDirectory $env:USERPROFILE'],
    { env: { ...process.env, CM_NODE: process.execPath, CM_JS: __filename }, windowsHide: true })
  : require('child_process').spawn(process.execPath, [__filename, 'web'], { cwd: HOME, detached: true, stdio: 'ignore' }).unref();
const webUp = async () => { try { await fetch(`http://127.0.0.1:${WEB_PORT}/`, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; } };
// the pid listening on the web port: netstat's or lsof's (not Get-NetTCPConnection or tasklist, which hang with WMI)
function webPid(text = WIN ? spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true }).stdout
  : spawnSync('lsof', ['-nP', `-iTCP@127.0.0.1:${WEB_PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout) {
  const m = (WIN ? new RegExp(`127\\.0\\.0\\.1:${WEB_PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)`) : /^(\d+)\s*$/m).exec(text ?? '');
  return m ? Number(m[1]) : null;
}
// web restart: the web service ended and started again (new code, or it's stuck), as setup starts it; a Mac's launch
// agent restarted by launchd. Only this service is ended: the one answering as it does (its key page), asked to quit
// (/api/quit), else, one from before that route, its pid ended. A conversation answering is cut, and taken up again,
// idle, once the new one is up (wakeUp). Not from a Claude conversation: the service runs those, and this would end
// with it before the new one starts.
async function restartWeb() {
  // its exit code set, not process.exit(): that right after a fetch trips a libuv assertion on Windows (exit 127)
  const said = (m, code) => { console.log(m); if (code != null) process.exitCode = code; }, base = `http://127.0.0.1:${WEB_PORT}`, dom = `gui/${process.getuid?.()}`;
  if (process.env.CLAUDECODE) return said('这是在 Claude 对话里运行的：网页服务停的时候会连它一起停掉，新的就起不来了。在终端里运行 claude-multi web restart', 1);
  if (process.platform === 'darwin' && spawnSync('launchctl', ['print', `${dom}/${LOGIN_LABEL}`]).status === 0) {
    said('正在重启网页服务：正在回复的对话会被打断，服务起来后接回来');
    spawnSync('launchctl', ['kickstart', '-k', `${dom}/${LOGIN_LABEL}`]);
  } else {
    const page = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text(), () => null);
    if (page === null && webPid()) return said(`${WEB_PORT} 端口上有程序在听，但不回话（pid ${webPid()}）。是卡住的网页服务的话，先结束这个进程再运行一次`, 1);
    if (page !== null) {
      if (!page.includes('claude-multi web-link')) return said(`${WEB_PORT} 端口被别的程序占着，不是 claude-multi 的网页服务，没动它`, 1);
      said('正在重启网页服务：正在回复的对话会被打断，服务起来后接回来');
      const quit = await fetch(`${base}/api/quit`, { method: 'POST', headers: { cookie: `cm=${webKey()}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
      if (!quit) { const pid = webPid(); if (pid) try { process.kill(pid); } catch {} } // one from before web restart: no /api/quit
      for (let i = 0; i < 30 && (await webUp()); i++) await sleep(500);
      if (await webUp()) return said(`旧的网页服务 15 秒还没退出（pid ${webPid()}）`, 1);
    }
    webStart();
  }
  for (let i = 0; i < 60 && !(await webUp()); i++) await sleep(500);
  if (await webUp()) said('网页服务重启好了，刷新网页就行', 0);
  else said(`30 秒了网页服务还没起来${process.platform === 'darwin' ? `，看 ${path.join(ROOT, 'web.log')}` : `，在终端里运行 node "${__filename}" web 看报错`}`, 1);
}
// 有新版本: commits on GitHub this checkout hasn't (its upstream, master for an install), { n, to } (to: the newest's id,
// for the page to say it once a version), else null: none, or it can't tell (no git, no upstream, offline)
function updateCheck(dir = __dirname) {
  const git = (...a) => new Promise((ok) => require('child_process').execFile('git', ['-C', dir, ...a],
    { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out) => ok(e ? null : out.trim())));
  return git('fetch', '-q').then(async (f) => {
    if (f === null) return null;
    const n = Number(await git('rev-list', '--count', 'HEAD..@{u}')), to = await git('rev-parse', '--short', '@{u}');
    return n > 0 && to ? { n, to } : null;
  });
}
// claude-multi update: the newest code from GitHub (git pull), its packages when they changed, then the new code's setup
// (its settings, the web service restarted on it), as the install line run again. The page's 更新 runs it on its own.
function upgrade(dir = __dirname) {
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const fail = (m) => { console.log(m); process.exitCode = 1; };
  const was = git('rev-parse', 'HEAD').stdout?.trim();
  if (!was) return fail('这份代码不是用 git 拉下来的，用一行安装命令重装');
  const pull = git('pull', '-q', '--ff-only');
  if (pull.status) return fail(`没拉下来：${(pull.stderr || pull.error?.message || '').trim().split('\n').pop()}`);
  const now = git('rev-parse', 'HEAD').stdout.trim();
  if (now === was) return console.log('已经是最新的');
  console.log(`拉下来 ${git('rev-list', '--count', `${was}..${now}`).stdout.trim()} 个更新`);
  if (git('diff', '--quiet', was, now, '--', 'package.json', 'package-lock.json').status) {
    // shortcut: on Windows npm can't replace a node-pty the running service holds open, and the update is undone; when node-pty changes version, stop the service first
    const npm = spawnSync('npm install --no-audit --no-fund --loglevel=error', { cwd: dir, stdio: 'inherit', shell: true, windowsHide: true }); // npm.cmd: a shell's
    if (npm.status) { git('reset', '-q', '--keep', was); return fail('依赖没装上，代码退回到更新前了'); } // never new code on old packages
  }
  // run by the new code (this process is the old)
  process.exitCode = spawnSync(process.execPath, [path.join(dir, 'claude-multi.js'), 'setup', '--no-open'], { stdio: 'inherit', windowsHide: true }).status ?? 1;
}
async function setup() {
  // only the copy in ~/.claude-multi: your settings never point at another checkout
  if (path.relative(fs.realpathSync(ROOT), __filename) !== 'claude-multi.js') { console.log(`setup 只用 ${ROOT} 里的代码运行`); process.exit(1); }
  const f = path.join(SHARED, 'settings.json'), bak = `${f}.before-claude-multi`;
  let s = {};
  try { s = JSON.parse(fs.readFileSync(f, 'utf8').trim() || '{}'); } catch (e) { if (e.code !== 'ENOENT') { console.log(`${f} 读不出来（${e.message}），改好再运行一次`); process.exit(1); } }
  const w = withHooks(s, __filename.replace(/\\/g, '/'));
  if (JSON.stringify(w.s) !== JSON.stringify(s)) {
    fs.mkdirSync(SHARED, { recursive: true });
    if (fs.existsSync(f) && !fs.existsSync(bak)) fs.copyFileSync(f, bak);
    fs.writeFileSync(f, JSON.stringify(w.s, null, 2) + '\n');
    console.log(`通知和状态栏加进了 ${f}`);
  }
  if (w.theirs) console.log('状态栏还是你自己的那个，网页底部就看不到模型和上下文用量');
  if (geminiAccounts().length) try { gemSettings(); } catch {} // agy's status line too (Gemini's quota, model): put back if it went
  const up = webUp, start = webStart, was = await up();
  if (process.platform === 'darwin') {
    // a launch agent: started at login and now, again if it crashes. HOME, PATH and LANG as here: launchd's PATH has no claude
    const plist = path.join(HOME, 'Library', 'LaunchAgents', `${LOGIN_LABEL}.plist`), dom = `gui/${process.getuid()}`, log = path.join(ROOT, 'web.log');
    const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;'), str = (v) => `<string>${x(v)}</string>`;
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${str(LOGIN_LABEL)}
  <key>ProgramArguments</key><array>${str(process.execPath)}${str(__filename)}${str('web')}</array>
  <key>WorkingDirectory</key>${str(HOME)}
  <key>EnvironmentVariables</key><dict>${Object.entries({ HOME, PATH: process.env.PATH, LANG: process.env.LANG }).filter(([, v]) => v).map(([k, v]) => `<key>${k}</key>${str(v)}`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key>${str(log)}<key>StandardErrorPath</key>${str(log)}
</dict></plist>
`);
    // the one running ended first (an update: its conversations are taken up again once it's back), then loaded again
    spawnSync('launchctl', ['bootout', `${dom}/${LOGIN_LABEL}`]);
    for (let i = 0; i < 50 && spawnSync('launchctl', ['print', `${dom}/${LOGIN_LABEL}`]).status === 0; i++) await sleep(100);
    const r = spawnSync('launchctl', ['bootstrap', dom, plist], { encoding: 'utf8' });
    if (r.status !== 0) { console.log(`没设成开机启动（${(r.stderr || '').trim()}），这次先直接启动`); start(); }
  } else if (WIN) {
    // at login: a shortcut in Startup, as the island's own (island.ps1 starts the web service, and the island unless it's off)
    const lnk = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Claude Island.lnk');
    if (!fs.existsSync(lnk)) {
      fs.mkdirSync(path.dirname(lnk), { recursive: true });
      spawnSync('powershell.exe', ['-NoProfile', '-Command', '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:CM_LNK); '
        + '$s.TargetPath = (Get-Command powershell.exe).Source; $s.Arguments = $env:CM_ARGS; $s.WindowStyle = 7; $s.Save()'],
      { env: { ...process.env, CM_LNK: lnk, CM_ARGS: `-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ISLAND}"` }, windowsHide: true });
      if (!fs.existsSync(lnk)) console.log('没设成开机启动：「启动」文件夹里的快捷方式没建出来');
    }
    // the claude-multi command: beside npm's own, when that folder is on the PATH
    const bin = path.join(process.env.APPDATA ?? '', 'npm'), shim = path.join(bin, 'claude-multi.cmd');
    if ((process.env.PATH ?? '').toLowerCase().split(';').includes(bin.toLowerCase()) && !fs.existsSync(shim)) fs.writeFileSync(shim, `@node "${__filename}" %*\r\n`);
    if (was) await restartWeb(); // an update (the install line again): the running one on the new code, as a Mac's is
    else { start(); island(); }
  } else if (!was) start();
  for (let i = 0; i < 40 && !(await up()); i++) await sleep(500);
  if (!(await up())) { console.log(`网页服务没起来${process.platform === 'darwin' ? `，看 ${path.join(ROOT, 'web.log')}` : ''}`); process.exit(1); }
  const link = `http://127.0.0.1:${WEB_PORT}/?key=${webKey()}`;
  console.log(`装好了。网页：${link}`);
  // over ssh nobody sits at this screen, and an update's page is open already: the link only
  if (!process.env.SSH_CONNECTION && !process.argv.includes('--no-open')) require('child_process').spawn(process.platform === 'darwin' ? 'open' : 'explorer.exe', [link], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

module.exports = { claudeCmd, gemAgyConvs, gemEnded, gemSum, gemTrust, agySlash, saveGemQuota, gemUsage, gemRename, gemDelete, sameStart, withHooks, usageState, joinApply, checkJoins, pointJoins, readJoins, fetchUsage, quotaSource, webPid, peekHead, peekPdf, slashKeep, macSlashCmd, slashParse, macSlash, shellCmd, frontOf, FRONT_PS, asksPermission, projectOp, dirsIn, isDir, macList, MAC_USAGE, fileServed, macUsageNow, procStarts, tokensBeside, keepOut, replayPty, recycle, copyTo, claudeShare, lastTyped, listSessions, MAC_WATCH, macName, macCmd, macRules, dpapiRead, oaiInput, oaiText, oaiItems, oaiSend, oaiPoll, oaiStop, oaiRead, jsonBody, codexBlocked, codexKeys, listGpt, gptHistory, gptUsage, gptTrust, gptLast, gptTurn, gistText, hold, inLive, keepDefaults, butlerCost, blogSent, unwrapPaste, parseUntil, ticketOp, stageOf, tellSplit, tellAgain, readSeen, allNotes, notesUnseen, notesInto, turnBy, butlerNotice, waitsNow, pickOn, bark, barkMsg, gist, pushText, pushBody, pushAuth, pushPublic, pickOpen, keyMatch, keyCookie, shareTrust, childEnv, helpersBusy, statusline, saveLine, readLine, lastReq, tokenStats, tokenRoots, unlinkAll, unreadNotes, history, recordImage, saveUpload, lead, keepLast, shareMemory, shareMcp, nextRenewal, untilFree, takeSwitch, editOf, codexEdit, queueNow, updateCheck, upgrade, listGemini, gemHistory, gemOn, agyCred, gemSettings, newGemini };
if (require.main === module) {
  fs.mkdirSync(ROOT, { recursive: true });
  const [cmd] = process.argv.slice(2);
  if (cmd === 'new' && /^(gemini|agy)$/i.test(process.argv[3] ?? '')) newGemini().then((ok) => { process.exitCode = ok ? 0 : 1; });
  else if (cmd === 'new') process.exitCode = (process.argv[3] === 'gpt' ? newGpt() : newProfile()) ? 0 : 1;
  else if (cmd === 'switch') switchDefault();
  else if (cmd === 'list') list();
  else if (cmd === 'usage') usage(process.argv.slice(3));
  else if (cmd === 'warmup') warmup();
  else if (cmd === 'notify') { if (process.argv[3] === 'gpt') { const a = process.argv.slice(4); notifyGpt(a.at(-1), a.length > 1 ? a[0] : undefined); } else notify(process.argv[3]); } // gpt [home]: Codex's, its JSON last
  else if (cmd === 'notes') { // the unread notifications, for the island: the same list the web page shows
    const list = listSessions(load()), pid = new Map(list.map((x) => [x.id, x.pid]));
    console.log(JSON.stringify(unreadNotes([...list, ...listGemini()]).map((n) => ({ ...n, pid: pid.get(n.id) ?? null }))));
  }
  else if (cmd === 'island') { if (islandOff()) console.log('灵动岛在网页的设置里关了，先在那里打开它'); else island(); }
  else if (cmd === 'chats') chats(process.argv[3]);
  else if (cmd === 'resume') resume(process.argv[3], process.argv[4]);
  else if (cmd === 'swap') switchChat(process.argv[3], process.argv[4], process.argv.includes('--now')); // (a Gemini one's: A2)
  else if (cmd === 'attach') attach(process.argv[3]);
  else if (cmd === 'chat') chat(process.argv.slice(3));
  else if (cmd === 'ticket') ticket(process.argv.slice(3));
  else if (cmd === 'report' || cmd === 'ask') reportTo(cmd, process.argv.slice(3));
  else if (cmd === 'delete') del(process.argv[3]);
  else if (cmd === 'remove') remove(process.argv[3]);
  else if (cmd === 'web') process.argv[3] === 'restart' ? restartWeb() : web();
  else if (cmd === 'setup') setup();
  else if (cmd === 'update') upgrade();
  else if (cmd === 'web-link') console.log(`${WEB_URL}/?key=${webKey(process.argv[3] === 'new')}`); // new: the old key's browsers are out
  else if (cmd === 'rename') rename(process.argv[3], process.argv.slice(4).join(' '));
  else if (cmd === 'wt-bind') wtBind();
  else if (cmd === 'renew') { // renew N M-D: the day account N renews (or ends) as the store shows it; renew N auto: guessed again
    const [n, v] = process.argv.slice(3), m = /^(?:(\d{4})\D)?(\d{1,2})\D(\d{1,2})\D?$/.exec(v ?? '');
    const day = m && new Date(+(m[1] ?? new Date().getFullYear()), m[2] - 1, +m[3]); // a day that exists: 2-30 rolls over to March
    if (!load().profiles[n - 1] || (v !== 'auto' && !(m && day.getMonth() === m[2] - 1 && day.getDate() === +m[3]))) { console.log('用法：claude-multi renew <账号编号> <月-日，如 10-28；auto 改回推算>'); process.exit(1); }
    update((r) => { const p = r.profiles[n - 1]; if (v === 'auto') delete p.renewOn; else p.renewOn = `${m[1] ?? new Date().getFullYear()}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; });
    console.log(v === 'auto' ? `账号 ${n} 改回按订阅开始时间推算` : `已记下：账号 ${n} 每月 ${+m[3]} 号续费（取消续订的，这天到期）`);
  }
  else if (cmd === 'sessions') { // --all: the GPT ones too (gpt: true, acct its G number from 0) and the GPT 聊天 ones (oai: true), for the 管家; the island's reads Claude's only
    // (a Gemini one: running, at work, asking, as agy's log and its record say, as the web service works it out)
    const reg = load(), gl = process.argv.includes('--all') ? listGemini(reg) : [], on = gl.length ? gemAgyConvs(agyPids()) : new Map(); // (its list first: a helper's told apart by it)
    const gem = ({ made, going, lastAt, said, ...s }) => {
      const m = on.get(s.id), now = !!m && lastAt >= m.since - 1000 && !(m.cut >= lastAt), wait = !!m && !!m.ask && !(lastAt > m.ask.at + 2000);
      return { ...s, pid: m?.pid ?? null, wait, busy: !wait && now && going === 'busy', who: `A${s.acct + 1}` };
    };
    const all = process.argv.includes('--all') ? [...listSessions(reg), ...listGpt(reg).map(({ home, ...s }) => ({ ...s, who: `G${s.acct + 1}` })),
      ...gl.map(gem), ...oaiList()].sort((a, b) => b.at - a.at) : listSessions(reg);
    if (process.argv.includes('--json')) console.log(JSON.stringify(all));
    else for (const s of all) console.log(`${s.pid ? '●' : ' '} ${new Date(s.at).toLocaleString('zh-CN', { hour12: false })}  ${pad(s.who, 16)} ${s.id}  ${path.basename(s.cwd)} · ${s.title}`);
  }
  else if (cmd === 'start') { // start N [claude args]: no menu, used by the island; start Gn: Codex on GPT account n
    // start <a Mac's id> (mac: the Mac mini): one on that Mac for this folder (start mac -: in the Mac's own folder), in the web service, this tab joined to it
    if (macOf(process.argv[3], load())) return attach(null, { mac: process.argv[3], ...(process.argv[4] !== '-' && { dir: process.cwd() }) });
    const g = gptByName(process.argv[3]);
    if (/^g/i.test(process.argv[3] ?? '')) { if (!g) { console.log('没有这个 GPT 账号：用 claude-multi list 看编号（G1、G2…）'); process.exit(1); } return runGpt(g, process.argv.slice(4)); }
    if (/^a\d+$/i.test(process.argv[3] ?? '')) { const a = gemByName(process.argv[3]); if (!a) { console.log('没有这个 Gemini 账号：用 claude-multi list 看编号（A1、A2…）'); process.exit(1); } return runGem(a, process.argv.slice(4)); }
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
    try { saveGemQuota(input); } catch {} // (agy's: its account's quota)
  }
  else launch(process.argv.slice(2));
}
