# claude-multi island: a pill at the top of the screen with the recommended account's 5h usage.
# Click it for all accounts (refresh, warm up, launch Claude in a recent folder). Claude Code
# notifications, dropped in inbox\ by `claude-multi notify`, pop out of it. One island per login.
# Saved as UTF-8 with BOM: Windows PowerShell reads BOM-less scripts as ANSI and garbles the Chinese.
param([int]$FindWindow, [string]$Arrange)

# A terminal tab shows its conversation's title behind Claude's spinner glyph, which changes while it works.
function Bare([string]$t) { ($t -replace '^[^\p{L}\p{N}]+', '').Trim() }

# Helper modes, each a separate process because it must drop its own console to attach to Claude's:
#  -FindWindow PID   a notification or running conversation was clicked: selects that Claude's terminal tab
#                    and prints its window for the island to bring up.
#  -Arrange FILE     lays running conversations out as the 运行中 page planned in FILE: each planned window's
#                    conversations made the tabs of one terminal window, each group snapped into a Windows
#                    layout. Prints one JSON line saying how it went.
if ($FindWindow -or $Arrange) {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
  Add-Type -Name Con -Namespace Native -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(int pid);
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetConsoleTitle(System.Text.StringBuilder s, uint n);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, int flags);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
public struct RECT { public int L, T, R, B; }
'@
  $A = [Windows.Automation.AutomationElement]
  function Probe([int]$id) { # the window holding a process's console, and the title it gives its tab
    [void][Native.Con]::FreeConsole()
    if (-not [Native.Con]::AttachConsole($id)) { return $null }
    $t = New-Object Text.StringBuilder 1024
    [void][Native.Con]::GetConsoleTitle($t, 1024)
    $r = @{ win = [Native.Con]::GetAncestor([Native.Con]::GetConsoleWindow(), 3); title = Bare $t.ToString() } # 3 = GA_ROOTOWNER
    [void][Native.Con]::FreeConsole()
    $r
  }
  function Find-Tab([int]$id) { # its window, all tabs there, and its own tab when it can be told apart
    $me = Probe $id
    if (-not $me) { return $null }
    $tabs = @()
    try { $tabs = @($A::FromHandle($me.win).FindAll('Descendants', (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)))) } catch {}
    # ponytail: two tabs with the same title, the first one wins
    $tab = $tabs | Where-Object { (Bare $_.Current.Name) -eq $me.title } | Select-Object -First 1
    if (-not $tab -and $tabs.Count) { # renamed by hand, the tab no longer shows the title: take the one tab no other running Claude here accounts for
      $taken = foreach ($f in @(Get-ChildItem "$PSScriptRoot\accounts\*\sessions\*.json", "$env:USERPROFILE\.claude\sessions\*.json" -ErrorAction SilentlyContinue)) {
        try { $o = [int](Get-Content $f.FullName -Raw | ConvertFrom-Json).pid } catch { continue }
        if ($o -eq $id) { continue }
        $p = Probe $o
        if ($p -and $p.win -eq $me.win) { $p.title }
      }
      $left = @($tabs | Where-Object { $taken -notcontains (Bare $_.Current.Name) })
      if ($left.Count -eq 1) { $tab = $left[0] } # ponytail: a plain shell tab beside it leaves two: window only
    }
    @{ win = $me.win; tab = $tab; tabs = $tabs }
  }
  function Front([IntPtr]$h) { # an Alt tap first: Windows lets a background process take the foreground then
    [Native.Con]::keybd_event(0x12, 0, 0, [IntPtr]::Zero); [Native.Con]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
    [void][Native.Con]::SetForegroundWindow($h)
  }
  function Select-Tab($tab) { try { $tab.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch {} }

  if ($FindWindow) {
    $f = Find-Tab $FindWindow
    if (-not $f) { exit }
    if ($f.tab) { Select-Tab $f.tab }
    $f.win.ToInt64()
    exit
  }

  [void][Native.Con]::SetProcessDPIAware() # real pixels for the layout
  $plan = Get-Content $Arrange -Raw -Encoding UTF8 | ConvertFrom-Json # not @(): PS 5.1 already hands back a JSON array as one item
  function Key([byte]$vk) { [Native.Con]::keybd_event($vk, 0, 0, [IntPtr]::Zero); [Native.Con]::keybd_event($vk, 0, 2, [IntPtr]::Zero) }
  function Combo([byte]$vk) { # ctrl+alt+shift+key: the Windows Terminal actions claude-multi wt-bind added
    foreach ($k in 0x11, 0x12, 0x10, $vk) { [Native.Con]::keybd_event($k, 0, 0, [IntPtr]::Zero) }
    foreach ($k in $vk, 0x10, 0x12, 0x11) { [Native.Con]::keybd_event($k, 0, 2, [IntPtr]::Zero) }
  }
  function Fg-Is([IntPtr]$h) { [Native.Con]::GetForegroundWindow() -eq $h }
  # Its tab selected and its window in front; false when Windows didn't hand us the foreground, and then no
  # shortcut is pressed, since it would go to whatever window is in front instead.
  function Bring($f) { if ($f.tab) { Select-Tab $f.tab }; Front $f.win; Start-Sleep -Milliseconds 250; Fg-Is $f.win }
  # Win+Z's panel and Snap Assist belong to the shell. Keys are only typed while one of them is in front, so a
  # digit or an Enter can never land in a Claude prompt (and send it).
  function Shell-In-Front { $p = 0; [void][Native.Con]::GetWindowThreadProcessId([Native.Con]::GetForegroundWindow(), [ref]$p)
    try { (Get-Process -Id $p).ProcessName -eq 'explorer' } catch { $false } }

  $bound = (& node "$PSScriptRoot\claude-multi.js" wt-bind | Out-String).Trim()
  if ($bound -eq 'added') { Start-Sleep -Milliseconds 1500 } # settings reload
  $skipped = New-Object Collections.ArrayList
  $moved = 0; $unmerged = 0

  # 1. Each window of the plan becomes one terminal window holding just its conversations, in order: the first
  # one moved out to a window of its own when it shares one, named, the others moved in, the name cleared.
  $built = @(foreach ($g in $plan) {
    $hs = foreach ($w in @($g.wins)) {
      $pids = @($w | ForEach-Object { [int]$_ })
      if (-not $pids.Count) { [IntPtr]::Zero; continue } # an empty spot: that part of the screen stays empty
      $first = Find-Tab $pids[0]
      if (-not $first) { [void]$skipped.AddRange($pids); [IntPtr]::Zero; continue }
      $others = @(if ($pids.Count -gt 1) { $pids[1..($pids.Count - 1)] })
      $done = $first.tabs.Count -eq $pids.Count -and -not @($others | Where-Object { (Probe $_).win -ne $first.win }).Count
      if ($done -and $others.Count) { # together already, but in the planned tab order?
        $done = (@($pids | ForEach-Object { (Probe $_).title }) -join "`n") -eq (@($first.tabs | ForEach-Object { Bare $_.Current.Name }) -join "`n")
      }
      if (-not $done) {
        if ($bound -eq 'fail') { $unmerged += $others.Count; $first.win; continue } # settings we can't edit: no tab moves
        if ($first.tabs.Count -gt 1) {
          if (-not $first.tab -or -not (Bring $first)) { [void]$skipped.AddRange($pids); [IntPtr]::Zero; continue } # can't tell its tab apart: leave it be
          Combo 0x7B; Start-Sleep -Milliseconds 900 # move tab to new window
          $first = Find-Tab $pids[0]
          if (-not $first -or $first.tabs.Count -gt 1) { [void]$skipped.AddRange($pids); [IntPtr]::Zero; continue } # not out yet: naming would hit the shared window
          $moved++
        }
        if ($others.Count -and -not (Bring $first)) { [void]$skipped.AddRange($others) }
        elseif ($others.Count) {
          Combo 0x7A; Start-Sleep -Milliseconds 500 # name it
          foreach ($p in $others) {
            $f = Find-Tab $p
            if (-not $f -or ($f.tabs.Count -gt 1 -and -not $f.tab) -or -not (Bring $f)) { [void]$skipped.Add($p); continue }
            Combo 0x78; Start-Sleep -Milliseconds 900; $moved++ # move it there
          }
          # clear the name, or the next arranging would move tabs into this window
          # ponytail: three tries; a window left named makes the next run's naming fail until it's closed
          for ($t = 0; $t -lt 3; $t++) { if (Bring $first) { Combo 0x79; Start-Sleep -Milliseconds 300; break } }
        }
      }
      $first.win
    }
    , @($hs)
  })

  # 2. Each full group snapped into Windows' own layout, so it's one piece in Alt+Tab and on the taskbar. That has
  # no API, only the keyboard: Win+Z, the layout's number, zone 1 for the first window, then Enter in Snap
  # Assist for each next one, which fills the zones in reading order and offers the most recently used window
  # first, hence bringing them up last to first. Last group first, so group 1 ends on top.
  # ponytail: the numbers are this machine's Win+Z panel (3 suggestions, then the layouts); a group that doesn't
  # land where it should is placed window by window instead (same spots, not one piece). So is a group with
  # empty spots: Snap Assist can't be told to skip a zone.
  $LAYOUT = @{ '1,1' = 0x34; '1,1,1' = 0x36; '1,2' = 0x37; '2,2' = 0x38 }
  $wa = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  function Zones($shape) { # each window's spot, column by column, top to bottom
    for ($c = 0; $c -lt $shape.Count; $c++) { for ($r = 0; $r -lt $shape[$c]; $r++) {
      @{ x = $wa.X + [int]($wa.Width * $c / $shape.Count); x2 = $wa.X + [int]($wa.Width * ($c + 1) / $shape.Count)
         y = $wa.Y + [int]($wa.Height * $r / $shape[$c]); y2 = $wa.Y + [int]($wa.Height * ($r + 1) / $shape[$c]) } } }
  }
  function Seen([IntPtr]$h) { $v = New-Object Native.Con+RECT; [void][Native.Con]::DwmGetWindowAttribute($h, 9, [ref]$v, 16); $v } # 9 = DWMWA_EXTENDED_FRAME_BOUNDS
  function Fits([IntPtr]$h, $z) { $v = Seen $h; [Math]::Abs($v.L - $z.x) + [Math]::Abs($v.T - $z.y) + [Math]::Abs($v.R - $z.x2) + [Math]::Abs($v.B - $z.y2) -lt 48 }
  function Place([IntPtr]$h, $z) {
    [void][Native.Con]::ShowWindow($h, 9) # restore if maximized or minimized
    # the window rect includes an invisible resize border; cover it so visible edges meet without gaps
    $r = New-Object Native.Con+RECT; [void][Native.Con]::GetWindowRect($h, [ref]$r); $v = Seen $h
    $x = $z.x - ($v.L - $r.L); $y = $z.y - ($v.T - $r.T); $x2 = $z.x2 + ($r.R - $v.R); $y2 = $z.y2 + ($r.B - $v.B)
    [void][Native.Con]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $x2 - $x, $y2 - $y, 0x0014) # NOZORDER | NOACTIVATE
  }
  $snapped = 0; $gapped = 0; $placed = 0; $windows = 0
  for ($k = $built.Count - 1; $k -ge 0; $k--) {
    $hs = @($built[$k]); $n = $hs.Count
    $here = @(0..($n - 1) | Where-Object { $hs[$_] -ne [IntPtr]::Zero }) # the spots that got a window
    $windows += $here.Count
    if (-not $here.Count) { continue }
    if ($n -eq 1) { Front $hs[0]; [void][Native.Con]::ShowWindow($hs[0], 3); $snapped++; continue } # 3 = maximize
    $shape = @($plan[$k].shape | ForEach-Object { [int]$_ })
    $zones = @(Zones $shape)
    $order = @(0..($n - 1) | Sort-Object { $zones[$_].y }, { $zones[$_].x }) # reading order
    $key = $LAYOUT[($shape -join ',')]
    $ok = $false
    if ($key -and $here.Count -eq $n) {
      for ($i = $n - 1; $i -ge 0; $i--) { Front $hs[$order[$i]]; Start-Sleep -Milliseconds 150 }
      Start-Sleep -Milliseconds 300
      if (Fg-Is $hs[$order[0]]) {
        [Native.Con]::keybd_event(0x5B, 0, 0, [IntPtr]::Zero); Key 0x5A; [Native.Con]::keybd_event(0x5B, 0, 2, [IntPtr]::Zero) # Win+Z
        Start-Sleep -Milliseconds 900
        if (Shell-In-Front) { Key $key; Start-Sleep -Milliseconds 500 }
        if (Shell-In-Front) { Key 0x31; Start-Sleep -Milliseconds 1000 } # zone 1
        for ($i = 1; $i -lt $n; $i++) {
          if (-not (Fits $hs[$order[$i - 1]] $zones[$order[$i - 1]]) -or -not (Shell-In-Front)) { break } # Snap Assist isn't up: no Enter
          Key 0x0D; Start-Sleep -Milliseconds 900
        }
        $ok = -not @(0..($n - 1) | Where-Object { -not (Fits $hs[$_] $zones[$_]) }).Count
      }
    }
    if ($ok) { $snapped++ } else {
      foreach ($i in $here) { Place $hs[$i] $zones[$i] }
      for ($j = $here.Count - 1; $j -ge 0; $j--) { Front $hs[$here[$j]] }
      if ($here.Count -lt $n) { $gapped++ } else { $placed++ }
    }
  }
  # one JSON line for the island: groups snapped as one piece, groups with empty spots and groups that didn't
  # snap placed window by window, tabs moved, conversations left alone
  '{"snapped":' + $snapped + ',"gapped":' + $gapped + ',"placed":' + $placed + ',"windows":' + $windows + ',"moved":' + $moved + ',"unmerged":' + $unmerged + ',"skipped":[' + (@($skipped) -join ',') + ']}'
  exit
}
$self = $PSCommandPath

