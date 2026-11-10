# chatgpt-cdp-channel

**Turn ChatGPT Desktop into a scriptable local channel via Chrome DevTools Protocol.**

通过 CDP 连接 ChatGPT 桌面端，把已经登录的桌面 App 变成可脚本化的本地通道：新建会话、发送消息、读取回复、监听 DOM 变化。不需要 API Key，不调用官方模型 API，复用桌面端现有的登录态和订阅额度。

> 当前版本：`v1.0.0` · 主要适配 Windows · 已在 ChatGPT Desktop `26.1029.7803.0`（Electron / Chromium 156）上验证。

## 为什么做这个

日常用 ChatGPT 订阅很多，但想把桌面端接进本地脚本、自动化任务或 Agent 工作流时，通常只有一个选择：再走一套官方 API 的调用和计费链路。

这个项目走另一条路：ChatGPT 桌面端本身就是 Electron/Chromium 应用，只要用独立 profile 和 `--remote-debugging-port` 启动一个便携副本，就能通过本机 `127.0.0.1` 上的 CDP WebSocket 操作页面。它不是官方 SDK，也不是模型接口，而是**桌面页面的本地自动化通道**。

ChatGPT 桌面端与 Codex 的额度体系正在合并，客户端形态和可用通道之后可能变化。先把当前可工作的方案整理出来，给需要的人研究和复用。

## 功能

- **Local CDP Connection** — `start` / `status`：启动独立 profile 的 ChatGPT 桌面副本，建立 CDP 连接并检查通道状态。
- **Conversation Management** — `new`：创建新会话，支持脚本化组织交互流程。
- **Message Sending** — `send`：通过页面 composer 发送文本消息。
- **Text File Input** — `send-file`：读取 UTF-8 文本文件内容并作为消息发送；`attach` 可通过页面文件输入上传真实附件。
- **Response Reading** — `read` / `wait`：读取当前页面文本，或等待回复停止变化后返回。
- **DOM Monitoring** — `watch`：监听页面 DOM 变化，把每次实质更新写入 JSONL，方便外部 Agent 或自动化流程衔接。

## 工作原理

```text
┌──────────────────────┐        CDP WebSocket         ┌─────────────────────────┐
│  your script / agent │  ──────────────────────────▶ │  ChatGPT Desktop        │
│  chatgpt-cdp-channel │   Runtime.evaluate           │  (Electron / Chromium)  │
│                      │ ◀──────────────────────────  │  chatgpt.com webview    │
└──────────────────────┘        DOM / innerText        └─────────────────────────┘
          │                                                        ▲
          └── HTTP GET http://127.0.0.1:9223/json ─────────────────┘
```

1. `start` 用一个独立的 `--user-data-dir` 和 `--remote-debugging-port=9223` 启动便携副本，不影响正式安装的 ChatGPT。
2. 工具从 `http://127.0.0.1:9223/json` 找到 `chatgpt.com` 的 webview target。
3. 通过 CDP `Runtime.evaluate` 在页面上下文里定位 composer、触发输入事件、点击发送按钮、读取 `main.innerText`。
4. `watch` 每秒读取页面文本并用 SHA-256 比较，内容变化时追加一条 JSONL 事件。

整个过程只在本机回环地址上进行，不经过第三方服务器。

## 快速开始

### 环境要求

- Windows 10/11
- Node.js **22+**（使用内置 `WebSocket`，无第三方依赖）
- 已安装并登录的 ChatGPT 桌面端（Microsoft Store 的 `OpenAI.Codex` 包）
- PowerShell 5.1+（仅准备便携副本时需要）

### 1. 准备便携副本

ChatGPT 的 Store 安装目录不适合直接写入，也不能带着自定义启动参数启动第二个实例。先复制一份便携副本：

```powershell
powershell -ExecutionPolicy Bypass -File .\prepare-portable.ps1
```

默认复制到 `%LOCALAPPDATA%\ChatGPT-REA\app`。也可以手动复制整个 `app` 目录，然后通过环境变量指定：

```powershell
$env:CHATGPT_APP_DIR = 'D:\ChatGPT-portable\app'
$env:CHATGPT_PROFILE = 'D:\ChatGPT-portable\profile'
```

> `prepare-portable.ps1` 只做目录复制，不修改原安装目录中的任何文件。

### 2. 启动并检查通道

```powershell
node .\chatgpt-cdp-channel.mjs start
node .\chatgpt-cdp-channel.mjs status
```

`start` 会在后台拉起便携副本；首次使用时可能需要在窗口里完成登录。`status` 返回当前 target 的 `id / title / url`，说明通道已就绪。

### 3. 发送与读取

```powershell
node .\chatgpt-cdp-channel.mjs new
node .\chatgpt-cdp-channel.mjs send "用一句话解释 Chrome DevTools Protocol"
node .\chatgpt-cdp-channel.mjs wait reply.json
```

`wait` 会等到页面文本连续稳定、且没有“停止生成”按钮后返回，并把完整页面文本写入 `reply.json`。

也可以一步完成：

```powershell
node .\chatgpt-cdp-channel.mjs ask "帮我写一段项目简介" --out answer.json
```

### 4. 监听 DOM 变化

