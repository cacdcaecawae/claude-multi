# powershell -NoProfile -STA -File island.test.ps1
# Load only XAML and the layout helper, never the app's timers, processes, or user files.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'island.ps1') -Raw -Encoding UTF8
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors) { throw ($errors | Out-String) }
foreach ($name in 'X', 'Fit-Panel') {
  $node = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  . ([scriptblock]::Create($node.Extent.Text))
}
foreach ($name in 'ns', 'styles', 'win') {
  $node = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq ('$' + $name) }, $true)
  . ([scriptblock]::Create($node.Extent.Text))
}
$Panel = $win.FindName('Panel'); $PanelScroll = $win.FindName('PanelScroll'); $Pill = $win.FindName('Pill')
$PillScroll = $win.FindName('PillScroll')
$Rows = $win.FindName('Rows'); $Alerts = $win.FindName('Alerts')
$win.Opacity = 0; $win.ShowActivated = $false
try {
  $Panel.Visibility = 'Visible'; $Alerts.Visibility = 'Visible'
  for ($i = 0; $i -lt 30; $i++) {
    $row = New-Object Windows.Controls.TextBlock; $row.Text = "Account $i"; $row.Height = 50
    [void]$Rows.Children.Add($row)
  }
  $PillAccts = $win.FindName('PillAccts'); $PillAccts.Visibility = 'Visible'; $win.FindName('PillName').Visibility = 'Collapsed'
  for ($i = 0; $i -lt 12; $i++) {
    $label = New-Object Windows.Controls.TextBlock; $label.Text = "Account $i"; $label.Width = 90
    [void]$PillAccts.Children.Add($label)
  }
  $win.Show(); $win.UpdateLayout()
  foreach ($size in @(@(800, 600), @(640, 360), @(360, 240))) {
    $wa = [pscustomobject]@{ Width = $size[0]; Height = $size[1] }
    Fit-Panel $wa; $win.UpdateLayout()
    # Notifications arriving after expansion share the same bounded scroll area.
    $note = New-Object Windows.Controls.TextBlock; $note.Text = 'Notification'; $note.Height = 100
    [void]$Alerts.Children.Add($note); $win.UpdateLayout()
    if ($win.ActualHeight -gt $wa.Height + 1 -or $win.ActualWidth -gt $wa.Width + 1) { throw "Window exceeds work area: $($win.ActualWidth)x$($win.ActualHeight) in $($wa.Width)x$($wa.Height)" }
    if ($PanelScroll.ScrollableHeight -le 0) { throw 'Overflow cannot scroll' }
    if ($PillScroll.ScrollableWidth -le 0) { throw 'Account strip overflow cannot scroll' }
    $PanelScroll.ScrollToBottom(); $win.UpdateLayout()
    if ([Math]::Abs($PanelScroll.VerticalOffset - $PanelScroll.ScrollableHeight) -gt 1) { throw 'Cannot reach bottom controls' }
    Write-Output "island layout $($wa.Width)x$($wa.Height) ok"
  }
  # The conversation window's XAML and size constraints parse independently of the running island.
  $node = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$script:cw' -and $n.Right.Extent.Text.StartsWith('X @') }, $true)
  . ([scriptblock]::Create($node.Extent.Text))
  $cw.Opacity = 0; $cw.ShowActivated = $false; $cw.Show()
  $sizes = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -in '$script:cw.Width', '$script:cw.Height' }, $true)
  foreach ($size in @(@(1280, 900), @(640, 360), @(360, 240))) {
    $wa = [pscustomobject]@{ Width = $size[0]; Height = $size[1] }
    foreach ($node in $sizes) { . ([scriptblock]::Create($node.Extent.Text)) }
    $cw.UpdateLayout()
    if ($cw.ActualWidth -gt $wa.Width -or $cw.ActualHeight -gt $wa.Height) { throw 'Conversation window exceeds work area' }
    $close = $cw.FindName('Close'); $point = $close.TranslatePoint((New-Object Windows.Point 0,0), $cw)
    if ($point.X -lt 0 -or $point.Y -lt 0 -or $point.X + $close.ActualWidth -gt $cw.ActualWidth -or $point.Y + $close.ActualHeight -gt $cw.ActualHeight) { throw 'Close button is clipped' }
    $scroll = $cw.FindName('ChatsScroll')
    if ($wa.Width -lt 520 -and $scroll.ScrollableWidth -le 0) { throw 'Narrow conversation content cannot scroll' }
    if ($wa.Height -lt 400 -and $scroll.ScrollableHeight -le 0) { throw 'Short conversation content cannot scroll' }
    $scroll.ScrollToBottom(); $scroll.ScrollToRightEnd(); $cw.UpdateLayout()
    if ([Math]::Abs($scroll.VerticalOffset - $scroll.ScrollableHeight) -gt 1 -or [Math]::Abs($scroll.HorizontalOffset - $scroll.ScrollableWidth) -gt 1) { throw 'Conversation content is unreachable' }
    Write-Output "island conversation $($wa.Width)x$($wa.Height) ok"
  }
} finally { if ($cw) { $cw.Close() }; $win.Close() }