$got = $false
$mutex = New-Object Threading.Mutex($false, 'Local\ClaudeMultiIsland')
try { $got = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $got = $true }
# started again while one runs (you looking for it): that one comes to the front and down from the edge
if (-not $got) { [IO.File]::WriteAllText("$PSScriptRoot\inbox\front-$PID.json", '{"kind":"front"}'); exit }
$pidFile = "$PSCommandPath.pid" # lets `claude-multi notify` skip starting us when we already run
Set-Content -Path $pidFile -Value $PID
# the phone page (claude-multi web) rides along, hidden and on its own: it outlives an island restart, and a
# second start finds its port taken and quits
Start-Process node -ArgumentList "`"$PSScriptRoot\claude-multi.js`" web" -WindowStyle Hidden

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
Add-Type -Name U -Namespace Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
'@
[void][Native.U]::SetProcessDPIAware() # sharp text on scaled screens
# Drawn by the CPU: nothing to lose when the graphics driver resets. For a pill and a list it costs nothing.
[Windows.Media.RenderOptions]::ProcessRenderMode = [Windows.Interop.RenderMode]::SoftwareOnly
# Windows can leave the island, still marked topmost, under ordinary windows (seen 10-13: 8 terminals, Chrome and
# more above it, other apps' topmost windows sunk too); everything then brought to the front lands above it. So each
# time the front window changes (a window brought up comes up that way) it looks: an ordinary window of another
# program above it, and it goes back on top, without taking the focus, and logs who was there (island-errors.log).
Add-Type -ReferencedAssemblies PresentationFramework, PresentationCore, WindowsBase, System.Xaml -TypeDefinition @'
using System; using System.Diagnostics; using System.IO; using System.Runtime.InteropServices; using System.Text;
using System.Windows; using System.Windows.Interop;
namespace Native {
public static class OnTop {
  delegate void WinEvent(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEvent f, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);
  static IntPtr me; static string log; static WinEvent keep; // kept: the hook calls it for as long as we run
  public static void Watch(Window w, string logFile) {
    me = new WindowInteropHelper(w).Handle; log = logFile;
    keep = (hook, ev, hwnd, obj, child, thread, time) => Check(false);
    SetWinEventHook(3, 3, IntPtr.Zero, keep, 0, 0, 0); // EVENT_SYSTEM_FOREGROUND, called on this thread
  }
  // back on top when covered (or always, with force); the ordinary window of another program found above it, logged
  public static void Check(bool force) {
    if (me == IntPtr.Zero) return;
    uint mine; GetWindowThreadProcessId(me, out mine);
    for (IntPtr h = GetWindow(me, 3); h != IntPtr.Zero; h = GetWindow(h, 3)) { // GW_HWNDPREV: above it
      int cloaked; uint pid;
      if (!IsWindowVisible(h) || (GetWindowLong(h, -20) & 8) != 0) continue; // hidden, or topmost itself
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) continue; // on another desktop
      GetWindowThreadProcessId(h, out pid);
      if (pid == mine) continue;
      var t = new StringBuilder(80); GetWindowText(h, t, 80);
      string who; try { who = Process.GetProcessById((int)pid).ProcessName; } catch { who = "pid " + pid; }
      try { File.AppendAllText(log, DateTime.Now.ToString("MM-dd HH:mm:ss") + " 被压在下面，回到最上面：" + who + " '" + t + "' 在上面\r\n"); } catch {}
      force = true;
      break;
    }
    if (force) SetWindowPos(me, new IntPtr(-1), 0, 0, 0, 0, 0x13); // HWND_TOPMOST; NOSIZE | NOMOVE | NOACTIVATE
  }
}}
'@

$root = Split-Path -Parent $PSCommandPath
$js = Join-Path $root 'claude-multi.js'
$inbox = Join-Path $root 'inbox'
[void](New-Item -ItemType Directory -Force -Path $inbox)
$ns = 'xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"'
function X([string]$xaml) { [Windows.Markup.XamlReader]::Parse($xaml) }
# For XAML attribute values (every use is one): XML-escaped, and a leading "{" marked literal with "{}", or
# XAML would take a title like {"ok":true} for a markup extension and fail to load.
function Esc([string]$s) { $e = [Security.SecurityElement]::Escape($s); if ($e.StartsWith('{')) { '{}' + $e } else { $e } }
function Tint([double]$pct) { if ($pct -ge 80) { '#FF453A' } elseif ($pct -ge 50) { '#FFD60A' } else { '#30D158' } }
function Bar([double]$pct, [int]$w, [double]$h = 5, [string]$m = '0', [double]$o = 1) {
  $fill = [Math]::Round([Math]::Min(100, $pct) / 100 * $w)
  "<Border Width='$w' Height='$h' CornerRadius='$($h / 2)' Background='#2EFFFFFF' Margin='$m' Opacity='$o' VerticalAlignment='Center'><Border Width='$fill' HorizontalAlignment='Left' CornerRadius='$($h / 2)' Background='$(Tint $pct)'/></Border>"
}

# Shared by the island and the conversation window.
$styles = @'
  <Style TargetType="ScrollBar">
   <Setter Property="Width" Value="6"/><Setter Property="MinWidth" Value="6"/>
   <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ScrollBar">
    <Track x:Name="PART_Track" IsDirectionReversed="True">
     <Track.Thumb><Thumb><Thumb.Template><ControlTemplate TargetType="Thumb">
      <Border x:Name="T" CornerRadius="3" Background="#33FFFFFF"/>
      <ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="T" Property="Background" Value="#66FFFFFF"/></Trigger></ControlTemplate.Triggers>
     </ControlTemplate></Thumb.Template></Thumb></Track.Thumb>
    </Track>
   </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style TargetType="Button">
   <Setter Property="Foreground" Value="White"/><Setter Property="FontSize" Value="12"/><Setter Property="Cursor" Value="Hand"/>
   <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
    <Border x:Name="B" Background="#26FFFFFF" CornerRadius="11" Padding="11,3"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border>
    <ControlTemplate.Triggers>
     <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Background" Value="#47FFFFFF"/></Trigger>
     <Trigger Property="IsEnabled" Value="False"><Setter TargetName="B" Property="Opacity" Value="0.4"/></Trigger>
    </ControlTemplate.Triggers>
   </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style x:Key="Item" TargetType="Button">
   <Setter Property="Foreground" Value="White"/><Setter Property="Cursor" Value="Hand"/><Setter Property="HorizontalContentAlignment" Value="Left"/><Setter Property="Background" Value="Transparent"/>
   <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
    <Border x:Name="B" Background="{TemplateBinding Background}" CornerRadius="9" Padding="10,6"><ContentPresenter HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}"/></Border>
    <ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Background" Value="#24FFFFFF"/></Trigger></ControlTemplate.Triggers>
   </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style x:Key="Icon" TargetType="Button">
   <Setter Property="Foreground" Value="#B3FFFFFF"/><Setter Property="FontFamily" Value="Segoe MDL2 Assets"/><Setter Property="FontSize" Value="13"/><Setter Property="Cursor" Value="Hand"/>
   <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
    <Border x:Name="B" Width="28" Height="28" CornerRadius="14" Background="Transparent"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border>
    <ControlTemplate.Triggers>
     <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Background" Value="#26FFFFFF"/></Trigger>
     <Trigger Property="IsEnabled" Value="False"><Setter TargetName="B" Property="Opacity" Value="0.35"/></Trigger>
    </ControlTemplate.Triggers>
   </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style x:Key="Text" TargetType="Button">
   <Setter Property="Foreground" Value="#8CFFFFFF"/><Setter Property="FontSize" Value="12"/><Setter Property="Cursor" Value="Hand"/>
   <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
    <Border x:Name="B" Background="Transparent" CornerRadius="8" Padding="8,2"><ContentPresenter/></Border>
    <ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Background" Value="#1FFFFFFF"/></Trigger></ControlTemplate.Triggers>
   </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style x:Key="OnHover" TargetType="FrameworkElement">
   <Setter Property="Opacity" Value="0"/>
   <Style.Triggers><DataTrigger Binding="{Binding IsMouseOver, RelativeSource={RelativeSource AncestorType=Button}}" Value="True"><Setter Property="Opacity" Value="1"/></DataTrigger></Style.Triggers>
  </Style>
  <Style x:Key="OffHover" TargetType="FrameworkElement">
   <Style.Triggers><DataTrigger Binding="{Binding IsMouseOver, RelativeSource={RelativeSource AncestorType=Button}}" Value="True"><Setter Property="Opacity" Value="0"/></DataTrigger></Style.Triggers>
  </Style>
  <Style x:Key="Primary" TargetType="Button">
   <Setter Property="Foreground" Value="Black"/><Setter Property="FontSize" Value="12"/><Setter Property="FontWeight" Value="SemiBold"/><Setter Property="Cursor" Value="Hand"/>
   <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
    <Border x:Name="B" Background="#E6FFFFFF" CornerRadius="12" Padding="14,4"><ContentPresenter HorizontalAlignment="Center"/></Border>
    <ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Background" Value="White"/></Trigger></ControlTemplate.Triggers>
   </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style TargetType="ToolTip">
   <Setter Property="Foreground" Value="White"/><Setter Property="FontSize" Value="12"/>
   <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ToolTip">
    <Border Background="#F21C1C1E" BorderBrush="#33FFFFFF" BorderThickness="1" CornerRadius="8" Padding="9,5"><ContentPresenter/></Border>
   </ControlTemplate></Setter.Value></Setter>
  </Style>
'@

$win = X @"
<Window $ns WindowStyle="None" AllowsTransparency="True" Background="Transparent" Topmost="True"
  ShowInTaskbar="False" ShowActivated="False" ResizeMode="NoResize" SizeToContent="WidthAndHeight"
  FontFamily="Segoe UI Variable Text, Microsoft YaHei UI" Foreground="White" UseLayoutRounding="True">
 <Window.Resources>$styles</Window.Resources>
 <Grid x:Name="Root">
 <Border x:Name="Island" Background="#F5000000" CornerRadius="22" Padding="16,8" Margin="14,6,14,16"
   BorderBrush="#1FFFFFFF" BorderThickness="1" RenderTransformOrigin="0.5,0">
  <Border.Effect><DropShadowEffect BlurRadius="18" ShadowDepth="3" Direction="270" Opacity="0.5"/></Border.Effect>
  <Border.RenderTransform><ScaleTransform x:Name="Scale"/></Border.RenderTransform>
  <StackPanel>
   <DockPanel x:Name="Pill" Background="Transparent" Cursor="Hand" LastChildFill="False">
    <TextBlock x:Name="PillName" Text="Claude · 读取中…" FontSize="13" FontWeight="SemiBold" VerticalAlignment="Center"/>
    <StackPanel x:Name="PillAccts" Orientation="Horizontal" Visibility="Collapsed"/>
    <Border x:Name="BadgeBox" Visibility="Collapsed" Background="#FF9F0A" CornerRadius="8" Padding="6,0" Margin="10,0,0,0" VerticalAlignment="Center" ToolTip="未读提示，点开查看">
     <TextBlock x:Name="Badge" FontSize="11" FontWeight="SemiBold" Foreground="Black"/>
    </Border>
   </DockPanel>
   <StackPanel x:Name="Alerts" Visibility="Collapsed" Background="Transparent" Cursor="Hand"/>
   <StackPanel x:Name="Panel" Visibility="Collapsed" Margin="0,12,0,0" MinWidth="420">
    <StackPanel x:Name="HistoryBox" Visibility="Collapsed" Margin="0,0,0,14">
     <DockPanel>
      <Button x:Name="BtnClearHist" Style="{StaticResource Text}" Content="清空" DockPanel.Dock="Right"/>
      <TextBlock x:Name="HistTitle" FontSize="13" FontWeight="SemiBold" Foreground="#FF9F0A" VerticalAlignment="Center"/>
     </DockPanel>
     <StackPanel x:Name="History"/>
    </StackPanel>
    <StackPanel x:Name="Rows"/>
    <StackPanel x:Name="ProjView" Visibility="Collapsed">
     <DockPanel Margin="0,0,0,6">
      <Button x:Name="BtnBack" Style="{StaticResource Text}" Content="返回" DockPanel.Dock="Right"/>
      <TextBlock x:Name="ProjTitle" FontSize="13" FontWeight="SemiBold" VerticalAlignment="Center"/>
     </DockPanel>
     <StackPanel x:Name="ProjList"/>
    </StackPanel>
    <DockPanel Margin="0,10,-6,-2">
     <StackPanel DockPanel.Dock="Right" Orientation="Horizontal">
      <Button x:Name="BtnChats" Style="{StaticResource Icon}" Content="&#xE8BD;" ToolTip="对话列表：回到之前的对话"/>
      <Button x:Name="BtnTokens" Style="{StaticResource Icon}" Content="&#xE9D2;" ToolTip="Token 用量"/>
      <Button x:Name="BtnRefresh" Style="{StaticResource Icon}" Content="&#xE72C;" ToolTip="刷新用量"/>
      <Button x:Name="BtnWarm" Style="{StaticResource Icon}" Content="&#xE945;" ToolTip="预热：让还没开始计时的账号开始 5 小时窗口"/>
      <Button x:Name="BtnQuit" Style="{StaticResource Icon}" Content="&#xE711;" ToolTip="关闭灵动岛"/>
     </StackPanel>
     <TextBlock x:Name="Status" FontSize="11" Foreground="#73FFFFFF" VerticalAlignment="Center"/>
    </DockPanel>
   </StackPanel>
  </StackPanel>
 </Border>
 <!-- floats on the island's top-right corner, only while hovered: takes no room in the pill -->
 <Border x:Name="Pin" Width="22" Height="22" CornerRadius="11" Background="#FF2C2C2E" BorderBrush="#40FFFFFF" BorderThickness="1"
   HorizontalAlignment="Right" VerticalAlignment="Top" Margin="0,0,3,0" Cursor="Hand" Opacity="0" IsHitTestVisible="False">
  <TextBlock x:Name="PinIcon" FontFamily="Segoe MDL2 Assets" FontSize="10" HorizontalAlignment="Center" VerticalAlignment="Center"/>
 </Border>
 </Grid>
</Window>
"@
foreach ($n in 'Island', 'Scale', 'Pill', 'Pin', 'PinIcon', 'PillName', 'PillAccts', 'HistTitle', 'Alerts', 'Panel',
  'Status', 'BtnChats', 'BtnTokens', 'BtnRefresh', 'BtnWarm', 'BtnQuit', 'Rows', 'ProjView', 'BtnBack', 'ProjTitle', 'ProjList',
  'BadgeBox', 'Badge', 'HistoryBox', 'History', 'BtnClearHist') {
  Set-Variable -Name $n -Value $win.FindName($n)
}

$script:data = $null
$script:fetched = [DateTime]::MinValue
$script:loading = $false
$script:note = ''
$script:alertUntil = [DateTime]::MinValue
$script:pending = New-Object Collections.ArrayList

# --- motion -------------------------------------------------------------------------------------
function Pop {
  $ease = New-Object Windows.Media.Animation.BackEase
  $ease.Amplitude = 0.35; $ease.EasingMode = 'EaseOut'
  foreach ($prop in [Windows.Media.ScaleTransform]::ScaleXProperty, [Windows.Media.ScaleTransform]::ScaleYProperty) {
    $an = New-Object Windows.Media.Animation.DoubleAnimation -ArgumentList 0.93, 1.0, (New-Object Windows.Duration ([TimeSpan]::FromMilliseconds(280)))
    $an.EasingFunction = $ease
    $Scale.BeginAnimation($prop, $an)
  }
}
# Unpinned, the island slides up off the screen and leaves its bottom 6 px as a handle to hover.
# ponytail: assumes nothing above the primary screen; a monitor stacked on top would show the hidden island
function TopFor([bool]$hide) {
  $wa = [Windows.SystemParameters]::WorkArea
  if ($hide) { $wa.Top + 6 - ($win.ActualHeight - 16) } else { $wa.Top } # 16 = the island's bottom margin
}
function Slide([bool]$hide) {
  if (-not $hide) { [Native.OnTop]::Check($false) } # to be seen: a window brought up without becoming the front one may cover it
  $script:hidden = $hide
  Paint-Rim
  $an = New-Object Windows.Media.Animation.DoubleAnimation -ArgumentList (TopFor $hide), (New-Object Windows.Duration ([TimeSpan]::FromMilliseconds(220)))
  $ease = New-Object Windows.Media.Animation.CubicEase
  $ease.EasingMode = 'EaseOut'; $an.EasingFunction = $ease
  $win.BeginAnimation([Windows.Window]::TopProperty, $an)
}
function Recenter {
  $wa = [Windows.SystemParameters]::WorkArea
  $win.Left = $wa.Left + ($wa.Width - $win.ActualWidth) / 2
  $win.BeginAnimation([Windows.Window]::TopProperty, $null) # drop a finished slide so Top can be set
  $win.Top = TopFor $script:hidden
}
# Cursor anywhere in our window's rectangle, margins included. Not IsMouseOver: that misses the
# transparent 6 px gap above the shown island, so a cursor resting on the screen edge made it bounce
# (hide, touch the handle, show, ...). Also widens the hidden handle to a ~22 px tall hover zone.
function MouseNear {
  $s = [Windows.PresentationSource]::FromVisual($win).CompositionTarget.TransformToDevice.M11 # DIPs -> pixels
  $c = [Windows.Forms.Cursor]::Position
  $c.X -ge $win.Left * $s -and $c.X -lt ($win.Left + $win.ActualWidth) * $s -and
    $c.Y -ge $win.Top * $s -and $c.Y -lt ($win.Top + $win.ActualHeight) * $s
}
$pinFile = "$self.pinned" # the pin survives restarts
$script:pinned = Test-Path $pinFile
$script:hidden = $false
$script:away = 0
$script:ticks = 0
function Show-Pin { # Segoe MDL2: E718 pin outline, E841 pinned (filled)
  $PinIcon.Text = [string][char]$(if ($script:pinned) { 0xE841 } else { 0xE718 })
  $PinIcon.Foreground = if ($script:pinned) { '#FFD60A' } else { '#B3FFFFFF' }
  $Pin.ToolTip = if ($script:pinned) { '取消固定' } else { '固定，不自动隐藏' }
}
Show-Pin

# --- child processes: async, polled by the timer, so the UI never blocks ------------------------
function Run-Async([string]$exe, [string]$cmdArgs, [scriptblock]$done, $ctx) {
  $psi = New-Object Diagnostics.ProcessStartInfo($exe, $cmdArgs)
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.EnvironmentVariables['NO_COLOR'] = '1'
  try { $p = [Diagnostics.Process]::Start($psi) } catch { & $done '' $ctx; return }
  [void]$script:pending.Add(@{ task = $p.StandardOutput.ReadToEndAsync(); done = $done; ctx = $ctx })
}
function Run-Node([string]$cmdArgs, [scriptblock]$done) { Run-Async 'node' "`"$js`" $cmdArgs" $done $null }

function Refresh {
  if ($script:loading) { return }
  $script:loading = $true
  $Status.Text = '刷新中…'
  Load-Unread # the same unread list as the web page (also the first thing at start)
  Run-Node 'usage --json' {
    param($out)
    $script:loading = $false
    $script:fetched = Get-Date
    try { $script:data = $out | ConvertFrom-Json; Render; Check-Limits; $Status.Text = $script:note + '更新于 ' + (Get-Date -Format 'HH:mm') }
    catch { $Status.Text = '用量读取失败'; if (-not $script:data) { $PillName.Text = 'Claude · 用量读取失败' } }
    $script:note = ''
  }
}

