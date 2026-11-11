// Synthetic output through the real xterm parser; no PTY, live service, account or model call.
const assert = require('assert');
const { Terminal } = require('@xterm/headless');
const { keepOut, replayPty } = require('./claude-multi');
const LIMIT = 262144, ESC = '\x1b';
const write = (t, s) => new Promise((ok) => t.write(s, ok));
const terminal = () => new Terminal({ cols: 60, rows: 10, scrollback: 100, allowProposedApi: true });
const words = (b) => Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '').join('\n');
const screen = (t) => ({ type: t.buffer.active.type, normal: words(t.buffer.normal), alternate: words(t.buffer.alternate) });

module.exports = async function replayTests() {
  // All output retained: a late attachment and a reset/reconnect match a continuously connected terminal, including
  // normal text saved before the full screen, subsequent exit, and another entry/exit. Cover all xterm screen modes.
  for (const mode of [47, 1047, 1049]) {
    const live = terminal(), late = terminal(), state = { buf: '' };
    try {
      const opening = `NORMAL_SCREEN_KEEP\r\n${ESC}[?${mode}h${ESC}[H${ESC}[2JFULL_SCREEN_APP`;
      for (const ch of opening) keepOut(state, ch); // every possible onData split, including ESC and CSI
      assert.equal(replayPty(state), opening); // no prefix before the first eviction
      await write(live, opening); await write(late, replayPty(state));
      assert.deepEqual(screen(late), screen(live));
      late.reset(); await write(late, replayPty(state)); // the page resets xterm when its SSE reconnects
      assert.deepEqual(screen(late), screen(live));
      const exit = `${ESC}[?${mode}l\r\nBACK_IN_NORMAL`;
      keepOut(state, exit); await write(live, exit); await write(late, exit);
      assert.deepEqual(screen(late), screen(live)); assert.ok(words(late.buffer.normal).includes('NORMAL_SCREEN_KEEP'));
      const again = `${ESC}[?${mode}h${ESC}[HFULL_AGAIN${ESC}[?${mode}l`;
      keepOut(state, again); await write(live, again); late.reset(); await write(late, replayPty(state));
      assert.deepEqual(screen(late), screen(live));
    } finally { live.dispose(); late.dispose(); }
  }
  // Each byte boundary of a mode command can be the start of the retained window. NUL padding is ignored by xterm,
  // so this checks mode parsing, not recovery of normal-screen text deliberately outside the bounded replay.
  for (const command of [`${ESC}[?1049h`, `${ESC}[?1003;1006;2004h`, `${ESC}[?2004l`]) {
    for (let cut = 0; cut <= command.length; cut++) {
      const state = { buf: '' }, live = terminal(), late = terminal();
      const initial = `${ESC}[?2004h`, stream = initial + command + '\0'.repeat(LIMIT - command.length + cut);
      try {
        keepOut(state, initial); keepOut(state, command.slice(0, cut)); keepOut(state, command.slice(cut));
        keepOut(state, '\0'.repeat(LIMIT - command.length + cut));
        assert.equal(state.buf.length, LIMIT); assert.ok((state.modeTail?.length ?? 0) <= 356);
        await write(live, stream); await write(late, replayPty(state));
        assert.equal(late.buffer.active.type, live.buffer.active.type); assert.deepEqual(late.modes, live.modes);
        // Move the cut further, including out of a partly discarded command, then reconnect again.
        keepOut(state, '\0'.repeat(40)); await write(live, '\0'.repeat(40)); late.reset(); await write(late, replayPty(state));
        assert.equal(late.buffer.active.type, live.buffer.active.type); assert.deepEqual(late.modes, live.modes);
      } finally { live.dispose(); late.dispose(); }
    }
  }
  // A checkpoint is in last-set order, not numerical mode-key order (nor first-insertion order).
  for (const prefix of [`${ESC}[?1049h${ESC}[?47l`, `${ESC}[?1049h${ESC}[?47l${ESC}[?1049h`]) {
    const state = { buf: '' }, live = terminal(), late = terminal();
    try {
      keepOut(state, prefix); keepOut(state, '\0'.repeat(LIMIT));
      await write(live, prefix); await write(late, replayPty(state));
      assert.equal(late.buffer.active.type, live.buffer.active.type);
    } finally { live.dispose(); late.dispose(); }
  }
  // Unfinished parameters stay bounded without turning the remainder into visible text or changing valid modes.
  for (const params of ['0'.repeat(LIMIT + 100) + '2004', Array(40).fill('0'.repeat(7000) + '2004').join(';')]) {
    const state = { buf: '' }, live = terminal(), late = terminal();
    try {
      const prefix = `${ESC}[?${params}`;
      keepOut(state, prefix); keepOut(state, '\0'.repeat(0)); // leave the CSI unfinished across a trim
      assert.ok((state.modeTail?.length ?? 0) <= 356); assert.ok(state.buf.length <= LIMIT);
      keepOut(state, 'h'); await write(live, prefix + 'h'); await write(late, replayPty(state));
      assert.equal(late.modes.bracketedPasteMode, live.modes.bracketedPasteMode);
      assert.equal(words(late.buffer.normal).trim(), '');
    } finally { live.dispose(); late.dispose(); }
  }
  // A trim inside the 32nd parameter must allow its remaining digits; after the 33rd starts they stay ignored.
  for (const accepted of [31, 32]) {
    const before = `${ESC}[?${'0;'.repeat(accepted)}20`, command = before + '04h';
    const state = { buf: '' }, live = terminal(), late = terminal();
    try {
      keepOut(state, before); keepOut(state, '04h' + '\0'.repeat(LIMIT - 3)); // cut exactly after '20'
      assert.ok(state.modeTail.startsWith(`${ESC}[?`));
      await write(live, command); await write(late, replayPty(state));
      assert.equal(late.modes.bracketedPasteMode, accepted === 31);
      assert.deepEqual(late.modes, live.modes);
      keepOut(state, '\0'.repeat(50)); late.reset(); await write(late, replayPty(state));
      assert.deepEqual(late.modes, live.modes);
    } finally { live.dispose(); late.dispose(); }
  }
  const state = { buf: '' };
  keepOut(state, `${ESC}[?2026h${ESC}[?1003h${ESC}[?2004h`); keepOut(state, '\0'.repeat(LIMIT));
  keepOut(state, `${ESC}[?2004l`);
  const replay = replayPty(state), head = replay.slice(0, replay.length - state.buf.length);
  assert.ok(head.includes(`${ESC}[?1003h`) && head.includes(`${ESC}[?2004h`) && !head.includes('2026'));
  const late = terminal();
  try { await write(late, replay); assert.equal(late.modes.bracketedPasteMode, false); assert.equal(late.modes.synchronizedOutputMode, false); }
  finally { late.dispose(); }
};

if (require.main === module) module.exports().then(() => console.log('replay terminal buffers ok'), (e) => { console.error(e); process.exitCode = 1; });
