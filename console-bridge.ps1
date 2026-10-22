param([int]$TargetPid)
# console-bridge.ps1 <pid>: lets the web page show and type into a conversation that runs in a terminal
# window on this computer. Windows has no way to take over another program's terminal, but a process can
# attach to its console: this reads the visible screen (chars and 16 colors) about 8 times a second and
# writes one JSON line {"f": vt, "w", "h"} whenever it changed (vt redraws it in xterm.js), preceded by
# {"s": n} when n lines scrolled off the top meanwhile, and turns each JSON line {"k": vt input} on stdin into
# key presses in that console. {"gone": true} once the console is gone.
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.IO; using System.Text; using System.Threading;
using System.Runtime.InteropServices;
public static class Bridge {
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(int pid);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFile(string n, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; public COORD(short x, short y) { X = x; Y = y; } }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public short L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct INFO { public COORD Size, Cursor; public short Attr; public RECT Win; public COORD Max; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct CELL { public char Ch; public ushort Attr; }
  [DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out INFO i);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool ReadConsoleOutput(IntPtr h, [Out] CELL[] b, COORD size, COORD at, ref RECT r);
  [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)] struct REC {
    [FieldOffset(0)] public ushort Type; [FieldOffset(4)] public int Down; [FieldOffset(8)] public ushort Repeat;
    [FieldOffset(10)] public ushort VK; [FieldOffset(12)] public ushort Scan; [FieldOffset(14)] public char Ch; [FieldOffset(16)] public uint Ctrl; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool WriteConsoleInput(IntPtr h, REC[] r, uint n, out uint w);

  const uint SHIFT = 0x10, CTRL = 0x08, ALT = 0x02;
  static readonly object gate = new object();
  static IntPtr inH;

  public static void Run(int pid) {
    var o = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    FreeConsole();
    if (!AttachConsole(pid)) { o.WriteLine("{\"gone\":true}"); o.Flush(); return; }
    SetConsoleCtrlHandler(IntPtr.Zero, true); // a Ctrl+C typed through us must not end us
    IntPtr outH = CreateFile("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    inH = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    var reader = new Thread(() => {
      var i = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
      for (string l; (l = i.ReadLine()) != null; ) { var k = Field(l, "k"); if (k != null) Type(k); }
      Environment.Exit(0); // the page's server went away
    });
    reader.IsBackground = true; reader.Start();
    string last = null; string[] lastRows = null;
    for (;;) {
      string f; int w, h; string[] rows;
      if (!Frame(outH, out f, out w, out h, out rows)) { o.WriteLine("{\"gone\":true}"); o.Flush(); return; }
      if (f != last) {
        int s = lastRows != null && lastRows.Length == rows.Length ? Scrolled(lastRows, rows) : 0;
        if (s > 0) o.WriteLine("{\"s\":" + s + "}"); // before the frame: the page scrolls those lines into its history
        last = f; lastRows = rows;
        o.WriteLine("{\"w\":" + w + ",\"h\":" + h + ",\"f\":" + Json(f) + "}"); o.Flush();
      }
      Thread.Sleep(120);
    }
  }

  // A console keeps no lines above its window (Windows Terminal keeps them, out of reach), so the page builds
  // its own history: the lines that moved off the top since the last look. That is the smallest k for which
  // the top half of this screen is the last one's rows moved up by k, with at least 3 lines of text in it so
  // that a nearly blank screen redrawn doesn't pass for a scroll. The bottom half is left out of the match:
  // Claude redraws its prompt there.
  static int Scrolled(string[] a, string[] b) {
    int h = b.Length, m = Math.Max(3, h / 2);
    bool same = true;
    for (int r = 0; r < m && same; r++) same = a[r] == b[r];
    if (same) return 0;
    for (int k = 1; k < h - m; k++) {
      bool ok = true; int text = 0;
      for (int r = 0; r < m && ok; r++) { ok = a[r + k] == b[r]; if (b[r].Trim().Length > 0) text++; }
      if (ok && text >= 3) return k;
    }
    return 0; // redrawn rather than scrolled (cleared, resized), or more than half a screen at once
  }