# --- drawing ------------------------------------------------------------------------------------
# Emphasis, not hiding: the recommended account bright, the others greyer, details (7d, reset
# times, tools) small and grey.
function MDay([string]$d) { "$([int]$d.Substring(5, 2))月$([int]$d.Substring(8, 2))日" } # 2026-07-07 -> 7月7日
# How each account is paid, as a name and a 24x24 mark (the web page draws the same): the App Store, Google Play, a card
# on claude.ai (Stripe). F0: holes stay holes (the card's).
$BANK_CARD = @('银行卡订阅', 'F0 M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM4 6v2h16V6zm0 5v7h16v-7z') # not $card: a name in use
$PAY = @{
  apple_subscription = @('苹果订阅', 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701')
  google_play_subscription = @('Google Play 订阅', 'M22.018 13.298l-3.919 2.218-3.515-3.493 3.543-3.521 3.891 2.202a1.49 1.49 0 0 1 0 2.594zM1.337.924a1.486 1.486 0 0 0-.112.568v21.017c0 .217.045.419.124.6l11.155-11.087L1.337.924zm12.207 10.065l3.258-3.238L3.45.195a1.466 1.466 0 0 0-.946-.179l11.04 10.973zm0 2.067l-11 10.933c.298.036.612-.016.906-.183l13.324-7.54-3.23-3.21z')
  stripe_subscription = $BANK_CARD; stripe_subscription_contracted = $BANK_CARD
}
# An account at its limit while conversations run on it: one notice (per account, until it's off its limit again) that
# they wait for the reset; a click opens the running ones, each with 换账号继续. Nothing switches by itself.
$script:limitTold = @{}
function Check-Limits {
  $accs = @($script:data.accounts)
  for ($i = 0; $i -lt $accs.Count; $i++) {
    $full = @($accs[$i].windows | Where-Object { $_.pct -ge 100 })
    if (-not $full.Count) { $script:limitTold.Remove($i); continue }
    if (-not $accs[$i].running -or $script:limitTold[$i]) { continue }
    $script:limitTold[$i] = 1
    $when = if ($full[-1].reset) { "$($full[-1].reset)后自动继续" } else { '额度恢复后自动继续' } # the later window, when both are full
    Add-Alert @{ kind = 'ask'; info = $true; action = 'running'; project = "账号 $($i + 1) 额度用完"; msg = "它上面 $($accs[$i].running) 个对话在等，$when · 点这里换账号继续" }
  }
}
function Pct5($a) { $w = @($a.windows | Where-Object { $_.k -eq 'five_hour' })[0]; if ($w) { $w.pct } else { 0 } }
function Render {
  $d = $script:data
  $all = @($d.accounts)
  if ($null -eq $d.rec) {
    $PillName.Text = 'Claude · 暂无可用数据'
    $PillName.Visibility = 'Visible'; $PillAccts.Visibility = 'Collapsed'
  } else {
    $r = $all[$d.rec]; $p = Pct5 $r
    $run = if ($d.open) { "可用 $($r.runway)h" } else { "$($d.ready)后恢复" }
    $PillAccts.Children.Clear()
    [void]$PillAccts.Children.Add((X ("<StackPanel $ns Orientation='Horizontal'>" +
      "<TextBlock Text='$(Esc $r.label.Split('@')[0])' ToolTip='$(Esc $r.label)' MaxWidth='120' TextTrimming='CharacterEllipsis' FontSize='13' FontWeight='SemiBold' VerticalAlignment='Center'/>" +
      "$(Bar $p 56 5 '10,0,0,0')<TextBlock Text='$p%' FontSize='12' Margin='7,0,0,0' VerticalAlignment='Center'/>" +
      "<TextBlock Text='$run' FontSize='12' Foreground='#30D158' Margin='10,0,0,0' VerticalAlignment='Center'/></StackPanel>")))
    $first = $true
    for ($i = 0; $i -lt $all.Count; $i++) {
      if ($i -eq $d.rec) { continue }
      if ($first) { [void]$PillAccts.Children.Add((X "<Border $ns Width='1' Height='14' Background='#33FFFFFF' Margin='14,0,12,0' VerticalAlignment='Center'/>")) }
      $p = Pct5 $all[$i]
      $num = if ($all[$i].err) { "<TextBlock Text='—' FontSize='11' Foreground='#73FFFFFF' Margin='6,0,0,0' VerticalAlignment='Center'/>" }
        else { "$(Bar $p 36 4 '6,0,0,0' 0.7)<TextBlock Text='$p%' FontSize='11' Foreground='#8CFFFFFF' Margin='6,0,0,0' VerticalAlignment='Center'/>" }
      [void]$PillAccts.Children.Add((X ("<StackPanel $ns Orientation='Horizontal' Margin='$(if ($first) { 0 } else { 12 }),0,0,0'>" +
        "<TextBlock Text='$($i + 1)' ToolTip='$(Esc $all[$i].label)' FontSize='12' Foreground='#73FFFFFF' VerticalAlignment='Center'/>$num</StackPanel>")))
      $first = $false
    }
    $PillName.Visibility = 'Collapsed'; $PillAccts.Visibility = 'Visible'
  }

  $names = @{ five_hour = '5 小时'; seven_day = '7 天'; seven_day_opus = 'Opus 7 天'; seven_day_sonnet = 'Sonnet 7 天' }
  $Rows.Children.Clear()
  $order = @(@($d.rec | Where-Object { $null -ne $_ }) + @(0..($all.Count - 1) | Where-Object { $_ -ne $d.rec }))
  foreach ($i in $order) {
    # Every account shows the same details; the recommended one is the bright card with the big button,
    # the rest sit on a fainter card in greyer text with a small launch icon.
    $a = $all[$i]; $rec = $i -eq $d.rec
    $accent = if ($d.open) { '30D158' } else { 'FF9F0A' }
    $right = if ($a.err) { '' } elseif ($rec -and -not $d.open) { "$($d.ready)后恢复" } elseif ($a.runway -gt 0) { "可连续用 $($a.runway) 小时" } else { '已用满' }
    $rightFg = if ($rec) { "#$accent" } elseif ($a.runway -gt 0) { '#8CFFFFFF' } else { '#B3FF453A' }
    $lines = if ($a.err) { "<TextBlock Text='$(Esc $a.err)' Margin='0,8,0,0' FontSize='11' Foreground='#B3FFD60A' TextWrapping='Wrap'/>" } else {
      foreach ($w in $a.windows) {
        $main = $w.k -eq 'five_hour'
        $reset = if ($w.reset) { "$($w.reset)后重置" } else { '' }
        $pctFg = if ($main -and $rec) { 'White' } elseif ($main) { '#D9FFFFFF' } else { '#99FFFFFF' }
        "<StackPanel Orientation='Horizontal' Margin='0,$(if ($main) { 10 } else { 6 }),0,0'>" +
        "<TextBlock Text='$($names[$w.k])' Width='64' FontSize='11' Foreground='#8CFFFFFF' VerticalAlignment='Center'/>" +
        "$(Bar $w.pct 170 $(if ($main) { 6 } else { 4 }) '0' $(if ($main -and $rec) { 1 } elseif ($main) { 0.8 } else { 0.55 }))" +
        "<TextBlock Text='$($w.pct)%' Width='46' TextAlignment='Right' FontSize='$(if ($main) { 13 } else { 11 })' FontWeight='$(if ($main) { 'SemiBold' } else { 'Normal' })' Foreground='$pctFg' VerticalAlignment='Center'/>" +
        "<TextBlock Text='$reset' Margin='14,0,0,0' FontSize='11' Foreground='#73FFFFFF' VerticalAlignment='Center'/></StackPanel>"
      }
    }
    $head = if ($rec) {
      "<Border Background='#2E$accent' CornerRadius='6' Padding='6,1' VerticalAlignment='Center'><TextBlock Text='$(if ($d.open) { '推荐' } else { '最早恢复' })' FontSize='11' FontWeight='SemiBold' Foreground='#$accent'/></Border>" +
      "<TextBlock Text='$(Esc $a.label.Split('@')[0])' ToolTip='$(Esc $a.label)' FontSize='14' FontWeight='SemiBold' Margin='8,0,12,0' TextTrimming='CharacterEllipsis' VerticalAlignment='Center'/>"
    } else {
      "<TextBlock Text='$($i + 1)' FontSize='12' Foreground='#73FFFFFF' Margin='2,0,0,0' VerticalAlignment='Center'/>" +
      "<TextBlock Text='$(Esc $a.label.Split('@')[0])' ToolTip='$(Esc $a.label)' FontSize='13' FontWeight='SemiBold' Foreground='#CCFFFFFF' Margin='10,0,12,0' TextTrimming='CharacterEllipsis' VerticalAlignment='Center'/>"
    }
    $small = if ($rec) { '' } else { "<Button x:Name='Go' DockPanel.Dock='Right' Content='&#xE768;' ToolTip='用这个账号启动' Margin='6,-6,-8,-6'/>" }
    $big = if ($rec) { "<Button x:Name='Go' Content='▶  启动' HorizontalAlignment='Right' Margin='0,12,0,0'/>" } else { '' }
    # beside the name: the next renewal (guessed monthly, claude-multi.js subscription) with how it's paid; renewal
    # turned off, in orange, the day it ends
    $renew = ''
    if ($a.sub) {
      $how = $PAY["$($a.sub.billing)"]
      $fg = if ($a.sub.canceled) { '#CCFF9F0A' } else { '#66FFFFFF' }
      $renew = "<StackPanel Orientation='Horizontal' VerticalAlignment='Center' ToolTip='$(if ($how) { "$($how[0])，" })$(if ($a.sub.canceled) { '已取消续订，' })按月推算'>" +
        $(if ($how) { "<Path Data='$($how[1])' Fill='$fg' Stretch='Uniform' Height='10' Margin='0,-2,4,0' VerticalAlignment='Center'/>" }) +
        "<TextBlock Text='$(MDay $a.sub.renew)$(if ($a.sub.canceled) { '到期' } else { '续费' })' FontSize='11' Foreground='$fg' VerticalAlignment='Center'/></StackPanel>"
    }
    $card = X ("<Border $ns Background='$(if ($rec) { '#17FFFFFF' } else { '#0AFFFFFF' })' CornerRadius='14' Padding='14,11,14,12' Margin='0,0,0,6'><StackPanel>" +
      "<DockPanel>$small<TextBlock DockPanel.Dock='Right' Text='$right' FontSize='12' Foreground='$rightFg' VerticalAlignment='Center'/>" +
      "<Button x:Name='Del' DockPanel.Dock='Right' Content='&#xE74D;' ToolTip='移除这个账号' Opacity='0' Margin='0,-6,4,-6'/>" +
      "<Button x:Name='Sure' DockPanel.Dock='Right' Visibility='Collapsed' Cursor='Hand' VerticalAlignment='Center' Margin='0,0,4,0' ToolTip='从列表里拿掉，文件夹（连同它的对话）放进回收站；Token 统计照常保留'>" +
      "<Button.Template><ControlTemplate TargetType='Button'><Border Background='#FF453A' CornerRadius='10' Padding='11,3'><ContentPresenter/></Border></ControlTemplate></Button.Template>" +
      "<TextBlock Text='确认移除' FontSize='12' FontWeight='SemiBold' Foreground='White'/></Button>$head$renew</DockPanel>" +
      "$($lines -join '')$big</StackPanel></Border>")
    $go = $card.FindName('Go')
    $go.Style = $win.FindResource($(if ($rec) { 'Primary' } else { 'Icon' }))
    $go.Tag = $i + 1
    $go.Add_Click({ param($s) Show-Projects $s.Tag })
    # remove: the trash, shown while the pointer is on the card, asks once more (red 确认移除); leaving the card takes it back
    $del = $card.FindName('Del'); $sure = $card.FindName('Sure')
    $del.Style = $win.FindResource('Icon')
    $del.Tag = $sure
    $del.Add_Click({ param($s) $s.Tag.Visibility = 'Visible' })
    $sure.Tag = @{ n = $i + 1; card = $card }
    $sure.Add_Click({
      param($s)
      $Rows.Children.Remove($s.Tag.card) # gone at once: the removal and the refresh after it take a few seconds; a failure brings it back
      Run-Node "remove $($s.Tag.n)" {
        param($out)
        if ("$out" -notmatch '文件夹在回收站里') { Add-Alert @{ kind = 'ask'; info = $true; project = '移除账号'; msg = ("$out".Trim(), '移除时出错了')[-not "$out".Trim()] } }
        $script:limitTold = @{} # kept by account number, which moved
        Refresh
      }
    })
    $card.Tag = $del
    $card.Add_MouseEnter({ param($s) $s.Tag.Opacity = 1 })
    $card.Add_MouseLeave({ param($s) $s.Tag.Opacity = 0; $s.Tag.Tag.Visibility = 'Collapsed' })
    [void]$Rows.Children.Add($card)
  }
  # last: a new account, logged in in a terminal window (claude-multi new); the island reads the accounts again once it's saved
  $add = New-Object Windows.Controls.Button
  $add.Style = $win.FindResource('Text'); $add.Content = '＋ 添加账号'; $add.HorizontalAlignment = 'Left'; $add.Margin = '4,0,0,0'
  $add.Add_Click({ Open-Terminal $env:USERPROFILE 'new'; Collapse })
  [void]$Rows.Children.Add($add)
}

# --- launching ----------------------------------------------------------------------------------
function Show-Projects([int]$n) {
  $ProjTitle.Text = "用 $($script:data.accounts[$n - 1].label.Split('@')[0]) 启动到："
  $ProjList.Children.Clear()
  foreach ($p in @($script:data.projects) + '') {
    $b = New-Object Windows.Controls.Button
    $b.Style = $win.FindResource('Item')
    $b.Tag = @($n, $p)
    $b.Content = if ($p) {
      X "<StackPanel $ns Orientation='Horizontal'><TextBlock Text='$(Esc (Split-Path $p -Leaf))' FontSize='13' FontWeight='SemiBold' MinWidth='120'/><TextBlock Text='$(Esc $p)' FontSize='11' Foreground='#8CFFFFFF' Margin='14,1,0,0' MaxWidth='330' TextTrimming='CharacterEllipsis' VerticalAlignment='Center'/></StackPanel>"
    } else { X "<TextBlock $ns Text='其他文件夹…' FontSize='13' Foreground='#B3FFFFFF'/>" }
    $b.Add_Click({
      param($s)
      $dir = $s.Tag[1]
      if (-not $dir) {
        $dlg = New-Object Windows.Forms.FolderBrowserDialog
        if ($dlg.ShowDialog() -ne 'OK') { return }
        $dir = $dlg.SelectedPath
      }
      Launch $s.Tag[0] $dir
    })
    [void]$ProjList.Children.Add($b)
  }
  $Rows.Visibility = 'Collapsed'; $ProjView.Visibility = 'Visible'; Pop
}
function Show-Rows { $ProjView.Visibility = 'Collapsed'; $Rows.Visibility = 'Visible' }
function Launch([int]$n, [string]$dir) { Open-Terminal $dir "start $n"; Collapse }
function Open-Terminal([string]$dir, [string]$cmdArgs) { # a new Windows Terminal window running claude-multi in $dir
  if ($dir.EndsWith('\')) { $dir += '.' } # "D:\" would escape its closing quote
  Start-Process wt.exe -ArgumentList "-d `"$dir`" node `"$js`" $cmdArgs"
}
# A conversation running in the web service has no window here: a tab joins it (claude-multi attach), or the
# tab that joined it already comes to the front (found by its attach process, like a Claude by its own).
function Open-WebChat([string]$id, [string]$dir) {
  $tab = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { "$($_.CommandLine)" -like "*claude-multi.js* attach $id*" })[0]
  if ($tab) { Focus-Claude ([int]$tab.ProcessId) } else { Open-Terminal $dir "attach $id" }
}
function Web-Pids { try { ConvertFrom-Json ([IO.File]::ReadAllText("$root\web-terms.json")) } catch { @() } } # written by claude-multi web
# Brings up a running Claude's terminal tab: a helper process selects the tab and prints the window, which
# we raise (allowed: the user just clicked us, so we hold the foreground).
function Focus-Claude([int]$claudePid) {
  Run-Async 'powershell.exe' "-NoProfile -ExecutionPolicy Bypass -File `"$self`" -FindWindow $claudePid" {
    param($out)
    $h = 0L
    if ([long]::TryParse("$out".Trim(), [ref]$h) -and $h) {
      $w = [IntPtr]$h
      if ([Native.U]::IsIconic($w)) { [void][Native.U]::ShowWindowAsync($w, 9) } # 9 = SW_RESTORE
      [void][Native.U]::SetForegroundWindow($w)
    }
  } $null
}

function Expand {
  Show-Rows; $Panel.Visibility = 'Visible'; Pop
  [void]$win.Activate() # so a click elsewhere deactivates and collapses it
  if (((Get-Date) - $script:fetched).TotalSeconds -gt 60) { Refresh }
}
function Collapse { $Panel.Visibility = 'Collapsed'; Show-Rows }

# --- notifications ------------------------------------------------------------------------------
# Title of the tab in front when that is a Windows Terminal window, else nothing.
function Front-Tab {
  $h = [Native.U]::GetForegroundWindow(); $p = 0
  [void][Native.U]::GetWindowThreadProcessId($h, [ref]$p)
  try {
    if ((Get-Process -Id $p).ProcessName -ne 'WindowsTerminal') { return $null }
    $A = [Windows.Automation.AutomationElement]
    $sel = $A::FromHandle($h).FindFirst('Descendants', (New-Object Windows.Automation.AndCondition(
      (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)),
      (New-Object Windows.Automation.PropertyCondition([Windows.Automation.SelectionItemPattern]::IsSelectedProperty, $true)))))
    if ($sel) { Bare $sel.Current.Name }
  } catch { $null }
}
# You went to that conversation yourself: its notifications, showing or unread, are done.
function Drop-Seen {
  if (-not ($Alerts.Children.Count + $History.Children.Count)) { return }
  $t = Front-Tab
  if (-not $t) { return }
  foreach ($list in $Alerts, $History) { foreach ($el in @($list.Children)) { if ($el.Uid -eq $t) { $list.Children.Remove($el); Mark-Read $el.DataContext } } }
  if (-not $Alerts.Children.Count) { $Alerts.Visibility = 'Collapsed' }
  Update-Badge
}
function Add-Alert($n) {
  if ((Bare $n.title) -and (Bare $n.title) -eq (Front-Tab)) { Mark-Read $n.id; return } # finished while you were watching it
  $el = New-Alert $n (Get-Date)
  # the latest per conversation, like the web page: a newer one replaces what was waiting
  if ($n.id) { foreach ($list in $Alerts, $History) { foreach ($old in @($list.Children)) { if ($old.DataContext -eq $n.id) { $list.Children.Remove($old) } } } }
  $Alerts.Children.Insert(0, $el)
  while ($Alerts.Children.Count -gt 3) { To-History $Alerts.Children[3] } # pushed out unread
  Update-Badge
  $Alerts.Visibility = 'Visible'
  if ($script:hidden) { Slide $false } # notifications always come down from the edge
  $ask = $n.kind -eq 'ask'
  $until = (Get-Date).AddSeconds($(if ($ask) { 15 } else { 8 }))
  if ($until -gt $script:alertUntil) { $script:alertUntil = $until }
  if ($ask) { [Media.SystemSounds]::Exclamation.Play() } else { [Media.SystemSounds]::Asterisk.Play() }
  Pop
}
# One notification's card; a click goes to its terminal tab and marks it read everywhere.
function New-Alert($n, [datetime]$t) {
  $seen = Bare $n.title
  $ask = $n.kind -eq 'ask'
  # phone-style: tinted round icon (check = done, lock = wants permission), project as the title
  $c = if ($ask) { 'FF9F0A' } else { '30D158' }
  $icon = if ($ask) { '&#xE72E;' } else { '&#xE73E;' } # Segoe MDL2 Lock / CheckMark
  # the conversation's name on top, as on the web page: the folder alone ("ly" for all opened in the home folder) can't tell them apart
  $title = if ($n.title) { $n.title } elseif ($n.project) { $n.project } else { 'Claude' }
  $sub = if ($n.title -and $n.project) { "$($n.project) · $($n.msg)" } else { $n.msg }
  $el = X ("<Grid $ns Margin='0,10,0,2' MinWidth='360'><Grid.ColumnDefinitions><ColumnDefinition Width='40'/><ColumnDefinition/><ColumnDefinition Width='Auto'/></Grid.ColumnDefinitions>" +
    "<Border Width='30' Height='30' CornerRadius='15' Background='#33$c' VerticalAlignment='Top' HorizontalAlignment='Left' Margin='0,1,0,0'>" +
    "<TextBlock Text='$icon' FontFamily='Segoe MDL2 Assets' FontSize='13' Foreground='#$c' HorizontalAlignment='Center' VerticalAlignment='Center'/></Border>" +
    "<StackPanel Grid.Column='1' VerticalAlignment='Center'><TextBlock Text='$(Esc $title)' MaxWidth='460' HorizontalAlignment='Left' FontSize='13' FontWeight='SemiBold' TextTrimming='CharacterEllipsis'/>" +
    "<TextBlock Text='$(Esc $sub)' MaxWidth='460' HorizontalAlignment='Left' FontSize='12' Foreground='#B3FFFFFF' TextWrapping='Wrap' Margin='0,2,0,0'/></StackPanel>" +
    "<TextBlock Grid.Column='2' Text='$(if ($t.Date -eq (Get-Date).Date) { $t.ToString('HH:mm') } else { $t.ToString('M/d HH:mm') })' FontSize='11' Foreground='#8CFFFFFF' Margin='12,2,0,0'/></Grid>")
  $el.Background = 'Transparent' # clickable across its whole width
  $el.Tag = if ($n.action) { $n.action } else { $n.pid } # a notice with something to open (running: the running list)
  $el.DataContext = $n.id # the conversation: read marks are shared with the web page
  $el.Uid = if ($n.info) { 'info' } else { $seen }
  $el.Add_MouseLeftButtonUp({
    param($s, $e)
    $e.Handled = $true
    try {
      # read first: whatever happens next, it's done (gone, whether it was showing or in the unread list)
      Mark-Read $s.DataContext
      $s.Parent.Children.Remove($s)
      if ($Alerts.Children.Count -eq 0) { $Alerts.Visibility = 'Collapsed' }
      Update-Badge
      if ("$($s.Tag)" -eq 'running') { $script:folder = '*'; $script:arranging = $false; Open-Chats; Load-Chats; return }
      # its Claude now, found by the conversation: closed and opened again, it's another process; closed, none
      $p = if ($s.DataContext) { Live-Pid $s.DataContext } else { [int]$s.Tag }
      if ($p -and (Web-Pids) -contains $p) { Open-WebChat $s.DataContext $env:USERPROFILE } elseif ($p) { Focus-Claude $p }
    } catch { Log-Error "click $($s.DataContext): $_" }
  })
  $el
}
# The unread list is the web page's own (claude-multi notes: shared read marks, the latest per
# conversation, gone once you've answered in it): loaded at start, so a restart keeps it, and matched
# again with every usage refresh. Cards still popping stay as they are.
function Load-Unread {
  Run-Node 'notes' {
    param($out)
    try { $list = ConvertFrom-Json $out } catch { return } # not @(): PS 5.1 already hands back a JSON array as one item
    $want = @{}; foreach ($n in $list) { if ($n.id) { $want[$n.id] = 1 } }
    foreach ($el in @($History.Children)) { if ($el.DataContext -and -not $want[$el.DataContext]) { $History.Children.Remove($el) } }
    $have = @{}; foreach ($l in $Alerts, $History) { foreach ($el in $l.Children) { if ($el.DataContext) { $have[$el.DataContext] = 1 } } }
    for ($k = $list.Count - 1; $k -ge 0; $k--) { # oldest first: the newest ends on top
      $n = $list[$k]
      if ($n.id -and -not $have[$n.id]) { $History.Children.Insert(0, (New-Alert $n ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$n.at).LocalDateTime))) }
    }
    Update-Badge
  }
}
# Notifications nobody clicked aren't dropped: they wait, newest first, in the panel's unread list
# (last 10), counted by an orange badge on the pill and an orange rim on the hidden handle.
function To-History($el) { $Alerts.Children.Remove($el); if ($el.Uid -ne 'info') { $History.Children.Insert(0, $el) } }
function Update-Badge {
  while ($History.Children.Count -gt 10) { $History.Children.RemoveAt(10) }
  $n = $History.Children.Count
  $Badge.Text = "$n"
  $HistTitle.Text = "未读 $n"
  $BadgeBox.Visibility = if ($n) { 'Visible' } else { 'Collapsed' }
  $HistoryBox.Visibility = $BadgeBox.Visibility
  Paint-Rim
}
# The hidden handle is a gray sliver, not black: black vanished against dark title bars. Orange rim = unread.
function Paint-Rim {
  $Island.BorderBrush = if ($History.Children.Count) { '#FF9F0A' } elseif ($script:hidden) { '#66FFFFFF' } else { '#1FFFFFFF' }
  $Island.Background = if ($script:hidden) { '#FF48484A' } else { '#F5000000' }
}
function Clear-Alerts {
  while ($Alerts.Children.Count) { To-History $Alerts.Children[$Alerts.Children.Count - 1] } # oldest first: newest ends on top
  $Alerts.Visibility = 'Collapsed'
  Update-Badge
}
# Read marks shared with the web page (claude-multi.js readMarks): one line {id, at} per dismissal.
function Mark-Read($id) {
  if (-not $id) { return }
  try { [IO.File]::AppendAllText("$root\notes-read.jsonl", "{`"id`":`"$id`",`"at`":$([DateTimeOffset]::Now.ToUnixTimeMilliseconds())}`n") }
  catch { Log-Error "mark read $id`: $_" }
}
# what went wrong where nobody sees it (a click's handler, a write): island-errors.log, next to the island
function Log-Error([string]$m) { try { [IO.File]::AppendAllText("$root\island-errors.log", "$(Get-Date -Format 'MM-dd HH:mm:ss') $m`r`n") } catch {} }
# The Claude running a conversation now, by its session files (each account's, and the plain ~\.claude's), 0 if
# none. Its pid must also have started when Claude wrote down: one that didn't exit cleanly leaves its file, and
# Windows soon gives the pid to another program (as claude-multi.js listSessions checks).
function Live-Pid([string]$id) {
  foreach ($f in @(Get-ChildItem "$root\accounts\*\sessions\*.json", "$env:USERPROFILE\.claude\sessions\*.json" -ErrorAction SilentlyContinue)) {
    try { $j = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { continue }
    if ($j.sessionId -ne $id) { continue }
    $p = Get-Process -Id $j.pid -ErrorAction SilentlyContinue
    if ($p -and (-not $j.procStart -or "$($p.StartTime.ToFileTimeUtc())" -eq "$($j.procStart)")) { return [int]$j.pid }
  }
  0
}
function Drop-Read($id) { # '*' = all of them
  foreach ($list in $Alerts, $History) { foreach ($el in @($list.Children)) { if ($el.DataContext -and ($id -eq '*' -or $el.DataContext -eq $id)) { $list.Children.Remove($el) } } }
  if (-not $Alerts.Children.Count) { $Alerts.Visibility = 'Collapsed' }
  Update-Badge
}
# ponytail: polls inbox\ every 300 ms; FileSystemWatcher would need a second runspace to touch the UI
function Check-Inbox {
  foreach ($f in [IO.Directory]::GetFiles($inbox, '*.json')) {
    $n = $null
    try { $n = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch {}
    $age = (Get-Date) - [IO.File]::GetLastWriteTime($f)
    try { [IO.File]::Delete($f) } catch { continue }
    if ($n -and $n.kind -eq 'read') { Drop-Read $n.id; continue } # read on the web page
    if ($n -and $n.kind -eq 'accounts') { Refresh; continue } # claude-multi new saved one
    if ($n -and $n.kind -eq 'front') { [Native.OnTop]::Check($true); if ($script:hidden) { Slide $false }; $script:away = 0; continue } # started again
    if ($n -and $n.kind -eq 'chats' -and $n.tokens) { Open-Tokens; continue } # claude-multi chats tokens
    if ($n -and $n.kind -eq 'chats') { $script:folder = if ($n.arrange) { '*' } else { '' }; $script:arranging = [bool]$n.arrange; Open-Chats; Load-Chats; continue } # claude-multi chats
    if ($n -and $age.TotalMinutes -lt 2) { Add-Alert $n } # older ones were for an island that wasn't running
  }
}

# --- conversation list: the island's look at desktop size, folders on the left, conversations right ---
# Running ones jump to their terminal tab; the others resume in a new one (claude-multi resume). Each row
# shows only title, last prompt and time; the action and its account appear on hover.
$script:chats = @()
$script:folder = '' # '' all, '*' running, else a folder path
$script:chatsAt = [DateTime]::MinValue
function Ago([double]$ms) {
  $t = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$ms).LocalDateTime
  $m = ((Get-Date) - $t).TotalMinutes
  if ($m -lt 1) { '刚刚' } elseif ($m -lt 60) { "$([int][Math]::Floor($m)) 分钟前" }
  elseif ($t.Date -eq (Get-Date).Date) { $t.ToString('HH:mm') }
  elseif ($t.Date -eq (Get-Date).Date.AddDays(-1)) { '昨天 ' + $t.ToString('HH:mm') }
  else { $t.ToString('M月d日') }
}
function Day([double]$ms) {
  $d = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$ms).LocalDateTime.Date
  if ($d -eq (Get-Date).Date) { '今天' } elseif ($d -eq (Get-Date).Date.AddDays(-1)) { '昨天' }
  elseif ($d -gt (Get-Date).Date.AddDays(-7)) { '7 天内' } else { '更早' }
}
# One account to the end: a conversation continues on its own account (the one that wrote it last). Only
# when that one has under an hour left (MIN_RUN in claude-multi.js) and the recommended one has more does a
# dialog offer the switch. Returns the account number, 0 when cancelled.
function Pick-Account($s) {
  $own = [int]$s.acct + 1; $u = $script:data
  if (-not $u -or $null -eq $u.rec -or [int]$u.rec -eq [int]$s.acct) { return $own }
  $a = $u.accounts[$s.acct]; $b = $u.accounts[$u.rec]
  if ($a.err -or $a.runway -ge 1 -or $b.runway -le $a.runway) { return $own }
  Ask-Account $s $own ([int]$u.rec + 1)
}
# Accounts don't share their prompt cache, so the other one reads the whole conversation in again on its
# first reply: worth a question. The choice comes back through the dialog's Tag.
function Ask-Account($s, [int]$own, [int]$other) {
  $a = $script:data.accounts[$own - 1]; $b = $script:data.accounts[$other - 1]
  $why = if ($a.runway -le 0) { "账号 $own 已经到上限了" } else { "账号 $own 只能再连续用约 $($a.runway) 小时" }
  $d = X @"
<Window $ns Width="440" SizeToContent="Height" WindowStyle="None" AllowsTransparency="True" Background="Transparent" ResizeMode="NoResize"
  ShowInTaskbar="False" WindowStartupLocation="CenterOwner" Foreground="White" FontFamily="Segoe UI Variable Text, Microsoft YaHei UI" UseLayoutRounding="True">
 <Window.Resources>$styles</Window.Resources>
 <Grid Margin="16">
  <Border Background="Black" CornerRadius="18"><Border.Effect><DropShadowEffect BlurRadius="24" ShadowDepth="4" Direction="270" Opacity="0.55"/></Border.Effect></Border>
  <Border Background="#FA161618" CornerRadius="18" BorderBrush="#26FFFFFF" BorderThickness="1" Padding="22,20,22,18">
   <StackPanel>
    <TextBlock Text="换个账号继续？" FontSize="16" FontWeight="SemiBold" Foreground="White"/>
    <TextBlock Text="$(Esc $s.title)" FontSize="12" Foreground="#8CFFFFFF" Margin="0,4,0,0" TextTrimming="CharacterEllipsis"/>
    <TextBlock TextWrapping="Wrap" FontSize="13" Foreground="#E6FFFFFF" Margin="0,16,0,0" LineHeight="20"
      Text="$why，账号 $other 还能连续用约 $($b.runway) 小时。"/>
    <TextBlock TextWrapping="Wrap" FontSize="12" Foreground="#8CFFFFFF" Margin="0,8,0,0" LineHeight="18"
      Text="两个账号不共用缓存：换过去后，第一轮回复要把整段对话重新读一遍，会多用一些新账号的额度。"/>
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,20,0,0">
     <Button x:Name="Keep" Style="{StaticResource Text}" FontSize="13" Margin="0,0,10,0" Padding="4,4" Content="仍用账号 $own"/>
     <Button x:Name="Switch" Style="{StaticResource Primary}" FontSize="13" Content="换到账号 $other"/>
    </StackPanel>
   </StackPanel>
  </Border>
 </Grid>
</Window>
"@
  if ($script:cw -and $script:cw.IsVisible) { $d.Owner = $script:cw } else { $d.WindowStartupLocation = 'CenterScreen' }
  $d.FindName('Keep').Tag = $own; $d.FindName('Switch').Tag = $other
  foreach ($k in 'Keep', 'Switch') { $d.FindName($k).Add_Click({ param($x) $w = [Windows.Window]::GetWindow($x); $w.Tag = $x.Tag; $w.Close() }) }
  $d.Add_KeyDown({ param($x, $e) if ($e.Key -eq 'Escape') { $x.Close() } }) # Esc: neither
  $d.Add_MouseLeftButtonDown({ param($x) $x.DragMove() })
  [void]$d.ShowDialog()
  if ($d.Tag) { [int]$d.Tag } else { 0 }
}

function Open-Chats {
  if ($script:cw -and $script:cw.IsVisible) {
    if ($script:cw.WindowState -eq 'Minimized') { $script:cw.WindowState = 'Normal' }
    [void]$script:cw.Activate(); return
  }
  $script:cw = X @"
<Window $ns Title="Claude 对话" Width="980" Height="680" WindowStartupLocation="CenterScreen" ResizeMode="NoResize"
  WindowStyle="None" AllowsTransparency="True" Background="Transparent"
  Foreground="White" FontFamily="Segoe UI Variable Text, Microsoft YaHei UI" UseLayoutRounding="True">
 <Window.Resources>$styles</Window.Resources>
 <Grid Margin="18">
  <!-- shadow on its own layer, so the text above stays sharp -->
  <Border Background="Black" CornerRadius="22"><Border.Effect><DropShadowEffect BlurRadius="28" ShadowDepth="4" Direction="270" Opacity="0.55"/></Border.Effect></Border>
  <Border Background="#F7000000" CornerRadius="22" BorderBrush="#1FFFFFFF" BorderThickness="1">
   <Grid>
    <Grid.RowDefinitions><RowDefinition Height="52"/><RowDefinition/></Grid.RowDefinitions>
    <Grid.ColumnDefinitions><ColumnDefinition x:Name="SideCol" Width="240"/><ColumnDefinition/></Grid.ColumnDefinitions>
    <DockPanel x:Name="Bar" Grid.ColumnSpan="2" Background="Transparent" Margin="22,0,12,0">
     <Button x:Name="Close" Style="{StaticResource Icon}" Content="&#xE711;" ToolTip="关闭（Esc）" DockPanel.Dock="Right" VerticalAlignment="Center"/>
     <Ellipse Width="8" Height="8" Fill="#30D158" VerticalAlignment="Center"/>
     <TextBlock Text="Claude 对话" FontSize="13" FontWeight="SemiBold" Foreground="#CCFFFFFF" Margin="10,0,0,0" VerticalAlignment="Center"/>
    </DockPanel>
    <Border x:Name="Side" Grid.Row="1" BorderBrush="#14FFFFFF" BorderThickness="0,0,1,0" Margin="0,0,0,18">
     <ScrollViewer VerticalScrollBarVisibility="Auto" Margin="12,4,10,0"><StackPanel x:Name="Folders"/></ScrollViewer>
    </Border>
    <DockPanel Grid.Row="1" Grid.Column="1" Margin="28,2,20,16">
     <TextBlock x:Name="Heading" DockPanel.Dock="Top" FontSize="22" FontWeight="SemiBold" TextTrimming="CharacterEllipsis"/>
     <TextBlock x:Name="SubHeading" DockPanel.Dock="Top" FontSize="12" Foreground="#66FFFFFF" Margin="0,3,0,16" TextTrimming="CharacterEllipsis"/>
     <Border x:Name="SearchBox" DockPanel.Dock="Top" Background="#17FFFFFF" CornerRadius="12" Padding="12,8" Margin="0,0,8,10">
      <DockPanel>
       <TextBlock Text="&#xE721;" FontFamily="Segoe MDL2 Assets" FontSize="13" Foreground="#73FFFFFF" VerticalAlignment="Center" Margin="0,0,10,0"/>
       <Grid>
        <TextBlock x:Name="Hint" Text="搜索标题、问过的话或文件夹" Foreground="#4DFFFFFF" FontSize="13" IsHitTestVisible="False" VerticalAlignment="Center"/>
        <TextBox x:Name="Search" Background="Transparent" BorderThickness="0" Foreground="White" CaretBrush="White" FontSize="13" Padding="0" VerticalAlignment="Center"/>
       </Grid>
      </DockPanel>
     </Border>
     <Border x:Name="NewBar" DockPanel.Dock="Bottom" Visibility="Collapsed" BorderBrush="#14FFFFFF" BorderThickness="0,1,0,0" Padding="0,14,8,0" Margin="0,10,0,0">
      <DockPanel>
       <Button x:Name="NewGo" Style="{StaticResource Primary}" FontSize="13" DockPanel.Dock="Left" VerticalAlignment="Top" Margin="0,0,16,0"/>
       <WrapPanel x:Name="NewAccts" VerticalAlignment="Center"/>
      </DockPanel>
     </Border>
     <ScrollViewer VerticalScrollBarVisibility="Auto"><StackPanel x:Name="List" Margin="0,0,8,0"/></ScrollViewer>
    </DockPanel>
   </Grid>
  </Border>
 </Grid>
</Window>
"@
  foreach ($n in 'Bar', 'Close', 'Folders', 'Heading', 'SubHeading', 'Hint', 'Search', 'SearchBox', 'List', 'Side', 'SideCol', 'NewBar', 'NewGo', 'NewAccts') { Set-Variable -Scope Script -Name "c$n" -Value $script:cw.FindName($n) }
  $script:newAcct = 0 # the account picked for 新建对话 in this window; 0: the recommended one
  $cNewGo.Add_Click({ New-Chat })
  $cBar.Add_MouseLeftButtonDown({ $script:cw.DragMove() })
  $cClose.Add_Click({ $script:cw.Close() })
  $script:cw.Add_KeyDown({
    param($x, $e)
    if ($e.Key -ne 'Escape') { return }
    if ($script:arranging -and $script:arr.sel) { $script:arr.sel = $null; Render-List; Say '' } else { $script:cw.Close() } # a pick goes first
  })
  $script:cw.Add_Activated({
    if (((Get-Date) - $script:chatsAt).TotalSeconds -gt 20) { Load-Chats } # running state stays fresh
    if ($script:folder -eq '#tokens' -and ((Get-Date) - $script:tokAt).TotalSeconds -gt 60) { Load-Tokens }
  })
  $cSearch.Add_TextChanged({ $cHint.Visibility = if ($cSearch.Text) { 'Collapsed' } else { 'Visible' }; Render-List })
  $cSubHeading.Text = '读取中…'
  $script:cw.Opacity = 0
  $script:cw.Show()
  $script:cw.BeginAnimation([Windows.Window]::OpacityProperty,
    (New-Object Windows.Media.Animation.DoubleAnimation -ArgumentList 0, 1, (New-Object Windows.Duration ([TimeSpan]::FromMilliseconds(160)))))
}

function Load-Chats {
  $script:chatsAt = Get-Date
  Run-Node 'sessions --json' {
    param($out)
    # not @(...): PowerShell 5.1 hands back a JSON array as one item, which @() would wrap again
    try { $script:chats = ConvertFrom-Json $out } catch { $script:chats = @() }
    Render-Chats
  }
}

function Render-Chats {
  $all = @($script:chats)
  $cFolders.Children.Clear()
  Add-Folder '' '全部对话' $all.Count '&#xE8BD;'
  $running = @($all | Where-Object { $_.pid })
  if ($running.Count) { Add-Folder '*' '运行中' $running.Count '' }
  [void]$cFolders.Children.Add((X "<TextBlock $ns Text='文件夹' FontSize='11' FontWeight='SemiBold' Foreground='#59FFFFFF' Margin='12,16,0,6'/>"))
  foreach ($g in ($all | Group-Object cwd)) { Add-Folder $g.Name (Split-Path $g.Name -Leaf) $g.Count '&#xE8B7;' } # newest folder first
  Render-List
}
function Add-Folder([string]$key, [string]$name, [int]$count, [string]$glyph) {
  $sel = $script:folder -eq $key
  $fg = if ($sel) { 'White' } else { '#A6FFFFFF' }
  $icon = if ($glyph) { "<TextBlock Text='$glyph' FontFamily='Segoe Fluent Icons, Segoe MDL2 Assets' FontSize='14' Foreground='$fg' Width='24' VerticalAlignment='Center'/>" }
    else { "<Ellipse Width='8' Height='8' Fill='#30D158' Margin='2,0,12,0' VerticalAlignment='Center'/>" } # running
  $b = New-Object Windows.Controls.Button
  $b.Style = $script:cw.FindResource('Item')
  $b.HorizontalContentAlignment = 'Stretch'
  $b.Background = if ($sel) { '#24FFFFFF' } else { 'Transparent' }
  $b.Margin = '0,1'
  $b.Tag = $key
  if ($key -and $key -ne '*') { $b.ToolTip = $key }
  $b.Content = X ("<DockPanel $ns><TextBlock DockPanel.Dock='Right' Text='$count' FontSize='11' Foreground='#59FFFFFF' VerticalAlignment='Center' Margin='8,0,2,0'/>" +
    "$icon<TextBlock Text='$(Esc $name)' FontSize='13' Foreground='$fg' FontWeight='$(if ($sel) { 'SemiBold' } else { 'Normal' })' TextTrimming='CharacterEllipsis' VerticalAlignment='Center'/></DockPanel>")
  $b.Add_Click({ param($s) $script:folder = $s.Tag; $script:arranging = $false; Render-Chats })
  [void]$cFolders.Children.Add($b)
}

# A folder's page ends in 新建对话: Claude started there in a new terminal window, on the recommended account unless
# another one is picked on the chips beside it (each with what it can still give).
function Draw-NewBar {
  $show = $script:folder -and $script:folder -notin '*', '#tokens'
  $cNewBar.Visibility = if ($show) { 'Visible' } else { 'Collapsed' }
  if (-not $show) { return }
  $u = $script:data; $accs = @($u.accounts)
  $rec = if ($u -and $null -ne $u.rec) { [int]$u.rec + 1 } else { 1 }
  $n = if ($script:newAcct) { $script:newAcct } else { $rec }
  $cNewGo.Content = "＋ 新建对话 · 账号 $n$(if ($n -eq $rec) { '（推荐）' })"
  $cNewAccts.Children.Clear()
  if ($accs.Count -lt 2) { return }
  for ($i = 0; $i -lt $accs.Count; $i++) {
    $a = $accs[$i]
    $note = if ($a.err) { '读不到额度' } elseif ($a.runway -gt 0) { "可用 $($a.runway)h" } else { '已用满' }
    $chip = X ((Chip-Xaml ($i + 1) "账号 $($i + 1)" $note $false) -replace '^<Border ', "<Border $ns ")
    $chip.ToolTip = $a.label
    $chip.Add_MouseLeftButtonUp({ param($x) $script:newAcct = [int]$x.Tag; Draw-NewBar })
    [void]$cNewAccts.Children.Add($chip)
  }
  Paint-Chips $cNewAccts $n
}
function New-Chat {
  $dir = $script:folder
  $n = if ($script:newAcct) { $script:newAcct } elseif ($script:data -and $null -ne $script:data.rec) { [int]$script:data.rec + 1 } else { 1 }
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Say "这个文件夹已经不在了：$dir"; return }
  Open-Terminal $dir "start $n"
  Say "正在新窗口里用账号 $n 打开 Claude（$(Split-Path $dir -Leaf)），发出第一句话后它会出现在这个列表里"
}

function Render-List {
  Draw-NewBar
  $wide = ($script:folder -eq '*' -and $script:arranging) -or $script:folder -eq '#tokens' # these take the whole window
  $cSideCol.Width = New-Object Windows.GridLength $(if ($wide) { 0 } else { 240 })
  $cSide.Visibility = if ($wide) { 'Collapsed' } else { 'Visible' }
  if ($script:folder -eq '#tokens') { Render-Tokens; return }
  if ($wide) { Render-Arrange; return }
  $cSearchBox.Visibility = 'Visible'; $cSubHeading.TextWrapping = 'NoWrap'
  $all = @($script:chats)
  $items = @(switch ($script:folder) { '' { $all } '*' { $all | Where-Object { $_.pid } } default { $all | Where-Object { $_.cwd -eq $script:folder } } })
  $q = $cSearch.Text.Trim()
  if ($q) { $items = @($items | Where-Object { "$($_.title) $($_.prompt) $($_.cwd)".IndexOf($q, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
  $cHeading.Text = switch ($script:folder) { '' { '全部对话' } '*' { '运行中' } default { Split-Path $script:folder -Leaf } }
  $cSubHeading.Text = (@(if ($script:folder -and $script:folder -ne '*') { $script:folder }) + "$($items.Count) 个对话") -join '   ·   '
  $cList.Children.Clear()
  $running = $script:folder -eq '*'
  if ($running -and $items.Count) { [void]$cList.Children.Add((Arrange-Cta)) }
  $day = $null
  foreach ($s in $items) {
    $d = Day $s.at
    if (-not $running -and $d -ne $day) { [void]$cList.Children.Add((X "<TextBlock $ns Text='$d' FontSize='12' FontWeight='SemiBold' Foreground='#80FFFFFF' Margin='12,$(if ($day) { 18 } else { 4 }),0,6'/>")); $day = $d }
    Add-Chat $s
  }
  if (-not $items.Count) { [void]$cList.Children.Add((X "<TextBlock $ns Text='没有找到对话' FontSize='13' Foreground='#4DFFFFFF' Margin='12,24,0,0'/>")) }
}
# --- token use: a page of the conversation window, opened by the island's chart button -------------
# From `claude-multi tokens --json` (each reply's usage counted once, priced at API rates). The chips on top
# pick all accounts or one, and every number below follows. Heat map: the last 35 weeks, Monday on top, five
# blues by share of the busiest day; bars: the last 30 days, stacked by account when showing them all.
$script:tok = $null
$script:tokAt = [datetime]::MinValue
$script:tokView = 'heat'
$script:tokAcct = -1 # -1 all accounts, else the account's index
$HEAT = '#104281', '#1C5CAB', '#2A78D6', '#5598E7', '#9EC5F4' # one blue, dark surface: brighter = more
$ACCT_COLORS = '#0A84FF', '#FF9F0A', '#BF5AF2', '#30D158'      # the status line's account colors

function Open-Tokens { $script:folder = '#tokens'; $script:arranging = $false; Open-Chats; Render-List; Load-Tokens }
function Load-Tokens {
  Run-Node 'tokens --json' {
    param($out)
    try { $script:tok = ConvertFrom-Json $out; $script:tokAt = Get-Date } catch {}
    if ($script:cw -and $script:folder -eq '#tokens') { Render-List }
  }
}
function Fmt-Tok([double]$n) {
  if ($n -ge 1e8) { '{0:0.##} 亿' -f ($n / 1e8) } elseif ($n -ge 1e4) { '{0:N0} 万' -f ($n / 1e4) } else { '{0:N0}' -f $n }
}
function Fmt-Usd([double]$u) { if ($u -ge 1000) { '${0:N0}' -f $u } else { '${0:N2}' -f $u } }
function Day-View($d) { if ($d -and $script:tokAcct -ge 0) { @($d.by)[$script:tokAcct] } else { $d } } # the chosen account's share
function Day-Total($d) { if ($d) { [double]$d.i + $d.o + $d.cw + $d.cr } else { 0 } }
function Day-Key([datetime]$t) { $t.ToString('yyyy-MM-dd') }
function Tok-Tip([datetime]$t, $raw) {
  $head = "$($t.Month)月$($t.Day)日 周$('一二三四五六日'[([int]$t.DayOfWeek + 6) % 7])"
  $d = Day-View $raw
  if (-not (Day-Total $d)) { return "$head&#10;没有用量" }
  $lines = @($head, "$(Fmt-Tok (Day-Total $d)) Token · 约 $(Fmt-Usd $d.usd)")
  $by = @($raw.by)
  if ($script:tokAcct -lt 0 -and $by.Count -gt 1) { $lines += (@(for ($k = 0; $k -lt $by.Count; $k++) { "账号 $($k + 1) $(Fmt-Tok (Day-Total $by[$k]))" }) -join ' · ') }
  ($lines + "缓存读取 $(Fmt-Tok $d.cr) · 缓存写入 $(Fmt-Tok $d.cw)" + "输出 $(Fmt-Tok $d.o) · 输入 $(Fmt-Tok $d.i)") -join '&#10;'
}

function Render-Tokens {
  $cSearchBox.Visibility = 'Collapsed'
  $cHeading.Text = 'Token 用量'
  $cList.Children.Clear()
  $t = $script:tok
  $cSubHeading.Text = if ($t) { "$(@($t.accounts).Count) 个账号的对话记录   ·   $($script:tokAt.ToString('HH:mm')) 统计" } else { '统计中…第一次要把所有对话记录读一遍，大约几秒' }
  $bar = X ("<DockPanel $ns Margin='0,0,0,14'><Button x:Name='Back' DockPanel.Dock='Right' Content='返回列表' VerticalAlignment='Center'/>" +
    "<StackPanel x:Name='Who' Orientation='Horizontal' VerticalAlignment='Center'/></DockPanel>")
  $back = $bar.FindName('Back'); $back.Style = $script:cw.FindResource('Text')
  $back.Add_Click({ $script:folder = ''; Load-Chats })
  [void]$cList.Children.Add($bar)
  if (-not $t) { return }
  $accts = @($t.accounts)
  if ($script:tokAcct -ge $accts.Count) { $script:tokAcct = -1 }
  for ($k = -1; $k -lt $accts.Count; $k++) { # 全部账号, then one chip per account in its color
    $on = $script:tokAcct -eq $k
    $dot = if ($k -ge 0) { "<Ellipse Width='7' Height='7' Fill='$($ACCT_COLORS[$k % 4])' VerticalAlignment='Center' Margin='0,0,7,0'/>" } else { '' }
    $chip = X ("<Border $ns CornerRadius='10' Padding='12,5' Margin='0,0,6,0' Cursor='Hand' BorderThickness='1' " +
      "Background='$(if ($on) { '#24FFFFFF' } else { '#0DFFFFFF' })' BorderBrush='$(if ($on) { '#99FFFFFF' } else { '#1AFFFFFF' })'>" +
      "<StackPanel Orientation='Horizontal'>$dot<TextBlock Text='$(if ($k -ge 0) { "账号 $($k + 1)" } else { '全部账号' })' FontSize='12' FontWeight='SemiBold' " +
      "Foreground='$(if ($on) { 'White' } else { '#B3FFFFFF' })'/></StackPanel></Border>")
    $chip.Tag = $k
    if ($k -ge 0) { $chip.ToolTip = $accts[$k].label }
    $chip.Add_MouseLeftButtonUp({ param($x) $script:tokAcct = [int]$x.Tag; Render-List })
    [void]$bar.FindName('Who').Children.Add($chip)
  }
  $map = @{}; foreach ($d in @($t.days)) { $map[$d.d] = $d }
  $views = @(foreach ($d in @($t.days)) { Day-View $d })
  $sum = @{ i = 0.0; o = 0.0; cw = 0.0; cr = 0.0; usd = 0.0 }
  foreach ($v in $views) { foreach ($k in 'i', 'o', 'cw', 'cr', 'usd') { $sum[$k] += $v.$k } }
  $all = Day-Total ([pscustomobject]$sum)
  $today = [datetime]::Today
  $tv = Day-View $map[(Day-Key $today)]
  $week = 0.0; $weekUsd = 0.0
  for ($k = 0; $k -lt 7; $k++) { $v = Day-View $map[(Day-Key $today.AddDays(-$k))]; if ($v) { $week += Day-Total $v; $weekUsd += $v.usd } }
  $active = @($views | Where-Object { Day-Total $_ }).Count
  $per = [math]::Max(1, $active)
  $tiles = @(@('累计', $all, $sum.usd, "$active 天有用量"), @('今天', (Day-Total $tv), $(if ($tv) { $tv.usd } else { 0 }), "$($today.Month)月$($today.Day)日"),
    @('近 7 天', $week, $weekUsd, '含今天'), @('日均', ($all / $per), ($sum.usd / $per), '按有用量的天算'))
  $sb = New-Object Text.StringBuilder
  for ($k = 0; $k -lt 4; $k++) {
    [void]$sb.Append("<Border Background='#0FFFFFFF' CornerRadius='14' Padding='16,13' Margin='$(if ($k -lt 3) { '0,0,10,0' } else { '0' })'><StackPanel>" +
      "<TextBlock Text='$($tiles[$k][0])' FontSize='12' Foreground='#8CFFFFFF'/>" +
      "<TextBlock Text='$(Fmt-Tok $tiles[$k][1])' FontSize='24' FontWeight='SemiBold' Margin='0,4,0,0'/>" +
      "<TextBlock Text='约 $(Fmt-Usd $tiles[$k][2])' FontSize='13' FontWeight='SemiBold' Foreground='#D9FFFFFF' Margin='0,2,0,4'/>" +
      "<TextBlock Text='$($tiles[$k][3])' FontSize='11' Foreground='#59FFFFFF'/></StackPanel></Border>")
  }
  [void]$cList.Children.Add((X "<UniformGrid $ns Columns='4' Margin='0,0,0,10'>$sb</UniformGrid>"))
  [void]$cList.Children.Add((X ("<TextBlock $ns FontSize='12' Foreground='#80FFFFFF' Margin='2,0,0,14' TextTrimming='CharacterEllipsis' " +
    "Text='构成：缓存读取 $(Fmt-Tok $sum.cr) · 缓存写入 $(Fmt-Tok $sum.cw) · 输出 $(Fmt-Tok $sum.o) · 输入 $(Fmt-Tok $sum.i)'/>")))

  $card = X ("<Border $ns Background='#0AFFFFFF' CornerRadius='14' Padding='16,14' Margin='0,0,0,12'><StackPanel>" +
    "<DockPanel Margin='0,0,0,14'><Border DockPanel.Dock='Right' Background='#0DFFFFFF' CornerRadius='9' Padding='2' VerticalAlignment='Center'>" +
    "<StackPanel x:Name='Seg' Orientation='Horizontal'/></Border>" +
    "<TextBlock Text='每天用量' FontSize='14' FontWeight='SemiBold' VerticalAlignment='Center'/>" +
    "<TextBlock Text='$(if ($script:tokView -eq 'heat') { '近 35 周' } else { '近 30 天' })' FontSize='12' Foreground='#66FFFFFF' Margin='10,1,0,0' VerticalAlignment='Center'/></DockPanel>" +
    "<ContentControl x:Name='Plot'/></StackPanel></Border>")
  foreach ($v in @(@('heat', '热力图'), @('bar', '柱状图'))) {
    $on = $script:tokView -eq $v[0]
    $b = X ("<Border $ns CornerRadius='7' Padding='12,4' Cursor='Hand' Background='$(if ($on) { '#2EFFFFFF' } else { 'Transparent' })'>" +
      "<TextBlock Text='$($v[1])' FontSize='12' FontWeight='$(if ($on) { 'SemiBold' } else { 'Normal' })' Foreground='$(if ($on) { 'White' } else { '#8CFFFFFF' })'/></Border>")
    $b.Tag = $v[0]
    $b.Add_MouseLeftButtonUp({ param($x) $script:tokView = $x.Tag; Render-List })
    [void]$card.FindName('Seg').Children.Add($b)
  }
  $card.FindName('Plot').Content = if ($script:tokView -eq 'heat') { Heat-Map $map } else { Bar-Chart $map $accts.Count }
  [void]$cList.Children.Add($card)
  [void]$cList.Children.Add((Acct-Card $t))
  [void]$cList.Children.Add((X ("<TextBlock $ns FontSize='11' Foreground='#59FFFFFF' Margin='2,0,0,8' TextWrapping='Wrap' " +
    "Text='金额按 Anthropic API 的公开价格折算（2026 年 6 月价格表），只作参考：订阅账号按套餐收费，不按这个扣钱。'/>")))
}

function Heat-Map($map) {
  $W = 35
  $today = [datetime]::Today
  $start = $today.AddDays(-(([int]$today.DayOfWeek + 6) % 7) - 7 * ($W - 1)) # the Monday W-1 weeks back
  $max = 1.0; for ($k = 0; $k -lt 7 * $W; $k++) { $max = [math]::Max($max, (Day-Total (Day-View $map[(Day-Key $start.AddDays($k))]))) }
  $sb = New-Object Text.StringBuilder
  foreach ($r in 0, 2, 4) { [void]$sb.Append("<TextBlock Grid.Row='$r' Text='$('一三五'[$r / 2])' FontSize='11' Foreground='#59FFFFFF' VerticalAlignment='Center'/>") }
  for ($c = 0; $c -lt $W; $c++) {
    $mon = $start.AddDays(7 * $c)
    if ($mon.Day -le 7) { [void]$sb.Append("<TextBlock Grid.Row='7' Grid.Column='$($c + 1)' Grid.ColumnSpan='3' Text='$($mon.Month)月' FontSize='11' Foreground='#73FFFFFF' VerticalAlignment='Bottom'/>") }
    for ($r = 0; $r -lt 7; $r++) {
      $day = $mon.AddDays($r)
      if ($day -gt $today) { break }
      $d = $map[(Day-Key $day)]; $v = Day-Total (Day-View $d)
      $fill = if ($v) { $HEAT[[math]::Max(0, [math]::Min(4, [math]::Ceiling($v / $max * 5) - 1))] } else { '#14FFFFFF' }
      $ring = if ($day -eq $today) { " BorderBrush='White' BorderThickness='1.5'" } else { '' }
      [void]$sb.Append("<Border Grid.Row='$r' Grid.Column='$($c + 1)' Width='18' Height='18' CornerRadius='4' Background='$fill'$ring " +
        "HorizontalAlignment='Left' VerticalAlignment='Top' ToolTip='$(Tok-Tip $day $d)' ToolTipService.InitialShowDelay='60'/>")
    }
  }
  $legend = "<Border Width='12' Height='12' CornerRadius='3' Background='#14FFFFFF' Margin='3,0'/>" +
    (($HEAT | ForEach-Object { "<Border Width='12' Height='12' CornerRadius='3' Background='$_' Margin='3,0'/>" }) -join '')
  X ("<StackPanel $ns><Grid><Grid.ColumnDefinitions><ColumnDefinition Width='28'/>$("<ColumnDefinition Width='22'/>" * $W)</Grid.ColumnDefinitions>" +
    "<Grid.RowDefinitions>$("<RowDefinition Height='22'/>" * 8)</Grid.RowDefinitions>$sb</Grid>" +
    "<StackPanel Orientation='Horizontal' HorizontalAlignment='Right' Margin='0,8,0,0'><TextBlock Text='少' FontSize='11' Foreground='#73FFFFFF' Margin='0,0,5,0'/>$legend" +
    "<TextBlock Text='多' FontSize='11' Foreground='#73FFFFFF' Margin='5,0,0,0'/></StackPanel></StackPanel>")
}

function Bar-Chart($map, [int]$nAcct) {
  $N = 30; $H = 160; $L = 56; $cwid = 26
  $stack = $script:tokAcct -lt 0 -and $nAcct -gt 1 # all accounts: one segment each, in its color
  $cols = @(if ($stack) { $ACCT_COLORS } elseif ($script:tokAcct -ge 0) { $ACCT_COLORS[$script:tokAcct % 4] } else { '#3987E5' }) # @(): one color stays a list
  $today = [datetime]::Today
  $vals = @(for ($k = 0; $k -lt $N; $k++) { Day-Total (Day-View $map[(Day-Key $today.AddDays($k - $N + 1))]) })
  $max = [math]::Max(1, ($vals | Measure-Object -Maximum).Maximum)
  $p = [math]::Pow(10, [math]::Floor([math]::Log10($max)))
  $top = $p * (@(1, 2, 2.5, 5, 10) | Where-Object { $_ * $p -ge $max } | Select-Object -First 1) # a round axis top
  $sb = New-Object Text.StringBuilder
  foreach ($f in 0, 0.5, 1) {
    $y = [math]::Round($H - $f * $H)
    [void]$sb.Append("<Border Canvas.Left='$L' Canvas.Top='$y' Width='$($N * $cwid)' Height='1' Background='#1AFFFFFF'/>")
    [void]$sb.Append("<TextBlock Canvas.Left='0' Canvas.Top='$($y - 8)' Width='$($L - 10)' TextAlignment='Right' FontSize='11' Foreground='#59FFFFFF' Text='$(if ($f) { Fmt-Tok ($f * $top) } else { '0' })'/>")
  }
  for ($i = 0; $i -lt $N; $i++) {
    $day = $today.AddDays($i - $N + 1); $x = $L + $i * $cwid; $raw = $map[(Day-Key $day)]
    if ($vals[$i]) {
      $parts = if ($stack) { @(foreach ($q in @($raw.by)) { Day-Total $q }) } else { @($vals[$i]) }
      $last = -1; for ($k = 0; $k -lt $parts.Count; $k++) { if ($parts[$k]) { $last = $k } }
      $y = $H
      for ($k = 0; $k -le $last; $k++) {
        if (-not $parts[$k]) { continue }
        $sh = [math]::Max(2, [math]::Round($parts[$k] / $top * $H)) # not $h: PowerShell names ignore case, that is $H
        $gap = if ($k -lt $last -and $sh -gt 3) { 2 } else { 0 }    # the surface shows between stacked segments
        [void]$sb.Append("<Border Canvas.Left='$($x + 4)' Canvas.Top='$($y - $sh)' Width='$($cwid - 8)' Height='$($sh - $gap)' IsHitTestVisible='False' " +
          "CornerRadius='$(if ($k -eq $last) { '4,4,0,0' } else { '0' })' Background='$($cols[$k % $cols.Count])'/>")
        $y -= $sh
      }
    }
    [void]$sb.Append("<Border Canvas.Left='$x' Canvas.Top='0' Width='$cwid' Height='$H' Background='#01FFFFFF' ToolTip='$(Tok-Tip $day $raw)' ToolTipService.InitialShowDelay='60'/>")
    if (($N - 1 - $i) % 5 -eq 0) {
      [void]$sb.Append("<TextBlock Canvas.Left='$($x + $cwid / 2 - 24)' Canvas.Top='$($H + 6)' Width='48' TextAlignment='Center' FontSize='11' Foreground='#73FFFFFF' " +
        "Text='$(if ($i -eq $N - 1) { '今天' } else { "$($day.Month)/$($day.Day)" })'/>")
    }
  }
  $legend = if ($stack) {
    "<StackPanel Orientation='Horizontal' Margin='$L,8,0,0'>" + (@(for ($k = 0; $k -lt $nAcct; $k++) {
      "<Ellipse Width='8' Height='8' Fill='$($ACCT_COLORS[$k % 4])' VerticalAlignment='Center' Margin='0,0,6,0'/><TextBlock Text='账号 $($k + 1)' FontSize='11' Foreground='#99FFFFFF' Margin='0,0,16,0'/>" }) -join '') + '</StackPanel>'
  } else { '' }
  X "<StackPanel $ns HorizontalAlignment='Left'><Canvas Width='$($L + $N * $cwid)' Height='$($H + 24)'>$sb</Canvas>$legend</StackPanel>"
}

function Acct-Card($t) {
  $accts = @($t.accounts)
  $sb = New-Object Text.StringBuilder
  for ($k = 0; $k -lt $accts.Count; $k++) {
    $a = $accts[$k]
    $col = $ACCT_COLORS[$k % 4]
    $pct = if ($t.total) { [math]::Round($a.total / $t.total * 100, 1) } else { 0 }
    [void]$sb.Append("<Grid Margin='0,6'><Grid.ColumnDefinitions><ColumnDefinition Width='300'/><ColumnDefinition/><ColumnDefinition Width='90'/><ColumnDefinition Width='96'/><ColumnDefinition Width='56'/></Grid.ColumnDefinitions>" +
      "<StackPanel Orientation='Horizontal' VerticalAlignment='Center'><Ellipse Width='8' Height='8' Fill='$col' VerticalAlignment='Center'/>" +
      "<TextBlock Text='账号 $($k + 1)' FontSize='13' FontWeight='SemiBold' Margin='10,0,10,0'/><TextBlock Text='$(Esc $a.label)' FontSize='12' Foreground='#66FFFFFF' MaxWidth='210' TextTrimming='CharacterEllipsis' VerticalAlignment='Center'/></StackPanel>" +
      "<Grid Grid.Column='1' Height='6' Margin='8,0,16,0' VerticalAlignment='Center'><Border Background='#14FFFFFF' CornerRadius='3'/>" +
      "<Grid><Grid.ColumnDefinitions><ColumnDefinition Width='$($pct)*'/><ColumnDefinition Width='$(100 - $pct)*'/></Grid.ColumnDefinitions><Border Background='$col' CornerRadius='3'/></Grid></Grid>" +
      "<TextBlock Grid.Column='2' Text='$(Fmt-Tok $a.total)' FontSize='13' FontWeight='SemiBold' TextAlignment='Right' VerticalAlignment='Center'/>" +
      "<TextBlock Grid.Column='3' Text='约 $(Fmt-Usd $a.usd)' FontSize='13' Foreground='#D9FFFFFF' TextAlignment='Right' VerticalAlignment='Center'/>" +
      "<TextBlock Grid.Column='4' Text='$pct%' FontSize='12' Foreground='#73FFFFFF' TextAlignment='Right' VerticalAlignment='Center'/></Grid>")
  }
  X ("<Border $ns Background='#0AFFFFFF' CornerRadius='14' Padding='16,12' Margin='0,0,0,10'><StackPanel>" +
    "<TextBlock Text='按账号' FontSize='14' FontWeight='SemiBold' Margin='0,0,0,6'/>$sb</StackPanel></Border>")
}

# --- arranging: the 运行中 page lays its conversations out in groups ------------------------------
# A group is one piece of screen (a Windows snap group): columns of windows, each window a terminal holding
# one or more conversations as its tabs. Groups start from a chosen shape and grow where a conversation is
# dropped on their ＋ spots, but only into shapes Windows' own snap layouts have (this machine: at most 4).
# Dragging a conversation out leaves its spot empty; only ＋ and 去掉 change a shape. 应用排列 drops the empty
# spots, and a group whose shape changes by that says on its card what it becomes.
$script:arranging = $false
$script:arr = $null # @{ r; c; groups; tray; sel }: groups are lists of columns of windows of conversation ids
$script:edgeEls = @()
$script:press = $null
$script:dropTo = $null
$script:dragEl = $null
$script:line = X "<Border $ns Height='2' CornerRadius='1' Background='White' Margin='0,-4,0,2' IsHitTestVisible='False'/>"
$GROUP_COLORS = '0A84FF', 'FF9F0A', 'BF5AF2', '64D2FF', 'FF375F', 'A2845E'
$SHAPES = @{ '1' = '全屏'; '1,1' = '左右两个'; '1,1,1' = '左中右三个'; '1,2' = '左边一个 + 右边上下两个'; '2,2' = '田字四个' }

function New-L { , (New-Object Collections.Generic.List[object]) }
function New-Group {
  $g = New-L
  for ($c = 0; $c -lt $script:arr.c; $c++) { $col = New-L; for ($r = 0; $r -lt $script:arr.r; $r++) { $col.Add((New-L)) }; $g.Add($col) }
  , $g
}
function Shape-Of($g) { , [int[]]@(foreach ($col in $g) { $col.Count }) }
function Is-Native($counts) { $SHAPES.ContainsKey(($counts -join ',')) }
function Shape-Name($counts) {
  $even = -not @($counts | Where-Object { $_ -ne $counts[0] }).Count
  (@(if ($even) { "$($counts[0])×$($counts.Count)" }) + $SHAPES[($counts -join ',')]) -join ' '
}
function Col-Name([int]$C, [int]$ci) { if ($C -eq 2) { @('左', '右')[$ci] } elseif ($C -eq 3) { @('左', '中', '右')[$ci] } else { '' } }
function Spot-Name($counts, [int]$ci, [int]$ri) {
  $n = (Col-Name $counts.Count $ci) + $(if ($counts[$ci] -eq 2) { @('上', '下')[$ri] } else { '' })
  if ($n) { $n } else { '全屏' }
}
function Chat-Of([string]$id) { @($script:chats | Where-Object { $_.id -eq $id })[0] }
function Find-Chat([string]$id) {
  foreach ($g in $script:arr.groups) { foreach ($col in $g) { foreach ($w in $col) { if ($w.Contains($id)) { return @{ g = $g; col = $col; w = $w } } } } }
  $null
}
function Free-Spots { $n = 0; foreach ($g in $script:arr.groups) { foreach ($col in $g) { foreach ($w in $col) { if (-not $w.Count) { $n++ } } } }; $n }
function Live-Ids { @($script:chats | Where-Object { $_.pid -and -not $_.web } | ForEach-Object { $_.id }) } # web-run ones have no window to place
function Need-Groups { [int][Math]::Max(1, [Math]::Ceiling((Live-Ids).Count / ($script:arr.r * $script:arr.c))) }
# Every conversation still waiting can get a window of its own: if not, one more empty group.
function Grow-Groups { for ($i = Free-Spots; $i -lt $script:arr.tray.Count; $i += $script:arr.r * $script:arr.c) { $script:arr.groups.Add((New-Group)) } }
# Conversations that ended leave the board; newly started ones wait in the tray.
function Sync-Arrange {
  $live = Live-Ids
  if (-not $script:arr) { $script:arr = @{ r = 1; c = 2; groups = (New-L); tray = (New-L); sel = $null } }
  $a = $script:arr
  foreach ($id in $a.tray.ToArray()) { if ($live -notcontains $id) { [void]$a.tray.Remove($id) } }
  foreach ($g in $a.groups) { foreach ($col in $g) { foreach ($w in $col) { foreach ($id in $w.ToArray()) { if ($live -notcontains $id) { [void]$w.Remove($id) } } } } }
  foreach ($id in $live) { if (-not $a.tray.Contains($id) -and -not (Find-Chat $id)) { $a.tray.Add($id) } }
  if ($a.sel -and $live -notcontains $a.sel) { $a.sel = $null }
  if (-not $a.groups.Count) { for ($i = 0; $i -lt (Need-Groups); $i++) { $a.groups.Add((New-Group)) } }
  Grow-Groups
}
function Say([string]$t) { $cSubHeading.TextWrapping = 'Wrap'; $cSubHeading.Text = $t }

# spot: 'tray', 'c:group,column,row' a window, 'L:group' / 'R:group' / 'I:group,column' a new column (left, right, between), 'B:group,column' a new window
# under that column. $index: where among the window's tabs, $null for the end.
function Move-Chat([string]$id, [string]$spot, $index) {
  $a = $script:arr
  $src = Find-Chat $id
  $made = ''
  if ($spot -eq 'tray') { $dst = $a.tray }
  else {
    $kind, $rest = $spot -split ':'
    $n = @($rest -split ',' | ForEach-Object { [int]$_ })
    $g = $a.groups[$n[0]]
    switch ($kind) {
      'c' { $dst = $g[$n[1]][$n[2]] }
      'L' { $dst = New-L; $col = New-L; $col.Add($dst); $g.Insert(0, $col); $made = '左边' }
      'R' { $dst = New-L; $col = New-L; $col.Add($dst); $g.Add($col); $made = '右边' }
      'I' { $dst = New-L; $col = New-L; $col.Add($dst); $g.Insert($n[1], $col); $made = '中间' }
      'B' { $dst = New-L; $C = $g.Count; $g[$n[1]].Add($dst); $made = if ($C -eq 1) { '下面' } else { "$(Col-Name $C $n[1])列下面" } }
    }
  }
  if ($src) { [void]$src.w.Remove($id) } else { [void]$a.tray.Remove($id) }
  if ($null -eq $index -or $index -gt $dst.Count) { $dst.Add($id) } else { $dst.Insert($index, $id) }
  $a.sel = $null
  Render-List
  $t = "「$((Chat-Of $id).title)」"
  $at = Find-Chat $id
  if (-not $at) { Say "$t 放回了待放入"; return }
  $gi = $a.groups.IndexOf($at.g) + 1; $counts = Shape-Of $at.g
  $p = Spot-Name $counts $at.g.IndexOf($at.col) $at.col.IndexOf($at.w)
  Say $(if ($made) { "$t 加在了组 $gi 的$made，组 $gi 变成 $(Shape-Name $counts)" }
    elseif ($at.w.Count -gt 1) { "$t 叠进了组 $gi $p的窗口，现在有 $($at.w.Count) 个标签页" }
    else { "$t 放进了组 $gi 的$p" })
}
# What 应用排列 makes of a group: its empty spots dropped, and a shape Windows lacks turned into the one it has
# (left stacked + right whole mirrored, one stacked column as left and right). $null when nothing's placed.
function Live-Group($g) {
  $live = New-L
  foreach ($col in $g) { $lc = New-L; foreach ($w in $col) { if ($w.Count) { $lc.Add($w) } }; if ($lc.Count) { $live.Add($lc) } }
  if (-not $live.Count) { return $null }
  $note = switch ((Shape-Of $live) -join ',') {
    '2,1' { $live.Reverse(); '左右两列会对调' }
    '2' { $top = $live[0][0]; $bottom = $live[0][1]; $live.Clear(); foreach ($w in $top, $bottom) { $c = New-L; $c.Add($w); $live.Add($c) }; '上下两个会改成左右' }
  }
  @{ g = $live; note = $note }
}
# An empty spot can go when the shape left is one Windows has, so nothing ever has to be flipped around; a
# group's last spot when no waiting conversation needs it.
function Spot-Removable($g, [int]$ci) {
  $counts = Shape-Of $g
  if (($counts | Measure-Object -Sum).Sum -eq 1) { return $script:free - 1 -ge $script:arr.tray.Count }
  Is-Native @(for ($j = 0; $j -lt $counts.Count; $j++) { $n = $counts[$j] - [int]($j -eq $ci); if ($n) { $n } })
}
function Remove-Spot([int]$k, [int]$ci, [int]$ri) {
  $g = $script:arr.groups[$k]
  $g[$ci].RemoveAt($ri)
  if (-not $g[$ci].Count) { $g.RemoveAt($ci) }
  if (-not $g.Count) { $script:arr.groups.RemoveAt($k) }
  Render-List
  Say '去掉了一个空位'
}
# Windows already arranged (tabs kept) poured into fresh groups of the starting shape, reading order.
function Pour-Windows($wins) {
  $a = $script:arr; $per = $a.r * $a.c
  $a.groups = New-L
  for ($i = 0; $i -lt [Math]::Max((Need-Groups), [Math]::Ceiling($wins.Count / $per)); $i++) { $a.groups.Add((New-Group)) }
  for ($j = 0; $j -lt $wins.Count; $j++) { $q = $j % $per; $a.groups[[int][Math]::Floor($j / $per)][$q % $a.c][[int][Math]::Floor($q / $a.c)] = $wins[$j] }
}
function Placed-Windows { $wins = New-L; foreach ($g in $script:arr.groups) { foreach ($col in $g) { foreach ($w in $col) { if ($w.Count) { $wins.Add($w) } } } }; , $wins }
function Set-Start([int]$r, [int]$c) {
  $a = $script:arr
  if ($a.r -eq $r -and $a.c -eq $c) { return }
  $wins = Placed-Windows
  $a.r = $r; $a.c = $c; $a.sel = $null
  Pour-Windows $wins
  Render-List
  Say "起始形状换成 $r×$c$(if ($wins.Count) { '，放好的窗口按原来的顺序重新排进去，叠好的标签页不变' })"
}
# 一键放入: the waiting ones into the empty spots, group by group in reading order, each its own window; with
# $byFolder the ones from one folder stacked as tabs in one window. What's already placed stays put.
function Fill-Tray([bool]$byFolder) {
  $a = $script:arr
  $wins = New-L; $byDir = @{}
  foreach ($id in $a.tray) {
    $dir = (Chat-Of $id).cwd
    if ($byFolder -and $byDir.ContainsKey($dir)) { $byDir[$dir].Add($id); continue }
    $w = New-L; $w.Add($id); $wins.Add($w); $byDir[$dir] = $w
  }
  while ((Free-Spots) -lt $wins.Count) { $a.groups.Add((New-Group)) }
  $i = 0
  foreach ($g in $a.groups) {
    $rows = ($g | ForEach-Object { $_.Count } | Measure-Object -Maximum).Maximum
    for ($r = 0; $r -lt $rows; $r++) {
      foreach ($col in $g) { if ($i -lt $wins.Count -and $r -lt $col.Count -and -not $col[$r].Count) { foreach ($id in $wins[$i]) { $col[$r].Add($id) }; $i++ } }
    }
  }
  $n = $a.tray.Count
  $a.tray.Clear(); $a.sel = $null
  Render-List
  Say $(if ($byFolder) { "放好了 $n 个，同一个文件夹的叠成了标签页，可以再拖动微调" } else { "放好了 $n 个，每个单独一个窗口，可以再拖动微调" })
}
function Reset-Arrange {
  $a = $script:arr
  $a.tray = New-L; foreach ($id in Live-Ids) { $a.tray.Add($id) }
  $a.groups = New-L; for ($i = 0; $i -lt (Need-Groups); $i++) { $a.groups.Add((New-Group)) }
  $a.sel = $null
  Render-List
  Say '都拿出来了'
}

# The plan for the helper: per group its live form's shape and windows (column by column, top to bottom), each
# window the PIDs of its conversations in tab order.
function Apply-Arrange {
  if ($script:applying) { return } # one run at a time: two would fight over the same windows
  $a = $script:arr
  $pidOf = @{}; foreach ($s in @($script:chats)) { if ($s.pid) { $pidOf[$s.id] = $s.pid } }
  $parts = @()
  foreach ($g in $a.groups) {
    $lg = Live-Group $g
    if (-not $lg) { continue }
    $wins = foreach ($col in $lg.g) { foreach ($w in $col) { '[' + (@($w | ForEach-Object { $pidOf[$_] } | Where-Object { $_ }) -join ',') + ']' } } # one that ended since: gone
    $parts += '{"shape":[' + ((Shape-Of $lg.g) -join ',') + '],"wins":[' + (@($wins) -join ',') + ']}'
  }
  if (-not $parts.Count) { Say '还没有对话放进组里：先拖一个进去'; return }
  $file = Join-Path $env:TEMP 'claude-multi-arrange.json'
  [IO.File]::WriteAllText($file, '[' + ($parts -join ',') + ']', (New-Object Text.UTF8Encoding $false))
  Say '正在排列，几秒钟内先别动键盘鼠标…'
  $script:applying = $true
  $script:cw.WindowState = 'Minimized' # out of the way of Snap Assist and of the result
  Run-Async 'powershell.exe' "-NoProfile -ExecutionPolicy Bypass -File `"$self`" -Arrange `"$file`"" { param($out) Arranged $out } $null
}
function Arranged([string]$out) {
  $script:applying = $false
  $r = $null
  try { $r = ("$out".Trim() -split "`n")[-1] | ConvertFrom-Json } catch {}
  if (-not $r) { $msg = '排列中途出错了，窗口可能只挪了一部分' }
  else {
    $parts = @()
    if ($r.snapped) { $parts += "$($r.snapped) 组排好了" }
    if ($r.gapped) { $parts += "$($r.gapped) 组少了对话，按位置摆好了，没拼成一个整体" }
    if ($r.placed) { $parts += "$($r.placed) 组按位置摆好了，但没拼成一个整体" }
    if ($r.moved) { $parts += "移动了 $($r.moved) 个标签页" }
    $skipped = @($r.skipped | Where-Object { $_ })
    if ($skipped.Count) { $parts += "$($skipped.Count) 个对话找不到它的标签，没动" }
    if ($r.unmerged) { $parts += 'Windows Terminal 的设置文件带注释，没法叠标签页' }
    $msg = $parts -join '；'
    if (-not $msg) { $msg = '没有需要挪动的窗口' }
  }
  Say $msg
  Add-Alert @{ project = '窗口排好了'; msg = $msg; kind = 'done'; info = $true }
}

# --- arranging: drawing ----------------------------------------------------------------------------
function Render-Arrange {
  Sync-Arrange
  $cSearchBox.Visibility = 'Collapsed'
  $cHeading.Text = '排列窗口'
  $cSubHeading.Text = "$((Live-Ids).Count) 个对话" # what an action says replaces it
  $cList.Children.Clear()
  $script:edgeEls = @()
  $script:free = Free-Spots
  [void]$cList.Children.Add((Arrange-Toolbar))
  [void]$cList.Children.Add((Tray-Box))
  # two columns that size themselves to the window; a three-column group takes a whole row
  $grid = New-Object Windows.Controls.Grid
  foreach ($i in 1, 2) { $grid.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition)) }
  $row = -1; $at = 2
  foreach ($el in @(for ($k = 0; $k -lt $script:arr.groups.Count; $k++) { Group-Card $k }) + (Add-Group-Tile)) {
    $wide = $el.Tag -eq 'wide'
    if ($wide -or $at -ge 2) { $row++; $at = 0; $rd = New-Object Windows.Controls.RowDefinition; $rd.Height = [Windows.GridLength]::Auto; $grid.RowDefinitions.Add($rd) }
    [Windows.Controls.Grid]::SetRow($el, $row); [Windows.Controls.Grid]::SetColumn($el, $at)
    if ($wide) { [Windows.Controls.Grid]::SetColumnSpan($el, 2); $el.Margin = '0,0,0,12'; $at = 2 }
    else { $el.Margin = $(if ($at) { '6,0,0,12' } else { '0,0,6,12' }); $at++ }
    [void]$grid.Children.Add($el)
  }
  [void]$cList.Children.Add($grid)
}
function Arrange-Cta {
  $el = X ("<Border $ns Background='#0FFFFFFF' CornerRadius='12' Padding='14,10' Margin='0,0,0,12'><DockPanel>" +
    "<Button x:Name='Go' DockPanel.Dock='Right' Content='排列窗口' VerticalAlignment='Center' Margin='12,0,0,0'/>" +
    "<TextBlock Text='&#xE8A9;' FontFamily='Segoe Fluent Icons, Segoe MDL2 Assets' FontSize='18' Foreground='#CCFFFFFF' VerticalAlignment='Center' Margin='2,0,14,0'/>" +
    "<StackPanel VerticalAlignment='Center'><TextBlock Text='把运行中的对话拼成整齐的窗口组' FontSize='13' FontWeight='SemiBold'/>" +
    "<TextBlock Text='一组拼满一块屏幕，同一个窗口里还能叠多个对话当标签页' FontSize='12' Foreground='#80FFFFFF' Margin='0,2,0,0' TextTrimming='CharacterEllipsis'/></StackPanel></DockPanel></Border>")
  $go = $el.FindName('Go'); $go.Style = $script:cw.FindResource('Primary')
  $go.Add_Click({ $script:arranging = $true; Render-List })
  $el
}
function Arrange-Toolbar {
  $a = $script:arr
  $bar = X ("<StackPanel $ns Margin='0,0,0,18'><DockPanel>" +
    "<Button x:Name='Go' DockPanel.Dock='Right' Content='应用排列' VerticalAlignment='Center'/>" +
    "<Button x:Name='Back' DockPanel.Dock='Right' Content='返回列表' VerticalAlignment='Center' Margin='0,0,10,0'/>" +
    "<TextBlock Text='起始形状' FontSize='12' Foreground='#80FFFFFF' VerticalAlignment='Center' Margin='0,0,12,0'/>" +
    "<StackPanel x:Name='W' Orientation='Horizontal' VerticalAlignment='Center'/></DockPanel></StackPanel>")
  $w = $bar.FindName('W')
  foreach ($p in @(@(1, 2), @(1, 3), @(2, 2), @(1, 1))) {
    $r = $p[0]; $c = $p[1]; $on = $r -eq $a.r -and $c -eq $a.c
    $cells = "<Border Margin='1' CornerRadius='1.5' Background='$(if ($on) { '#F2FFFFFF' } else { '#4DFFFFFF' })'/>" * ($r * $c)
    $b = X ("<Border $ns CornerRadius='10' Padding='9,6' Margin='0,0,6,0' Cursor='Hand' BorderThickness='1' " +
      "Background='$(if ($on) { '#24FFFFFF' } else { '#0DFFFFFF' })' BorderBrush='$(if ($on) { '#99FFFFFF' } else { '#1AFFFFFF' })'>" +
      "<StackPanel Orientation='Horizontal'><UniformGrid Rows='$r' Columns='$c' Width='24' Height='15' VerticalAlignment='Center'>$cells</UniformGrid>" +
      "<TextBlock Text='$r×$c' FontSize='12' FontWeight='SemiBold' Foreground='$(if ($on) { 'White' } else { '#B3FFFFFF' })' Margin='8,0,0,0' VerticalAlignment='Center'/></StackPanel></Border>")
    $b.Tag = "$r,$c"
    $b.ToolTip = $SHAPES[((@($r) * $c) -join ',')]
    $b.Add_MouseLeftButtonUp({ param($x) $p = @($x.Tag -split ',' | ForEach-Object { [int]$_ }); Set-Start $p[0] $p[1] })
    [void]$w.Children.Add($b)
  }
  $bar.FindName('Go').Style = $script:cw.FindResource('Primary')
  $bar.FindName('Back').Style = $script:cw.FindResource('Text')
  $bar.FindName('Go').Add_Click({ Apply-Arrange })
  $bar.FindName('Back').Add_Click({ $script:arranging = $false; $script:arr.sel = $null; Render-List })
  $bar
}
function Tray-Box {
  $a = $script:arr
  $el = X ("<Grid $ns Margin='0,0,0,18' Background='Transparent' MinHeight='70'>" +
    "<Rectangle x:Name='F' RadiusX='12' RadiusY='12' Stroke='#33FFFFFF' StrokeThickness='1' StrokeDashArray='4 3' Fill='#08FFFFFF'/>" +
    "<DockPanel Margin='14,10,8,8'><DockPanel DockPanel.Dock='Top' Margin='0,0,0,10'><StackPanel x:Name='B' DockPanel.Dock='Right' Orientation='Horizontal'/>" +
    "<TextBlock Text='待放入' FontSize='13' FontWeight='SemiBold' VerticalAlignment='Center'/>" +
    "<TextBlock Text='$(if ($a.tray.Count) { "$($a.tray.Count) 个" })' FontSize='12' Foreground='#66FFFFFF' Margin='8,0,0,0' VerticalAlignment='Center'/></DockPanel>" +
    "<WrapPanel x:Name='L'/></DockPanel></Grid>")
  $btns = $el.FindName('B')
  $acts = @(if ($a.tray.Count) { @('一键放入', { Fill-Tray $false }, ''), @('同文件夹叠一起', { Fill-Tray $true }, 'Text') } else { , @('全部拿出来', { Reset-Arrange }, 'Text') })
  foreach ($t in $acts) {
    $b = New-Object Windows.Controls.Button
    $b.Content = $t[0]; $b.Margin = '8,0,0,0'; $b.VerticalAlignment = 'Center'
    if ($t[2]) { $b.Style = $script:cw.FindResource($t[2]) }
    $b.Add_Click($t[1])
    [void]$btns.Children.Add($b)
  }
  $list = $el.FindName('L')
  foreach ($id in $a.tray) { $c = New-Chip $id 'tray'; $c.Width = 200; $c.Margin = '0,0,8,6'; [void]$list.Children.Add($c) }
  if (-not $a.tray.Count) { [void]$list.Children.Add((X "<TextBlock $ns Text='都放好了；想调整就把对话拖回这里' FontSize='12' Foreground='#4DFFFFFF' Margin='0,0,0,6'/>")) }
  $el.Tag = @{ spot = 'tray'; frame = $el.FindName('F'); color = 'FFFFFF' }
  Make-Target $el
  $el
}
function Group-Card([int]$k) {
  $g = $script:arr.groups[$k]; $counts = Shape-Of $g; $col = $GROUP_COLORS[$k % $GROUP_COLORS.Count]
  $spots = 0; $used = 0; foreach ($c in $g) { foreach ($w in $c) { $spots++; if ($w.Count) { $used++ } } }
  $card = X ("<Border $ns CornerRadius='14' Background='#0AFFFFFF' BorderBrush='#59$col' BorderThickness='1' Padding='10,9,10,4'><DockPanel>" +
    "<DockPanel DockPanel.Dock='Top' Margin='2,0,2,9'><TextBlock DockPanel.Dock='Right' Text='$used/$spots 个窗口' FontSize='11' Foreground='#66FFFFFF' VerticalAlignment='Center'/>" +
    "<Ellipse Width='8' Height='8' Fill='#$col' VerticalAlignment='Center'/><TextBlock Text='组 $($k + 1)' FontSize='13' FontWeight='SemiBold' Margin='8,0,0,0' VerticalAlignment='Center'/>" +
    "<TextBlock Text='$(Shape-Name $counts)' FontSize='12' Foreground='#73FFFFFF' Margin='8,0,0,0' VerticalAlignment='Center' TextTrimming='CharacterEllipsis'/></DockPanel>" +
    "<TextBlock x:Name='Then' DockPanel.Dock='Top' FontSize='11' Foreground='#E6FFD60A' Margin='2,-3,2,9' TextWrapping='Wrap' Visibility='Collapsed'/>" +
    "<Grid x:Name='S'/></DockPanel></Border>")
  if ($counts.Count -ge 3) { $card.Tag = 'wide' }
  $lg = Live-Group $g
  if ($lg -and (((Shape-Of $lg.g) -join ',') -ne ($counts -join ',') -or $lg.note)) {
    $then = $card.FindName('Then')
    $then.Text = "应用后变成：$(Shape-Name (Shape-Of $lg.g))$(if ($lg.note) { "（$($lg.note)）" })，空着的位置会去掉"
    $then.Visibility = 'Visible'
  }
  $screen = $card.FindName('S')
  $side = Is-Native (@($counts) + 1)
  $at = 0
  if ($side) { Add-Column $screen 'auto' (New-Edge "L:$k" '左边' $true $col) ([ref]$at) }
  for ($ci = 0; $ci -lt $g.Count; $ci++) {
    if ($ci) {
      $ins = [Collections.Generic.List[int]]$counts; $ins.Insert($ci, 1)
      if (Is-Native $ins) { Add-Column $screen 'auto' (New-Edge "I:$k,$ci" '中间' $true $col) ([ref]$at) }
    }
    $cg = New-Object Windows.Controls.Grid
    if ($ci) { $cg.Margin = '6,0,0,0' }
    for ($ri = 0; $ri -lt $g[$ci].Count; $ri++) {
      $cg.RowDefinitions.Add((New-Object Windows.Controls.RowDefinition))
      $cell = New-Cell $k $ci $ri $g[$ci][$ri] $counts $col
      [Windows.Controls.Grid]::SetRow($cell, $ri); [void]$cg.Children.Add($cell)
    }
    $grown = [int[]]$counts.Clone(); $grown[$ci]++
    if (Is-Native $grown) {
      $rd = New-Object Windows.Controls.RowDefinition; $rd.Height = [Windows.GridLength]::Auto; $cg.RowDefinitions.Add($rd)
      $e = New-Edge "B:$k,$ci" '放下面' $false $col
      [Windows.Controls.Grid]::SetRow($e, $g[$ci].Count); [void]$cg.Children.Add($e)
    }
    Add-Column $screen 'star' $cg ([ref]$at)
  }
  if ($side) { Add-Column $screen 'auto' (New-Edge "R:$k" '右边' $true $col) ([ref]$at) }
  $card
}
function Add-Column($grid, [string]$kind, $el, [ref]$at) {
  $cd = New-Object Windows.Controls.ColumnDefinition
  if ($kind -eq 'auto') { $cd.Width = [Windows.GridLength]::Auto }
  $grid.ColumnDefinitions.Add($cd)
  [Windows.Controls.Grid]::SetColumn($el, $at.Value); [void]$grid.Children.Add($el)
  $at.Value++
}
function New-Cell([int]$k, [int]$ci, [int]$ri, $w, $counts, [string]$col) {
  $spot = "c:$k,$ci,$ri"
  $canDrop = -not $w.Count -and (Spot-Removable $script:arr.groups[$k] $ci)
  $right = if ($w.Count -gt 1) { "<TextBlock DockPanel.Dock='Right' Text='$($w.Count) 个标签页' FontSize='11' Foreground='#$col'/>" }
    elseif ($canDrop) { "<TextBlock x:Name='X' DockPanel.Dock='Right' Text='去掉' FontSize='11' Foreground='#80FFFFFF' Cursor='Hand' ToolTip='去掉这个空位'><TextBlock.Style><Style TargetType='TextBlock'>" +
      "<Setter Property='Opacity' Value='0'/><Style.Triggers><DataTrigger Binding='{Binding IsMouseOver, RelativeSource={RelativeSource AncestorType=Grid}}' Value='True'>" +
      "<Setter Property='Opacity' Value='1'/></DataTrigger></Style.Triggers></Style></TextBlock.Style></TextBlock>" }
  $el = X ("<Grid $ns MinHeight='96' Margin='0,0,0,6' Background='Transparent'>" +
    "<Rectangle x:Name='F' RadiusX='9' RadiusY='9' Fill='#0DFFFFFF' Stroke='$(if ($w.Count) { '#1FFFFFFF' } else { '#33FFFFFF' })' StrokeThickness='1'$(if (-not $w.Count) { " StrokeDashArray='4 3'" })/>" +
    "<DockPanel Margin='8,6,8,2'><DockPanel DockPanel.Dock='Top' Margin='2,0,2,6'>$right<TextBlock Text='$(Spot-Name $counts $ci $ri)' FontSize='11' Foreground='#66FFFFFF'/></DockPanel>" +
    "<StackPanel x:Name='L'>$(if (-not $w.Count) { "<TextBlock Text='拖到这里' FontSize='12' Foreground='#40FFFFFF' HorizontalAlignment='Center' Margin='0,12,0,0'/>" })</StackPanel></DockPanel></Grid>")
  $list = $el.FindName('L')
  foreach ($id in $w) { [void]$list.Children.Add((New-Chip $id $spot)) }
  $el.Tag = @{ spot = $spot; frame = $el.FindName('F'); color = $col; list = $list }
  Make-Target $el
  $x = $el.FindName('X')
  if ($x) {
    $x.Tag = "$k,$ci,$ri"
    $x.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; $p = @($s.Tag -split ',' | ForEach-Object { [int]$_ }); Remove-Spot $p[0] $p[1] $p[2] })
  }
  $el
}
# ＋ spots: hidden until a conversation is picked up or selected.
function New-Edge([string]$spot, [string]$text, [bool]$vertical, [string]$col) {
  $label = if ($vertical) { '＋&#10;' + (($text.ToCharArray()) -join '&#10;') } else { "＋ $text" }
  $size = if ($vertical) { "Width='30' Margin='$(if ($spot -like 'L:*') { '0,0,6,6' } else { '6,0,0,6' })'" } else { "Height='30' Margin='0,0,0,6'" }
  $el = X ("<Grid $ns Background='Transparent' $size>" +
    "<Rectangle x:Name='F' RadiusX='8' RadiusY='8' Stroke='#40FFFFFF' StrokeThickness='1' StrokeDashArray='4 3' Fill='Transparent'/>" +
    "<TextBlock Text='$label' FontSize='11' Foreground='#80FFFFFF' HorizontalAlignment='Center' VerticalAlignment='Center' TextAlignment='Center'/></Grid>")
  $el.Tag = @{ spot = $spot; frame = $el.FindName('F'); color = $col }
  $el.Visibility = if ($script:arr.sel) { 'Visible' } else { 'Collapsed' }
  Make-Target $el
  $script:edgeEls += $el
  $el
}
function Add-Group-Tile {
  $el = X ("<Grid $ns Height='118' Cursor='Hand' Background='Transparent'>" +
    "<Rectangle RadiusX='14' RadiusY='14' Stroke='#2EFFFFFF' StrokeThickness='1' StrokeDashArray='4 3'/>" +
    "<TextBlock Text='＋ 再加一组' FontSize='12' Foreground='#80FFFFFF' HorizontalAlignment='Center' VerticalAlignment='Center'/></Grid>")
  $el.Add_MouseLeftButtonUp({ $script:arr.groups.Add((New-Group)); Render-List; Say "加了组 $($script:arr.groups.Count)" })
  $el
}
function New-Chip([string]$id, [string]$spot) {
  $s = Chat-Of $id
  $on = $script:arr.sel -eq $id
  $el = X ("<Border $ns CornerRadius='8' Background='#1FFFFFFF' BorderBrush='$(if ($on) { 'White' } else { 'Transparent' })' BorderThickness='1' Padding='10,6' Margin='0,0,0,6' Cursor='Hand'>" +
    "<StackPanel><TextBlock Text='$(Esc $s.title)' FontSize='13' FontWeight='SemiBold' TextTrimming='CharacterEllipsis'/>" +
    "<TextBlock Text='$(Esc (Split-Path $s.cwd -Leaf)) · 账号 $([int]$s.acct + 1)' FontSize='11' Foreground='#80FFFFFF' TextTrimming='CharacterEllipsis' Margin='0,2,0,0'/></StackPanel></Border>")
  $el.Tag = @{ id = $id; spot = $spot }
  $el.ToolTip = $s.title
  $el.Add_MouseEnter({ param($x) $x.Background = '#2EFFFFFF' })
  $el.Add_MouseLeave({ param($x) $x.Background = '#1FFFFFFF' })
  $el.Add_PreviewMouseLeftButtonDown({ param($x, $e) $script:press = @{ el = $x; at = $e.GetPosition($script:cw) }; [void]$x.CaptureMouse() })
  $el.Add_MouseMove({
    param($x, $e)
    if (-not $script:press -or $script:press.el -ne $x -or $e.LeftButton -ne 'Pressed') { return }
    $p = $e.GetPosition($script:cw)
    if ([Math]::Abs($p.X - $script:press.at.X) + [Math]::Abs($p.Y - $script:press.at.Y) -gt 6) { Start-Drag $x }
  })
  $el.Add_MouseLeftButtonUp({
    param($x, $e)
    if (-not $script:press -or $script:press.el -ne $x) { return }
    $script:press = $null; $x.ReleaseMouseCapture(); $e.Handled = $true
    Chip-Click $x
  })
  $el
}
# A press that doesn't move picks the conversation; with one picked, a press on a placed one stacks it there.
function Chip-Click($x) {
  $a = $script:arr; $id = $x.Tag.id
  if ($a.sel -and $a.sel -ne $id -and $x.Tag.spot -ne 'tray') { Move-Chat $a.sel $x.Tag.spot $null; return }
  $a.sel = if ($a.sel -eq $id) { $null } else { $id }
  Render-List
  if ($a.sel) { Say "选中了「$((Chat-Of $id).title)」：点一个位置放进去，或者点组边上的 ＋ 加一个窗口" } else { Say '' }
}
function Start-Drag($x) {
  $script:press = $null; $x.ReleaseMouseCapture()
  $script:dropTo = $null; $script:dragEl = $x
  foreach ($e in $script:edgeEls) { $e.Visibility = 'Visible' }
  $x.Opacity = 0.35
  try { [void][Windows.DragDrop]::DoDragDrop($x, [string]$x.Tag.id, [Windows.DragDropEffects]::Move) } catch {}
  $x.Opacity = 1; $script:dragEl = $null; Hide-Line
  if ($script:dropTo) { Move-Chat $x.Tag.id $script:dropTo.spot $script:dropTo.index } else { Render-List }
}
function Make-Target($el) {
  $f = $el.Tag.frame
  $el.Tag.orig = @{ stroke = $f.Stroke; fill = $f.Fill; dash = $f.StrokeDashArray }
  $el.AllowDrop = $true
  $el.Add_DragEnter({ param($s, $e) $e.Effects = 'Move'; $e.Handled = $true; Light $s $true })
  $el.Add_DragOver({ param($s, $e) $e.Effects = 'Move'; $e.Handled = $true; Light $s $true; Show-Line $s $e })
  $el.Add_DragLeave({ param($s, $e) Light $s $false; Hide-Line })
  $el.Add_Drop({ param($s, $e) $e.Handled = $true; $script:dropTo = @{ spot = $s.Tag.spot; index = (Drop-Index $s $e) }; Light $s $false; Hide-Line })
  $el.Add_MouseLeftButtonUp({ param($s, $e) if ($script:arr.sel) { $e.Handled = $true; Move-Chat $script:arr.sel $s.Tag.spot $null } })
}
function Light($el, [bool]$on) {
  $f = $el.Tag.frame
  if ($on) { $f.Stroke = "#$($el.Tag.color)"; $f.Fill = "#26$($el.Tag.color)"; $f.StrokeDashArray = $null }
  else { $o = $el.Tag.orig; $f.Stroke = $o.stroke; $f.Fill = $o.fill; $f.StrokeDashArray = $o.dash }
}
# Where among a window's tabs the drop lands: before the first tab whose middle is below the cursor.
function Drop-Index($el, $e) {
  $list = $el.Tag.list
  if (-not $list) { return $null }
  $y = $e.GetPosition($list).Y; $i = 0
  foreach ($c in @($list.Children)) {
    if (-not ($c.Tag -is [hashtable]) -or $c -eq $script:dragEl) { continue }
    if ($y -lt $c.TranslatePoint((New-Object Windows.Point 0, 0), $list).Y + $c.ActualHeight / 2) { return $i }
    $i++
  }
  $i
}
function Show-Line($el, $e) {
  $list = $el.Tag.list
  $chips = @(if ($list) { $list.Children | Where-Object { $_.Tag -is [hashtable] -and $_ -ne $script:dragEl } })
  if (-not $chips.Count) { Hide-Line; return }
  $i = Drop-Index $el $e
  Hide-Line
  $at = if ($i -lt $chips.Count) { $list.Children.IndexOf($chips[$i]) } else { $list.Children.IndexOf($chips[-1]) + 1 }
  $list.Children.Insert($at, $script:line)
}
function Hide-Line { if ($script:line.Parent) { $script:line.Parent.Children.Remove($script:line) } }
function End-Edit($ed) { $ed.Visibility = 'Collapsed'; $ed.Tag.t.Visibility = 'Visible' }
# Renaming from the list. A finished conversation is renamed on the spot (claude-multi rename, the way
# /rename does it). A running one holds its name in memory, so it gets /rename typed into it: we copy the
# command and bring up its tab.
function Save-Name($ed) {
  $s = $ed.Tag.s
  $name = ($ed.Text -replace '\s+', ' ').Trim()
  End-Edit $ed
  if (-not $name -or $name -eq $s.title) { return }
  if ($s.pid) {
    [Windows.Clipboard]::SetText("/rename $name")
    $cSubHeading.Text = "运行中的对话要在它自己的窗口里改名：已复制「/rename $name」，粘贴后回车即可"
    Focus-Claude $s.pid
    return
  }
  $ed.Tag.t.Text = $name # right away; the reload confirms it
  # Windows argument quoting: backslashes before a " and at the very end double, so "C:\tmp\" stays itself
  Run-Node "rename $($s.id) `"$($name -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1')`"" { Load-Chats }
}
# 换账号继续: you pick the account, and the rest as below. Not running: a new tab opens it with that account. Running:
# claude-multi swap ends its Claude (once the answer is over, unless 立即换) and its own tab goes on with the account.
function Switch-Chat($s) {
  $c = Pick-Switch $s
  if (-not $c) { return }
  if (-not $s.pid) { Open-Terminal $s.cwd "resume $($s.id) $($c.n)"; return }
  Say $(if ($s.busy -and -not $c.now) { "这一轮答完后，换到账号 $($c.n) 接着…" } else { "正在换到账号 $($c.n)…" })
  Run-Node "swap $($s.id) $($c.n)$(if ($c.now) { ' --now' })" {
    param($out)
    $msg = "$out".Trim(); if (-not $msg) { $msg = '换账号时出错了' }
    Add-Alert @{ kind = 'done'; info = $true; project = '换账号继续'; msg = $msg }
    Load-Chats
  }
}
# The dialog: which account (each with what it can still give; the conversation's own one not offered), while it
# answers 答完再换 or 立即换. @{ n; now }, or $null when cancelled.
function Chip-Xaml([int]$tag, [string]$text, [string]$note, [bool]$off) {
  "<Border Tag='$tag' CornerRadius='10' Padding='12,6' Margin='0,0,8,8' BorderThickness='1' Cursor='Hand' IsEnabled='$(-not $off)' Opacity='$(if ($off) { 0.4 } else { 1 })'>" +
  "<StackPanel Orientation='Horizontal'><TextBlock Text='$(Esc $text)' FontSize='13' FontWeight='SemiBold'/>" +
  "$(if ($note) { "<TextBlock Text='$(Esc $note)' FontSize='12' Foreground='#8CFFFFFF' Margin='6,0,0,0'/>" })</StackPanel></Border>"
}
function Paint-Chips($panel, [int]$sel) {
  foreach ($b in $panel.Children) {
    $on = [int]$b.Tag -eq $sel
    $b.Background = if ($on) { '#330A84FF' } else { '#14FFFFFF' }
    $b.BorderBrush = if ($on) { '#B30A84FF' } else { '#1AFFFFFF' }
  }
}
function Pick-Switch($s) {
  $u = $script:data; $accs = @($u.accounts); $own = [int]$s.acct
  if ($accs.Count -lt 2) { return $null }
  $rec = if ($null -ne $u.rec) { [int]$u.rec } else { -1 }
  $first = if ($rec -ge 0 -and $rec -ne $own) { $rec + 1 } else { ($own + 1) % $accs.Count + 1 }
  $chips = @(for ($i = 0; $i -lt $accs.Count; $i++) {
    $a = $accs[$i]
    $note = if ($i -eq $own) { '当前' } elseif ($a.err) { '读不到额度' } elseif ($a.runway -gt 0) { "可用 $($a.runway)h" } else { '已用满' }
    if ($i -eq $rec -and $i -ne $own) { $note += ' · 推荐' }
    Chip-Xaml ($i + 1) "账号 $($i + 1)" $note ($i -eq $own)
  }) -join ''
  $modes = if ($s.busy) { "<TextBlock Text='它正在回答' FontSize='12' Foreground='#8CFFFFFF' Margin='0,8,0,8'/><WrapPanel x:Name='Modes'>$(Chip-Xaml 0 '答完再换' '' $false)$(Chip-Xaml 1 '立即换' '' $false)</WrapPanel>" } else { '' }
  $d = X @"
<Window $ns Width="460" SizeToContent="Height" WindowStyle="None" AllowsTransparency="True" Background="Transparent" ResizeMode="NoResize"
  ShowInTaskbar="False" WindowStartupLocation="CenterOwner" Foreground="White" FontFamily="Segoe UI Variable Text, Microsoft YaHei UI" UseLayoutRounding="True">
 <Window.Resources>$styles</Window.Resources>
 <Grid Margin="16">
  <Border Background="Black" CornerRadius="18"><Border.Effect><DropShadowEffect BlurRadius="24" ShadowDepth="4" Direction="270" Opacity="0.55"/></Border.Effect></Border>
  <Border Background="#FA161618" CornerRadius="18" BorderBrush="#26FFFFFF" BorderThickness="1" Padding="22,20,22,18">
   <StackPanel>
    <TextBlock Text="换账号继续" FontSize="16" FontWeight="SemiBold"/>
    <TextBlock Text="$(Esc $s.title)" FontSize="12" Foreground="#8CFFFFFF" Margin="0,4,0,0" TextTrimming="CharacterEllipsis"/>
    <TextBlock Text="换到" FontSize="12" Foreground="#8CFFFFFF" Margin="0,16,0,8"/>
    <WrapPanel x:Name="Accs">$chips</WrapPanel>
    $modes
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,20,0,0">
     <Button x:Name="No" Style="{StaticResource Text}" FontSize="13" Margin="0,0,10,0" Padding="4,4" Content="取消"/>
     <Button x:Name="Go" Style="{StaticResource Primary}" FontSize="13"/>
    </StackPanel>
   </StackPanel>
  </Border>
 </Grid>
</Window>
"@
  $d.Tag = @{ n = $first; now = $false; ok = $false } # the handlers reach it through the dialog: no locals of ours
  $d.FindName('Go').Content = "换到账号 $first"
  $accPanel = $d.FindName('Accs'); Paint-Chips $accPanel $first
  foreach ($chip in @($accPanel.Children)) {
    $chip.Add_MouseLeftButtonDown({ param($x, $e) $e.Handled = $true }) # not the dialog's drag
    $chip.Add_MouseLeftButtonUp({ param($x) $w = [Windows.Window]::GetWindow($x); $w.Tag.n = [int]$x.Tag; Paint-Chips $w.FindName('Accs') $w.Tag.n; $w.FindName('Go').Content = "换到账号 $($w.Tag.n)" })
  }
  $modePanel = $d.FindName('Modes')
  if ($modePanel) {
    Paint-Chips $modePanel 0
    foreach ($chip in @($modePanel.Children)) {
      $chip.Add_MouseLeftButtonDown({ param($x, $e) $e.Handled = $true })
      $chip.Add_MouseLeftButtonUp({ param($x) $w = [Windows.Window]::GetWindow($x); $w.Tag.now = [int]$x.Tag -eq 1; Paint-Chips $w.FindName('Modes') ([int]$x.Tag) })
    }
  }
  $d.FindName('Go').Add_Click({ param($x) $w = [Windows.Window]::GetWindow($x); $w.Tag.ok = $true; $w.Close() })
  $d.FindName('No').Add_Click({ param($x) [Windows.Window]::GetWindow($x).Close() })
  $d.Add_KeyDown({ param($x, $e) if ($e.Key -eq 'Escape') { $x.Close() } })
  $d.Add_MouseLeftButtonDown({ param($x) $x.DragMove() })
  if ($script:cw -and $script:cw.IsVisible) { $d.Owner = $script:cw } else { $d.WindowStartupLocation = 'CenterScreen' }
  [void]$d.ShowDialog()
  if (-not $d.Tag.ok) { return $null }
  @{ n = $d.Tag.n; now = $d.Tag.now }
}
function Add-Chat($s) {
  $n = [int]$s.acct + 1 # its own account; a switch is only ever offered on click (Pick-Account)
  $mixed = $script:folder -eq '' -or $script:folder -eq '*' # rows from several folders say which one
  # right column: at rest the time (or a 运行中 chip), on hover the action, in the same cell
  # running in the web service (started or continued from the web page): no window here, a tab joins it
  $rest = if ($s.web) { "<Border Background='#2E0A84FF' CornerRadius='8' Padding='8,2'><TextBlock Text='网页上' FontSize='11' FontWeight='SemiBold' Foreground='#64B5FF'/></Border>" }
    elseif ($s.pid) { "<Border Background='#2E30D158' CornerRadius='8' Padding='8,2'><TextBlock Text='运行中' FontSize='11' FontWeight='SemiBold' Foreground='#30D158'/></Border>" }
    else { "<TextBlock Text='$(Ago $s.at)' FontSize='12' Foreground='#66FFFFFF'/>" }
  $act = if ($s.web) { '在电脑上打开' } elseif ($s.pid) { '切回窗口' } else { "继续 · 账号 $n" }
  $who = if ($script:data) { "（$($script:data.accounts[$n - 1].label)）" } else { '' }
  $tip = if ($s.web) { '在网页上运行：点击开一个终端标签接上它，两边同步，关掉标签不会结束对话' } elseif ($s.pid) { '还开着，点击切回它的终端标签' } else { "用账号 $n$who 在 $($s.cwd) 继续" }
  # one folder can hold conversations of several accounts
  $sub = @(@(if ($mixed) { "<Run Text='$(Esc (Split-Path $s.cwd -Leaf))' Foreground='#99FFFFFF'/>" }) +
    "<Run Text='账号 $([int]$s.acct + 1)'/>" +
    @(if ($s.prompt) { "<Run Text='$(Esc $s.prompt)' Foreground='#80FFFFFF'/>" })) -join "<Run Text='   ·   '/>"
  $b = New-Object Windows.Controls.Button
  $b.Style = $script:cw.FindResource('Item')
  $b.HorizontalContentAlignment = 'Stretch'
  $b.Background = '#0FFFFFFF' # each conversation its own card
  $b.Margin = '0,0,0,6'
  $b.Tag = $s
  $b.ToolTip = $tip
  $b.Content = X ("<Grid $ns Margin='6,6'><Grid.ColumnDefinitions><ColumnDefinition Width='Auto'/><ColumnDefinition/><ColumnDefinition Width='Auto'/></Grid.ColumnDefinitions>" +
    "<StackPanel Grid.Column='1'><Grid><TextBlock x:Name='T' Text='$(Esc $s.title)' FontSize='14' FontWeight='SemiBold' TextTrimming='CharacterEllipsis'/>" +
    "<TextBox x:Name='E' Visibility='Collapsed' FontSize='14' FontWeight='SemiBold' Background='#26FFFFFF' Foreground='White' CaretBrush='White' BorderThickness='0' Padding='4,1'/></Grid>" +
    "$(if ($sub) { "<TextBlock FontSize='12' Foreground='#59FFFFFF' Margin='0,4,0,0' TextTrimming='CharacterEllipsis'>$($sub -join '')</TextBlock>" })</StackPanel>" +
    "<StackPanel Grid.Column='2' Orientation='Horizontal' Margin='20,0,0,0' VerticalAlignment='Center'>" +
    "<Button x:Name='Sure' Visibility='Collapsed' Cursor='Hand' VerticalAlignment='Center' Margin='0,0,8,0' ToolTip='放进回收站，Token 统计照常保留'>" +
    "<Button.Template><ControlTemplate TargetType='Button'><Border Background='#FF453A' CornerRadius='10' Padding='11,3'><ContentPresenter/></Border></ControlTemplate></Button.Template>" +
    "<TextBlock Text='确认删除' FontSize='12' FontWeight='SemiBold' Foreground='White'/></Button>" +
    "$(if (-not $s.pid) { "<Border Style='{DynamicResource OnHover}' VerticalAlignment='Center' Margin='0,0,2,0'><Button x:Name='Del' Content='&#xE74D;' ToolTip='删除'/></Border>" })" +
    "<Border Style='{DynamicResource OnHover}' VerticalAlignment='Center' Margin='0,0,2,0'><Button x:Name='Sw' Content='&#xE8AB;' ToolTip='换账号继续'/></Border>" +
    "<Border Style='{DynamicResource OnHover}' VerticalAlignment='Center' Margin='0,0,6,0'><Button x:Name='Ren' Content='&#xE70F;' ToolTip='改名'/></Border><Grid VerticalAlignment='Center'>" +
    "<ContentControl Style='{DynamicResource OffHover}' HorizontalAlignment='Right' VerticalAlignment='Center'>$rest</ContentControl>" +
    "<Border Style='{DynamicResource OnHover}' Background='$(if ($s.pid) { '#30D158' } else { '#E6FFFFFF' })' CornerRadius='10' Padding='11,3' HorizontalAlignment='Right'>" +
    "<TextBlock Text='$act' FontSize='12' FontWeight='SemiBold' Foreground='Black'/></Border></Grid></StackPanel></Grid>")
  $sw = $b.Content.FindName('Sw'); $sw.Style = $script:cw.FindResource('Icon'); $sw.Tag = $s
  $sw.Add_Click({ param($x, $e) $e.Handled = $true; Switch-Chat $x.Tag }) # not a click on the row
  $ren = $b.Content.FindName('Ren'); $ed = $b.Content.FindName('E')
  $ren.Style = $script:cw.FindResource('Icon')
  $ed.Tag = @{ s = $s; t = $b.Content.FindName('T') }
  $ren.Tag = $ed
  $ren.Add_Click({
    param($x, $e)
    $e.Handled = $true # not a click on the row
    $ed = $x.Tag
    $ed.Text = $ed.Tag.s.title; $ed.Tag.t.Visibility = 'Collapsed'; $ed.Visibility = 'Visible'
    [void]$ed.Focus(); $ed.SelectAll()
  })
  $ed.Add_PreviewKeyDown({
    param($x, $e)
    if ($e.Key -eq 'Return') { $e.Handled = $true; Save-Name $x }
    elseif ($e.Key -eq 'Escape') { $e.Handled = $true; End-Edit $x } # handled: Esc doesn't close the window
  })
  $ed.Add_LostKeyboardFocus({ param($x) if ($x.Visibility -eq 'Visible') { End-Edit $x } })
  # delete: the trash asks once more (red 确认删除), leaving the row takes the question back
  $sure = $b.Content.FindName('Sure'); $del = $b.Content.FindName('Del')
  if ($del) {
    $del.Style = $script:cw.FindResource('Icon')
    $del.Tag = $sure
    $del.Add_Click({ param($x, $e) $e.Handled = $true; $x.Tag.Visibility = 'Visible' })
    $sure.Tag = $s
    $sure.Add_Click({
      param($x, $e)
      $e.Handled = $true
      $x.IsEnabled = $false
      Run-Node "delete $($x.Tag.id)" {
        param($out)
        if ("$out" -notmatch '已删除') { Add-Alert @{ kind = 'ask'; info = $true; project = '没删成'; msg = ("$out".Trim(), '删除时出错了')[-not "$out".Trim()] } }
        Load-Chats
      }
    })
    $b.Add_MouseLeave({ param($x) $x.Content.FindName('Sure').Visibility = 'Collapsed' })
  }
  $b.Add_Click({
    param($x)
    $s = $x.Tag
    if ($s.web) { Open-WebChat $s.id $s.cwd }
    elseif ($s.pid) { Focus-Claude $s.pid }
    else { $n = Pick-Account $s; if ($n) { Open-Terminal $s.cwd "resume $($s.id) $n" } }
  })
  [void]$cList.Children.Add($b)
}

# --- wiring -------------------------------------------------------------------------------------
$Pill.Add_MouseLeftButtonUp({ if ($Panel.Visibility -eq 'Visible') { Collapse } else { Expand } })
$BtnRefresh.Add_Click({ Refresh })
$BtnChats.Add_Click({ Collapse; if ($script:folder -eq '#tokens') { $script:folder = '' }; Open-Chats; Load-Chats }) # the list, not the token page
$BtnTokens.Add_Click({ Collapse; Open-Tokens })
$BtnBack.Add_Click({ Show-Rows })
$BtnClearHist.Add_Click({ foreach ($el in @($History.Children)) { Mark-Read $el.DataContext }; $History.Children.Clear(); Update-Badge })
$BtnQuit.Add_Click({ $win.Close() })
$BtnWarm.Add_Click({
  $BtnWarm.IsEnabled = $false; $Status.Text = '预热中…'
  Run-Node 'warmup' {
    param($out)
    $BtnWarm.IsEnabled = $true
    $script:note = "预热了 $(([regex]::Matches([string]$out, '已预热')).Count) 个 · "
    Refresh
  }
})
# not a $Root: names are case-blind, and it replaced $root (our folder), so read marks and finding a Claude by its conversation silently failed
$win.FindName('Root').Add_MouseEnter({ Show-PinButton $true; if ($script:hidden) { Slide $false } }) # instant; the timer catches a still cursor
function Show-PinButton([bool]$on) { $Pin.Opacity = [int]$on; $Pin.IsHitTestVisible = $on }
$Pin.Add_MouseLeftButtonUp({
  param($s, $e)
  $e.Handled = $true # not a click on the pill
  $script:pinned = -not $script:pinned
  if ($script:pinned) { [void](New-Item -ItemType File -Force -Path $pinFile) } else { Remove-Item $pinFile -ErrorAction SilentlyContinue }
  Show-Pin
})
$win.Add_Deactivated({ Collapse })
$win.Add_SizeChanged({ Recenter })
$win.Add_Loaded({ Recenter })
$win.Add_SourceInitialized({ [Native.OnTop]::Watch($win, "$root\island-errors.log") })

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(300)
$timer.Add_Tick({
  for ($k = $script:pending.Count - 1; $k -ge 0; $k--) {
    $j = $script:pending[$k]
    if (-not $j.task.IsCompleted) { continue }
    $script:pending.RemoveAt($k)
    $out = ''; if (-not $j.task.IsFaulted) { $out = $j.task.Result }
    & $j.done $out $j.ctx
  }
  Check-Inbox
  if ((++$script:ticks % 4) -eq 0) { Drop-Seen } # about once a second
  # mouse away for 1.5 s: fold the panel back, then (unpinned, no notifications) slide up to the edge
  $near = MouseNear
  Show-PinButton $near
  if ($near) { $script:away = 0; if ($script:hidden) { Slide $false } } else { $script:away += 300 }
  if ($script:away -ge 1500) {
    if ($Panel.Visibility -eq 'Visible') { Collapse }
    if (-not $script:pinned -and -not $script:hidden -and $Alerts.Visibility -ne 'Visible') { Slide $true }
  }
  if ($Alerts.Visibility -eq 'Visible') {
    if ($Island.IsMouseOver) { $script:alertUntil = (Get-Date).AddSeconds(3) } # hovering keeps it open
    elseif ((Get-Date) -gt $script:alertUntil) { Clear-Alerts }
  }
  if (((Get-Date) - $script:fetched).TotalMinutes -ge 5) { Refresh }
})
$timer.Start()

[void]$win.ShowDialog()
Remove-Item $pidFile -ErrorAction SilentlyContinue
$mutex.ReleaseMutex()
