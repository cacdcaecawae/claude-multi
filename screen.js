// What Claude's terminal screen shows, from its rows of text: at work (its spinner row, "✻ Gallivanting… (37s · ↓ 2.9k
// tokens)"), a menu up (its question, a permission: numbered options with ❯ at the current one; or "Do you trust this
// folder?"). The page reads it off its terminal; the 管家's commands (claude-multi chat) off one rebuilt from the stream.
(function (root) {
  // The options counted from ❯ up and down, nearest first, so a numbered list in the text above isn't taken for them.
  // The last ❯ on the screen: a menu sits under the conversation, where a message of yours above it starts ❯ too.
  function parseScreen(rows) {
    rows = rows.map((r) => r.replace(/^\s*│|│\s*$/g, '')); // a boxed menu too
    const busy = rows.map((r) => /^\s*[✻✶✽✢✳·*]\s+(\S.*?…)\s*(?:\((.*)\))?\s*$/.exec(r)).filter(Boolean).pop();
    // Claude's input box on the screen (a rule, its ❯ row under it): no menu is up, as one takes the box's place. A
    // "❯ 4. …" above it is a message of yours in the conversation (Claude draws ❯ before those too), or in the box
    // your own words, not a menu's cursor.
    const inBox = rows.some((r, i) => /^\s*─{20,}/.test(r) && /^\s*❯/.test(rows[i + 1] ?? '')); // its rule may carry the name
    const opt = (i) => /^\s*(?:❯\s*)?(\d+)\.\s+(.*\S)/.exec(rows[i]), cur = inBox ? -1 : rows.findLastIndex((r) => /^\s*❯\s*\d+\.\s/.test(r));
    let menu = null;
    if (cur >= 0) {
      const c = +opt(cur)[1], at = new Map([[c, cur]]);
      for (let i = cur - 1, n = c - 1; i >= 0 && n >= 1; i--) if (+opt(i)?.[1] === n) at.set(n--, i);
      for (let i = cur + 1, n = c + 1; i < rows.length; i++) if (+opt(i)?.[1] === n) at.set(n++, i);
      const top = at.get(1);
      // each option: the rows under it up to the next one (a blank row or a rule ends them) are its description; "[ ]"
      // or "[✔]" before it, a multi-select's check box. The question: the rows above the options up to a rule, the tabs
      // of several questions at once (← ☐ Color ☐ Fruit ✔ Submit →) shown apart.
      // (a rule: a row of it, or a long run of it in a row: the menu's own rule can share its row with what the screen kept
      // of the line before, a turn's status and its cost, and the question took that row and all above it)
      const rule = (r) => (/[─━]{3}/.test(r) && !/[^\s─━╭╮╰╯├┤]/.test(r)) || /[─━]{20}/.test(r), idx = [...at].sort((x, y) => x[0] - y[0]);
      if (at.size >= 2 && top != null) {
        const opts = idx.map(([n, i], k) => {
          const desc = [];
          for (let j = i + 1; j < (idx[k + 1]?.[1] ?? rows.length) && rows[j].trim() && !rule(rows[j]) && !/^\s*Submit\s*$/.test(rows[j]); j++) desc.push(rows[j].trim());
          const box = /^\[([ ✔✓xX])\]\s*(.*)$/.exec(opt(i)[2]);
          return { n, label: box ? box[2] : opt(i)[2], desc: desc.join(' '), check: box ? box[1] !== ' ' : null };
        });
        let a = top;
        while (a > 0 && top - a < 12 && !rule(rows[a - 1])) a--;
        const lines = rows.slice(a, top).map((r) => r.replace(/[│╭╮╰╯─]/g, '').trim()).filter(Boolean), tabs = lines.find((l) => /^←.*→$/.test(l));
        const head = !tabs && lines.find((l) => /^[☐☒✔]\s+\S/.test(l)); // one question: its header over it ("☐ 优先级"), apart
        menu = { cur: c, opts, tabs: tabs?.replace(/^←\s*|\s*→$/g, ''), head: head ? head.replace(/^\S+\s+/, '') : undefined,
          ask: lines.filter((l) => l !== tabs && l !== head).join('\n') };
      }
    }
    // a menu without numbers, like "Do you trust this folder?" (❯ No, exit / Yes, I trust this folder), which Claude asks
    // in the home folder every time: its options are the rows around ❯ up to a blank one, "Enter to confirm" under them
    const foot = rows.findIndex((r) => /Enter to confirm/.test(r)), c = rows.findLastIndex((r, i) => i < foot && /^\s*❯\s+\S/.test(r));
    if (!menu && !inBox && c >= 0) {
      let a = c, z = c;
      while (a > 0 && rows[a - 1].trim()) a--;
      while (z + 1 < foot && rows[z + 1].trim()) z++;
      if (z > a) menu = { cur: c - a + 1, opts: rows.slice(a, z + 1).map((r, k) => ({ n: k + 1, label: r.replace(/^\s*❯?\s*/, '').trim() })),
        ask: /Quick safety check/.test(rows.slice(0, a).join(' ')) ? '要信任这个文件夹吗？选「Yes, I trust this folder」，Claude 才能在这里工作。'
          : rows.slice(Math.max(0, a - 6), a).map((r) => r.trim()).filter(Boolean).join('\n') };
    }
    return { busy, menu };
  }
  // agy's screen (Google's Antigravity CLI, 1.5): at work, its spinner row over its box (「⣟  Generating...」); a question
  // (Run this command?, or its own 「Question 1/1: …」): numbered options over 「↑/↓ Navigate · …」 with > at the current
  // one, read as Claude's with that > as ❯ (your messages above and its box start > too: the last numbered one only); its
  // own question's 「Write-in...」 open (Your answer:, 「enter Submit · esc Back」): writing; what waits in its queue,
  // 「▸ … (alt+m to send immediately)」 (its row may be cut short: …).
  // A list without numbers (> at the current one, 「enter Confirm」 or 「enter Select」 under it; not the / commands' own,
  // 「tab Complete」): its trust question, /model's, /resume's. Its options: the rows around > up to a blank one, or its
  // search box's; its title: the rows over them (as agy 1.5 draws them)
  function parseAgyScreen(rows) {
    const spin = rows.map((r) => /^\s*[⠀-⣿]\s+(\S.*?)\s*$/.exec(r)).find(Boolean), foot = rows.findLastIndex((r) => /↑\/↓ Navigate/.test(r));
    const up = rows.slice(0, Math.max(0, foot)), cur = up.findLastIndex((r) => /^\s*>\s*\d+\.\s/.test(r));
    if (cur >= 0) up[cur] = up[cur].replace('>', '❯');
    let menu = cur >= 0 ? parseScreen(up).menu : null;
    const c = !menu && foot >= 0 && /enter (Confirm|Select)/.test(rows[foot]) && !/tab Complete/.test(rows[foot]) ? up.findLastIndex((r) => /^\s*>\s+\S/.test(r)) : -1;
    if (c >= 0) {
      const search = (r) => /search|tab to cycle/i.test(r), rule = (r) => /^[\s─━]*$/.test(r) || /^\s*>\s*$/.test(r); // (its box's rows above: not its title)
      let a = c, z = c;
      while (a > 0 && up[a - 1].trim() && !search(up[a - 1])) a--;
      while (z + 1 < up.length && up[z + 1].trim()) z++;
      const said = up.slice(Math.max(0, a - 6), a).filter((r) => !rule(r) && !search(r)).map((r) => r.trim());
      menu = { cur: c - a + 1, opts: up.slice(a, z + 1).map((r, k) => ({ n: k + 1, label: r.replace(/^\s*>?\s*/, '').replace(/\s{2,}/g, ' · ').trim() })),
        ask: said.some((l) => /Do you trust the contents of this project/.test(l)) ? '要信任这个文件夹吗？选「Yes, I trust this folder」，Gemini 才能在这里工作。' : said.join('\n') };
    }
    return { busy: spin ? [spin[0], spin[1], ''] : null, menu,
      writing: foot < 0 && rows.some((r) => /enter Submit · esc Back/.test(r)),
      queue: rows.map((r) => /^\s*▸\s+(.*?)\s*\(alt\+m to send immediately\)\s*$/.exec(r)?.[1]?.replace(/…$/, '')).filter(Boolean) };
  }
  // Codex's screen (OpenAI's Codex CLI, 0.171): at work, its status row over its box (「• Working (35s • esc to
  // interrupt)」: its dot • or ◦, its words what it's at). Gone while its answer streams: what's said then is the service's
  function parseCodexScreen(rows) {
    const row = rows.map((r) => /^\s*[•◦]\s+(\S.*?)\s+\(.*esc to interrupt\)/.exec(r)).filter(Boolean).pop();
    return { busy: row ? [row[0], row[1], ''] : null, menu: null };
  }
  if (typeof module !== 'undefined') module.exports = { parseScreen, parseAgyScreen, parseCodexScreen }; else Object.assign(root, { parseScreen, parseAgyScreen, parseCodexScreen });
})(this);
