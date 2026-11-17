#!/bin/bash
# claude-multi on a Mac, in one line (run it again to update):
#   curl -fsSL https://raw.githubusercontent.com/cacdcaecawae/claude-multi/master/install.sh | bash
# Needs git and Node.js 20+; Claude Code is installed if it's missing. The rest is claude-multi.js's setup.
# CM_REPO, CM_BRANCH: another copy to install from (a test's).
set -euo pipefail
main() {
  local repo="${CM_REPO:-https://github.com/cacdcaecawae/claude-multi.git}" branch="${CM_BRANCH:-master}" dir="$HOME/.claude-multi"
  stop() { echo "$1" >&2; exit 1; }
  [ "$(uname)" = Darwin ] || stop '这一行是给 Mac 的，Windows 用 install.ps1'
  command -v git >/dev/null || stop '没有 git：运行 xcode-select --install 装上命令行工具，再运行一次'
  command -v node >/dev/null || stop '没有 Node.js：到 https://nodejs.org 下载安装 20 或更新的版本，再运行一次'
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || stop "Node.js 要 20 或更新，现在是 $(node -v)"
  export PATH="$HOME/.local/bin:$PATH" # where Claude Code's installer puts claude (not on every PATH); the web service is given this one
  if ! command -v claude >/dev/null; then
    echo '安装 Claude Code…'
    curl -fsSL https://claude.ai/install.sh | bash
    command -v claude >/dev/null || stop '没装上 Claude Code：照 https://docs.claude.com/en/docs/claude-code 装好，再运行一次'
  fi
  if [ -d "$dir/.git" ]; then git -C "$dir" pull -q --ff-only
  elif [ -e "$dir" ]; then stop "$dir 已经有了，但不是 claude-multi 的代码：挪开它再运行一次"
  else git clone -q -b "$branch" "$repo" "$dir"; fi
  (cd "$dir" && npm install --no-audit --no-fund --loglevel=error)
  node "$dir/claude-multi.js" setup
}
# all read before it runs (curl | bash: a download cut short runs nothing); nothing in it reads the script as input
main "$@" </dev/null
