# claude-multi on Windows, in one line in PowerShell (run it again to update):
#   irm https://raw.githubusercontent.com/cacdcaecawae/claude-multi/master/install.ps1 | iex
# Needs git and Node.js 20+; Claude Code is installed if it's missing. The rest is claude-multi.js's setup.
# CM_REPO, CM_BRANCH: another copy to install from (a test's). Run by iex: return, never exit (it would close your window).
& {
  $repo = if ($env:CM_REPO) { $env:CM_REPO } else { 'https://github.com/cacdcaecawae/claude-multi.git' }
  $branch = if ($env:CM_BRANCH) { $env:CM_BRANCH } else { 'master' }
  $dir = Join-Path $env:USERPROFILE '.claude-multi'
  $has = { param($c) [bool](Get-Command $c -ErrorAction SilentlyContinue) }
  if (-not (& $has git)) { Write-Host '没有 git：到 https://git-scm.com 下载安装，再运行一次'; return }
  if (-not (& $has node)) { Write-Host '没有 Node.js：到 https://nodejs.org 下载安装 20 或更新的版本，再运行一次'; return }
  if ([int](node -p "process.versions.node.split('.')[0]") -lt 20) { Write-Host "Node.js 要 20 或更新，现在是 $(node -v)"; return }
  if (-not (& $has claude)) {
    Write-Host '安装 Claude Code…'
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path" # where it puts claude
    if (-not (& $has claude)) { Write-Host '没装上 Claude Code：照 https://docs.claude.com/en/docs/claude-code 装好，再运行一次'; return }
  }
  if (Test-Path "$dir\.git") { git -C $dir pull -q --ff-only }
  elseif (Test-Path $dir) { Write-Host "$dir 已经有了，但不是 claude-multi 的代码：挪开它再运行一次"; return }
  else { git clone -q -b $branch $repo $dir }
  if ($LASTEXITCODE) { return }
  # npm.cmd: PowerShell's own npm.ps1 is refused where scripts aren't allowed (Windows' default)
  Push-Location $dir
  try { npm.cmd install --no-audit --no-fund --loglevel=error } finally { Pop-Location }
  if ($LASTEXITCODE) { return }
  node "$dir\claude-multi.js" setup
}