```powershell
node .\chatgpt-cdp-watch.mjs chatgpt-events.jsonl
```

输出为每行一个 JSON 对象：

```json
{"event_id":"chatgpt-dom-...","observed_at":"2026-11-10T...","url":"https://chatgpt.com/c/...","title":"...","chars":1234,"sha256":"...","text":"..."}
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `start` | 启动便携副本并等待 CDP target 出现 |
| `status` | 输出当前 CDP target（JSON） |
| `doctor` | 检查 Node、路径、端口和 CDP 连通性 |
| `new` | 点击“新聊天 / New chat” |
| `send <text...>` | 通过 composer 发送文本 |
| `send-file <path>` | 读取 UTF-8 文本文件并作为消息发送 |
| `attach <path...>` | 通过页面文件输入上传一个或多个真实文件 |
| `read [outfile]` | 读取当前页面文本，可选写入 JSON |
| `wait [outfile]` | 等待当前回复稳定，可选写入 JSON |
| `ask <text...>` | 发送消息并等待回复稳定，打印末尾文本 |
| `eval <expression>` | 在页面上下文执行任意 JS 表达式 |
| `help` | 显示帮助 |

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CHATGPT_CDP_PORT` | `9223` | CDP 端口 |
| `CHATGPT_CDP_HOST` | `127.0.0.1` | CDP 地址，建议保持回环地址 |
| `CHATGPT_APP_DIR` | `%LOCALAPPDATA%\ChatGPT-REA\app` | 便携副本目录 |
| `CHATGPT_EXE` | `<APP_DIR>\ChatGPT.exe` | ChatGPT 可执行文件路径 |
| `CHATGPT_PROFILE` | `%LOCALAPPDATA%\ChatGPT-REA\profile` | 便携副本的 user-data-dir |
| `CHATGPT_REA_APPDATA` | 继承当前环境 | 传给子进程的 `APPDATA` |
| `CHATGPT_REA_LOCALAPPDATA` | 继承当前环境 | 传给子进程的 `LOCALAPPDATA` |
| `CHATGPT_WAIT_TIMEOUT_MS` | `300000` | `ask` / `wait` 超时 |
| `CHATGPT_WAIT_STABLE_MS` | `2500` | 判定回复稳定的连续静默时间 |
| `CHATGPT_WATCH_INTERVAL_MS` | `1000` | `watch` 轮询间隔 |
| `CHATGPT_WATCH_SECONDS` | `0` | `watch` 运行秒数，`0` 表示一直运行 |

## 直接使用 CDP

如果不想用封装命令，`chatgpt-cdp-bridge.mjs` 提供一次性的原始表达式执行：

```powershell
node .\chatgpt-cdp-bridge.mjs "document.title"
node .\chatgpt-cdp-bridge.mjs "(() => Array.from(document.querySelectorAll('main')).map(e => e.innerText))()"
```

也可以直接用 curl 查看 target：

```powershell
curl.exe http://127.0.0.1:9223/json
```

## 故障排查

**`APP_NOT_FOUND`**
没有找到便携副本。先运行 `prepare-portable.ps1`，或设置 `CHATGPT_APP_DIR` / `CHATGPT_EXE`。

**`CDP_OFFLINE`**
便携副本没有启动，或 `--remote-debugging-port` 没有生效。先运行 `start`，再用 `curl.exe http://127.0.0.1:9223/json` 检查端口。

**`CDP_START_TIMEOUT`**
应用 60 秒内没有暴露 target。可能是首次启动需要登录、被杀软拦截，或端口被占用。手动运行一次 `ChatGPT.exe --user-data-dir=... --remote-debugging-port=9223 --no-sandbox` 看窗口状态。

**`composer-not-found` / `send-button-not-found`**
页面还没加载完，或客户端 UI 文案/结构发生变化。等页面完全加载后重试；用 `eval` 检查当前 DOM：

```powershell
node .\chatgpt-cdp-channel.mjs eval "Array.from(document.querySelectorAll('[contenteditable=true]')).length"
```

**`new-chat-button-not-found`**
“新聊天”按钮文案或位置变化。`new` 同时匹配“新聊天 / 新对话 / New chat / New conversation”；如果客户端改版，用 `eval` 找到按钮后提 Issue。

## 能力边界

- 本项目不是 OpenAI 官方 SDK，也不提供独立模型服务；它复用桌面端登录态及对应账号可用的订阅额度。
- 实际可用性受账号限制、页面结构、客户端版本和服务端策略影响，客户端更新可能随时导致选择器失效。
- `read` 返回的是页面 `innerText`，不是结构化的官方 API 响应；重要信息需要自行校验。
- 当前主要适配 Windows。macOS/Linux 需要自行调整可执行文件路径、应用目录和启动方式。
- CDP 调试端口只应绑定在 `127.0.0.1`，不要暴露到公网或不可信局域网。

## 开发

```powershell
node .\chatgpt-cdp-channel.mjs doctor
node --check .\chatgpt-cdp-channel.mjs
node --check .\cdp.mjs
```

项目无第三方运行时依赖，Node.js 22+ 即可。

## License

[MIT](./LICENSE)

本项目与 OpenAI 无关联，ChatGPT 是其各自权利人的商标。