  // The visible window as VT: home, each row with its colors, then the cursor. Wide chars take two cells.
  // rows: the same rows as plain text, to tell a scroll from a redraw.
  static bool Frame(IntPtr h, out string f, out int w, out int hgt, out string[] rows) {
    f = null; w = hgt = 0; rows = null;
    INFO i;
    if (!GetConsoleScreenBufferInfo(h, out i)) return false;
    w = i.Win.R - i.Win.L + 1; hgt = i.Win.B - i.Win.T + 1;
    var cells = new CELL[w * hgt]; var r = i.Win;
    if (!ReadConsoleOutput(h, cells, new COORD((short)w, (short)hgt), new COORD(0, 0), ref r)) return false;
    var sb = new StringBuilder("\x1b[H");
    rows = new string[hgt];
    for (int y = 0; y < hgt; y++) {
      int prev = -1;
      var row = new StringBuilder();
      for (int x = 0; x < w; x++) {
        var c = cells[y * w + x];
        if ((c.Attr & 0x200) != 0) continue; // trailing half of a wide char
        int a = c.Attr & 0xFF;
        if (a != prev) { sb.Append(Sgr(a)); prev = a; }
        char ch = c.Ch == '\0' ? ' ' : c.Ch;
        sb.Append(ch); row.Append(ch);
      }
      rows[y] = row.ToString();
      sb.Append("\x1b[0m\x1b[K");
      if (y < hgt - 1) sb.Append("\r\n");
    }
    sb.Append("\x1b[" + (i.Cursor.Y - i.Win.T + 1) + ";" + (i.Cursor.X - i.Win.L + 1) + "H");
    f = sb.ToString();
    return true;
  }
  // console colors are BGR bits plus intensity; ANSI is RGB. Grey on black stays the page's default.
  static string Sgr(int a) {
    int fg = a & 15, bg = (a >> 4) & 15;
    Func<int, int> ansi = c => ((c & 1) != 0 ? 4 : 0) | (c & 2) | ((c & 4) != 0 ? 1 : 0);
    string f = fg == 7 ? "39" : ((fg & 8) != 0 ? 90 : 30) + ansi(fg) + "";
    string b = bg == 0 ? "49" : ((bg & 8) != 0 ? 100 : 40) + ansi(bg) + "";
    return "\x1b[0;" + f + ";" + b + "m";
  }

  // xterm.js input (text and VT key sequences) as console key presses
  static void Type(string s) {
    var k = new List<REC>();
    for (int i = 0; i < s.Length; i++) {
      char c = s[i];
      if (c == '\x1b' && i + 1 < s.Length && (s[i + 1] == '[' || s[i + 1] == 'O')) {
        int j = i + 2;
        while (j < s.Length && !(s[j] >= '@' && s[j] <= '~')) j++;
        string seq = s.Substring(i + 2, Math.Min(j, s.Length - 1) - i - 1);
        i = j;
        // a paste's marks go through as typed: Claude takes what's between them as one paste, new lines and all
        if (seq == "200~" || seq == "201~") { foreach (char x in "\x1b[" + seq) Key(k, x == '\x1b' ? (ushort)0x1B : (ushort)0, x, 0); continue; }
        uint mod = seq.Contains(";2") ? SHIFT : seq.Contains(";5") ? CTRL : seq.Contains(";3") ? ALT : 0;
        char fin = seq.Length > 0 ? seq[seq.Length - 1] : ' ';
        ushort vk = fin == 'A' ? (ushort)0x26 : fin == 'B' ? (ushort)0x28 : fin == 'C' ? (ushort)0x27 : fin == 'D' ? (ushort)0x25
          : fin == 'H' ? (ushort)0x24 : fin == 'F' ? (ushort)0x23 : fin == 'Z' ? (ushort)0x09
          : seq.StartsWith("3~") ? (ushort)0x2E : seq.StartsWith("5~") ? (ushort)0x21 : seq.StartsWith("6~") ? (ushort)0x22 : (ushort)0;
        if (fin == 'Z') mod = SHIFT;
        if (vk != 0) Key(k, vk, fin == 'Z' ? '\t' : '\0', mod);
        continue;
      }
      if (c == '\x1b' && i + 1 < s.Length) { Key(k, 0, s[++i], ALT); continue; } // Alt+key
      if (c == '\x1b') Key(k, 0x1B, c, 0);
      else if (c == '\r' || c == '\n') Key(k, 0x0D, '\r', 0);
      else if (c == '\x7f' || c == '\b') Key(k, 0x08, '\b', 0);
      else if (c == '\t') Key(k, 0x09, '\t', 0);
      else if (c < ' ') Key(k, (ushort)('A' + c - 1), c, CTRL);
      else Key(k, 0, c, 0);
    }
    lock (gate) { uint n; if (k.Count > 0) WriteConsoleInput(inH, k.ToArray(), (uint)k.Count, out n); }
  }
  static void Key(List<REC> k, ushort vk, char ch, uint mod) {
    var r = new REC(); r.Type = 1; r.Repeat = 1; r.VK = vk; r.Ch = ch; r.Ctrl = mod;
    r.Down = 1; k.Add(r); r.Down = 0; k.Add(r);
  }

  static string Json(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"') b.Append("\\\""); else if (c == '\\') b.Append("\\\\");
      else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4")); else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  // the one string field of a small JSON line, unescaped
  static string Field(string l, string name) {
    int p = l.IndexOf("\"" + name + "\":\"");
    if (p < 0) return null;
    var b = new StringBuilder();
    for (int i = p + name.Length + 4; i < l.Length; i++) {
      char c = l[i];
      if (c == '"') return b.ToString();
      if (c != '\\' || i + 1 >= l.Length) { b.Append(c); continue; }
      char e = l[++i];
      if (e == 'u' && i + 4 < l.Length) { b.Append((char)Convert.ToInt32(l.Substring(i + 1, 4), 16)); i += 4; }
      else b.Append(e == 'n' ? '\n' : e == 'r' ? '\r' : e == 't' ? '\t' : e == 'b' ? '\b' : e == 'f' ? '\f' : e);
    }
    return null;
  }
}
'@
[Bridge]::Run($TargetPid)
