# Claude 多账号（claude-multi）

在一台 Windows 电脑上同时用多个 Claude 订阅账号跑 Claude Code。

- 每个账号一个独立的配置目录，各自登录、各自计额度。设置、技能、插件、MCP、记忆和信任过的文件夹在账号之间共享。
- 屏幕顶上有一个「灵动岛」，可以看各账号额度、启动 Claude、接收「回复完成 / 等你确认」的通知。
- 还有一个网页，电脑和手机都能打开，可以接着用电脑上正在跑的对话。

![网页：对话列表和打开的对话](docs/desktop.png)

> 截图里的账号、对话都是演示数据。

## 目录

- [能做什么](#能做什么)
- [截图](#截图)
- [安装](#安装)
- [快速上手](#快速上手)
- [命令一览](#命令一览)
- [灵动岛](#灵动岛)
- [网页](#网页)
- [远程访问（手机、别的电脑）](#远程访问手机别的电脑)
- [数据和安全](#数据和安全)
- [文件说明和测试](#文件说明和测试)

## 能做什么

| 功能 | 说明 |
|---|---|
| 多账号 | `claude-multi new` 登录一个账号，可以加任意多个。启动时选账号，或者直接用推荐的那个。 |
| 额度 | 每个账号 5 小时窗口和 7 天窗口各用了多少、多久后重置、还能连续用多久，并推荐当前最合适的账号。 |
| 预热 | 给还没开始计时的账号发一条很小的消息，让 5 小时窗口提前开始计时，早点重置。 |
| 换账号接着聊 | 一个账号额度快用完时，把对话换到另一个账号继续，记录会一起带过去。 |
| 通知 | Claude 回复完、或者在等你确认权限时，灵动岛和网页都会提示。 |
| 网页 | VS Code 风格：左边是对话列表，右边用书签打开对话，可以左右分栏，同时看多个对话。 |
| 手机 | 同一个网页，手机上是单栏布局，可以添加到主屏幕当 App 用。 |
| 远程 | 通过你自己的服务器（SSH 反向隧道 + nginx HTTPS）在外面访问，用钥匙登录。 |
| 用量统计 | 所有账号的 token 用量，按天、按账号统计，并按 API 价格折算成金额。 |

## 截图

**分栏，暗色**

![分栏看两个对话，暗色](docs/split-dark.png)

**终端视图和额度面板**：终端视图里看到的和电脑上那个 Claude 窗口一模一样，可以直接打字操作。

![终端视图和额度面板](docs/terminal-quota.png)

**手机**

<table><tr>
<td><img src="docs/phone-list.png" width="300" alt="手机：对话列表"></td>
<td><img src="docs/phone-chat.png" width="300" alt="手机：一个对话"></td>
</tr></table>

**灵动岛的账号卡片**

<img src="docs/island.png" width="470" alt="灵动岛：账号卡片">

## 安装

需要：

- Windows 10 / 11，自带 PowerShell 5.1（灵动岛用到）
- [Node.js](https://nodejs.org/) 20 或更新版本
- [Claude Code](https://docs.claude.com/en/docs/claude-code)，命令行里能直接运行 `claude`
- 可选：Windows Terminal（灵动岛的「整理窗口」功能要用）

**1. 放到固定位置。**程序固定从 `%USERPROFILE%\.claude-multi` 读写数据，所以仓库必须克隆到这个位置：

```bat
git clone <这个仓库的地址> "%USERPROFILE%\.claude-multi"
cd /d "%USERPROFILE%\.claude-multi"
npm install
```

**2. 加一个命令。**在 PATH 里的某个文件夹（比如 `%USERPROFILE%\.local\bin`）新建 `claude-multi.cmd`，内容如下：

```bat
@node "%USERPROFILE%\.claude-multi\claude-multi.js" %*
```

**3. 接上通知和状态栏。**在 `%USERPROFILE%\.claude\settings.json` 里加上下面这些，`<用户名>` 换成你的 Windows 用户名。所有账号共用这一份设置，加一次就行。

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"C:/Users/<用户名>/.claude-multi/claude-multi.js\" notify done" }] }
    ],
    "Notification": [
      { "matcher": "permission_prompt",
        "hooks": [{ "type": "command", "command": "node \"C:/Users/<用户名>/.claude-multi/claude-multi.js\" notify ask" }] }
    ]
  },
  "statusLine": { "type": "command", "command": "node \"C:/Users/<用户名>/.claude-multi/claude-multi.js\" statusline" }
}
```

- 通知钩子：Claude 回复完（`Stop`）或在等你确认权限时（`Notification`），提示会出现在灵动岛和网页上。
- 状态栏：每个终端底部会显示账号、模型和所在文件夹。网页底部状态栏里的模型、上下文用量也是从这里来的。

## 快速上手

```bat
claude-multi new        :: 登录第一个账号（会打开浏览器），想加几个就运行几次
claude-multi usage      :: 看各账号的额度，回车直接用推荐的账号启动
claude-multi            :: 选一个账号，在当前文件夹启动 Claude Code
claude-multi island     :: 打开屏幕顶上的灵动岛
claude-multi web        :: 启动网页服务（http://127.0.0.1:7788）
claude-multi web-link   :: 打印带钥匙的网页链接，用它打开网页
```

`claude-multi` 后面加的参数会原样传给 `claude`，例如 `claude-multi --continue`。

## 命令一览

账号编号（N）就是 `claude-multi list` 里的顺序，从 1 开始。对话 ID 可以用 `claude-multi sessions` 查到。

| 命令 | 作用 |
|---|---|
| `claude-multi [claude 的参数]` | 选择账号后启动 Claude Code |
| `new` | 登录并添加一个账号 |
| `list` | 列出所有账号 |
| `switch` | 改默认账号（不启动 Claude） |
| `usage [--json]` | 各账号额度和推荐账号 |
| `warmup` | 预热：给还没开始计时的账号各发一条很小的消息 |
| `start N [claude 的参数]` | 不弹菜单，直接用账号 N 启动 |
| `sessions [--json]` | 列出所有对话，● 表示正在运行 |
| `resume ID N` | 用账号 N 接着一个之前的对话 |
| `swap ID N [--now]` | 把正在运行的对话换到账号 N。默认等 Claude 这一轮答完再换，`--now` 立即换 |
| `attach ID` | 在当前终端接上一个在网页服务里运行的对话，两边看到同一个画面 |
| `rename ID 名字` | 给没在运行的对话改名 |
| `delete ID` | 把没在运行的对话移到回收站 |
| `remove N` | 移除账号 N。它的文件夹移到回收站，有对话正在用它时不让移除 |
| `tokens [--json]` | token 用量和按 API 价格折算的金额 |
| `renew N 月-日` / `renew N auto` | 手动记下账号 N 的续费日，或改回自动推算 |
| `island` | 打开灵动岛（已经开着就不会再开一个） |
| `chats [arrange\|tokens]` | 打开灵动岛的对话窗口、窗口整理面板或用量页 |
| `web` | 启动网页服务 |
| `web-link [new]` | 打印网页链接。加 `new` 会换一把新钥匙，以前登录过的浏览器都要重新登录 |
| `wt-bind` | 给 Windows Terminal 加上灵动岛整理窗口要用的快捷键 |
| `notify done\|ask`、`notes`、`statusline` | 给钩子、灵动岛和状态栏内部调用的，不用手动运行 |

## 灵动岛

`claude-multi island` 会在屏幕顶部中间放一个小胶囊。平时显示推荐账号的名字、它的 5 小时用量和还能连续用多久，后面是其他账号的编号和 5 小时用量。点开后：

- **账号卡片**：每个账号的 5 小时、7 天用量，重置时间，还能连续用多久，以及续费日期。点「启动」用这个账号开一个 Claude。文件夹图标打开这个账号的配置目录。鼠标移到卡片上会出现垃圾桶，点了再确认才会移除。
- **＋ 添加账号**：打开一个终端，运行 `claude-multi new`。
- **通知**：Claude 回复完、或者在等你确认时，灵动岛会弹出来，点一下跳到那个窗口。
- **对话窗口**：所有对话按时间排列，可以接着聊、换账号、改名、删除。
- **整理窗口**：把多个 Claude 终端排好。先运行一次 `claude-multi wt-bind`。

## 网页

`claude-multi web` 启动网页服务。它只监听本机 `127.0.0.1:7788`，外面要访问需要按下一节配置。用 `claude-multi web-link` 打印的链接打开一次，浏览器会记住钥匙一年。

**布局**（电脑上）

- 最左一列图标：对话、额度、用量，最下面是外观（跟随系统 / 亮色 / 暗色）。再点一下当前的图标，列表就收起来。
- 点列表里的对话，它会作为书签在右边打开。打开多个时点书签切换，点 × 关闭，鼠标中键也能关。
- **分栏**：书签栏右上角的按钮会把当前书签挪到右边新的一栏。也可以点列表行右侧的按钮、按住 Ctrl 点击，或者把书签拖到右侧区域的左右边缘停靠。最多三栏，中间的分隔线可以拖动改宽度。
- 打开的书签和分栏刷新后还在。

**对话里**

- 「对话」视图只显示你的消息和 Claude 的回答。中间的工具操作和过渡的话收成一行「过程」，点开能看全部。
- 「终端」视图就是 Claude 窗口本身，可以直接打字操作。
- 发图片：点输入框左边的图片按钮，也可以粘贴截图或拖进来。
- 发送按钮是一个箭头。Claude 在回复时它变成红色方块，点了就让 Claude 停下。如果那条消息还没开始执行，它会回到输入框，可以改了再发。
- Claude 让你选择时（比如「信任这个文件夹吗」、权限确认），选项会显示成按钮。
- 列表里账号编号外面的圆环表示这个账号的 5 小时额度还剩多少，鼠标停在上面能看到具体百分比和重置时间。
- 底部状态栏显示当前对话：在电脑窗口还是网页服务里运行、账号额度、模型和思考强度、上下文用了多少、提示缓存还剩几分钟。

**手机上**

- 只显示一栏。左上角 ☰ 打开列表，底部切换对话、额度、用量、外观。
- 终端视图下方有一排按键：Esc、Tab、方向键、Ctrl+C 等。
- 在 Safari 里点「分享 → 添加到主屏幕」，之后就能像 App 一样全屏打开。

## 远程访问（手机、别的电脑）

网页服务只在电脑本机监听。要在外面访问，需要一台有公网 IP 的服务器做中转：

```
手机浏览器 ──HTTPS──▶ 服务器 nginx :8443 ──▶ /run/claude-multi.sock ══SSH 反向隧道══▶ 电脑 127.0.0.1:7788
```

整条链路是电脑主动连服务器，所以电脑不需要公网 IP，也不用在路由器上开端口。断线后会自动重连。

**1. 电脑能免密 SSH 登录服务器。**在 `~/.ssh/config` 里给服务器起一个名字，比如 `myserver`，并配好密钥登录。

**2. 写服务器信息。**在 `%USERPROFILE%\.claude-multi\` 里新建 `tunnel.json`（这个文件不进仓库）：

```json
{ "ssh": "myserver", "url": "https://你的服务器地址:8443" }
```

`ssh` 是第 1 步在 `~/.ssh/config` 里起的名字，`url` 是手机上打开的地址。没有这个文件时，网页服务只在本机 `http://127.0.0.1:7788` 能打开，不连服务器。

**3. 服务器上的 sshd。**新建 `/etc/ssh/sshd_config.d/60-claude-multi.conf`，然后运行 `systemctl reload ssh`：

```
ClientAliveInterval 5
ClientAliveCountMax 3
StreamLocalBindUnlink yes
StreamLocalBindMask 0111
```

**4. 服务器上的 nginx。**证书可以用 Let's Encrypt，没有域名也能给 IP 签证书。别忘了在防火墙和云服务商的安全组里放行 8443 端口。

```nginx
server {
    listen 8443 ssl;
    server_name 你的服务器地址;
    ssl_certificate     /etc/letsencrypt/live/你的服务器地址/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/你的服务器地址/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    server_tokens off;
    client_max_body_size 30m;            # 发图片
    location / {
        proxy_pass http://unix:/run/claude-multi.sock:;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Connection "";
        proxy_buffering off;             # 终端画面是实时推送的
        proxy_read_timeout 1h;
        proxy_intercept_errors on;
        error_page 502 504 = @away;
    }
    location @away { default_type "text/plain; charset=utf-8"; return 503 "电脑那边没连上（关机、断网，或网页服务没开）。\n"; }
}
```

**5. 启动网页服务**（`claude-multi web`），它会自己建好隧道。然后用 `claude-multi web-link` 打印的链接在手机上打开。

> 如果电脑开着 Clash 之类的 TUN 模式代理，记得让到服务器的连接走直连。

## 数据和安全

- 每个账号的登录凭证只在它自己的 `accounts/<id>/` 目录里。`profiles.json` 和日志不保存任何令牌、cookie 或登录链接。
- 仓库只收代码，`.gitignore` 用的是白名单。账号目录、对话记录、网页钥匙、上传的图片都不会进仓库。
- 网页钥匙保存在 `web-key`，浏览器用 HttpOnly cookie 记住它。比较钥匙时用的是防计时攻击的方式，改动类的请求只接受同一网站发来的。
- 删除对话、移除账号都是移到 Windows 回收站，可以找回。

## 文件说明和测试

| 文件 | 内容 |
|---|---|
| `claude-multi.js` | 命令行和网页服务 |
| `island.ps1` | 灵动岛（WPF）。必须保存为带 BOM 的 UTF-8，否则 PowerShell 5.1 会读错中文 |
| `console-bridge.ps1` | 读取电脑上 Claude 窗口的画面并转发按键，网页的终端视图靠它 |
| `web.html` | 网页，单个文件，每次刷新直接读取，改完不用重启服务 |
| `claude-multi.test.js` | 测试 |

运行测试：

```bat
node claude-multi.test.js
```

每一项通过会打印一行 `… ok`。

改了 `claude-multi.js` 之后要重启网页服务才会生效。重启会关掉在网页服务里运行的对话，对话记录不会丢，之后可以接着聊。
