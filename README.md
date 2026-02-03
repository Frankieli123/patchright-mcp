# Patchright MCP (Lite)

[English](#english) | [中文](#中文)

## English

A Model Context Protocol (MCP) server powered by the Patchright Node.js SDK (Playwright-compatible with stealth enhancements). It exposes a Playwright MCP–style toolset (ARIA snapshot + refs) while keeping a small “lite” interface (`browse/interact/extract/...`) for simpler clients.

### Features

- Persistent sessions via named profiles (`profile: "default"` by default)
- Playwright-style tools (`browser_*`) + lightweight tools (`browse`, `interact`, ...)
- ARIA snapshot + `ref` targeting (ref-first; selector fallback supported)
- Structured responses (result/code/tabs/console/downloads/page/snapshot)
- Disk hygiene via `browser_cleanup` (profiles/downloads/traces)

### Requirements

- Node.js 18+
- npm

### Install

```bash
git clone https://github.com/Frankieli123/patchright-mcp.git
cd patchright-mcp
npm ci
npm run build
```

Install browser binaries (pick one):

- CLI: `npx patchright install chromium`
- MCP tool: `browser_install` (recommended for remote runners)

### Run

```bash
npm start
```

For development:

```bash
npm run dev
```

### Integrations

Claude Desktop (`claude-desktop-config.json`):

```json
{
  "mcpServers": {
    "patchright": {
      "command": "node",
      "args": ["path/to/patchright-mcp/dist/index.js"]
    }
  }
}
```

### Tooling overview

**Lite tools** (simple API):

- `browse`: open URL (reuses persistent profile by default)
- `navigate`: navigate within an existing session (keeps login state)
- `interact`: simple click/fill/select by selector
- `extract`: text/html/screenshot
- `execute_script`: run JS in page context
- `request`: fetch via browser context (cookies preserved; no CORS)
- `wait_for_response`: wait for a matching network response body
- `close`: close a browser session

**Playwright MCP style** (`browser_*`):

- Navigation/session: `browser_open`, `browser_navigate`, `browser_navigate_back`, `browser_tabs`, `browser_wait_for`
- Snapshot: `browser_snapshot` (use `type: "aria"` for ARIA snapshot + refs)
- Actions: `browser_click`, `browser_type`, `browser_hover`, `browser_drag`, `browser_select_option`, `browser_take_screenshot`, ...
- Diagnostics: `browser_console_messages`, `browser_network_requests`, `browser_start_tracing`, `browser_stop_tracing`
- Lifecycle: `browser_close`, `browser_install`, `browser_cleanup`

### ARIA snapshot + ref targeting

Recommended flow:

1) Call `browser_snapshot` with `type: "aria"` and read refs from the snapshot text.
2) Use ref-first actions with a structured `target`:

```json
{
  "target": { "kind": "ref", "element": "Login button", "ref": "123" }
}
```

Selector fallback is also supported:

```json
{
  "target": { "kind": "selector", "selector": "#login" }
}
```

Legacy top-level params `selector` or `element`+`ref` remain supported for compatibility.

### Disk usage / cleanup

This server stores profiles/downloads/traces under OS temp (e.g. `%TEMP%\\patchright-mcp` on Windows, `/tmp/patchright-mcp` on Linux).

Use `browser_cleanup` to prevent unbounded growth. Note: cleaning profiles will wipe persisted login state.

### Environment variables

- `PATCHRIGHT_MCP_ENABLE_RUN_CODE=1` enables `browser_run_code` (dangerous; disabled by default)
- `PATCHRIGHT_MCP_SECRETS_JSON` or `PATCHRIGHT_MCP_SECRETS` masks known secrets in text output (JSON object, e.g. `{"openai":"sk-..."}`)

### Docker

Build and run locally:

```bash
docker build -t patchright-mcp .
docker run -it --rm patchright-mcp
```

Publishing to Docker Hub is wired via GitHub Actions (`.github/workflows/docker-hub-publish.yml`). Update the image name and provide `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets in your repo settings.

### License

Apache-2.0 (see `LICENSE`).

---

## 中文

基于 Patchright Node.js SDK（与 Playwright 兼容，并带有隐身增强）的 MCP 服务器。它对齐了 Playwright MCP 的常用工作流（ARIA snapshot + ref），同时保留了更“轻量”的接口（`browse/interact/extract/...`）方便简单客户端接入。

### 特性

- 通过 profile 复用会话（默认 `profile: "default"`，可持续保存登录态）
- 同时提供 Playwright 风格工具（`browser_*`）与轻量工具（`browse` 等）
- 支持 ARIA snapshot + `ref` 精准定位（优先 ref；可回退 selector）
- 结构化返回（result/code/tabs/console/downloads/page/snapshot）
- 提供 `browser_cleanup` 清理 profile/downloads/traces，避免磁盘无限增长

### 环境要求

- Node.js 18+
- npm

### 安装

```bash
git clone https://github.com/Frankieli123/patchright-mcp.git
cd patchright-mcp
npm ci
npm run build
```

安装浏览器二进制（任选一种）：

- 命令行：`npx patchright install chromium`
- MCP 工具：`browser_install`（更适合远程/容器环境）

### 运行

```bash
npm start
```

开发模式：

```bash
npm run dev
```

### 集成示例

Claude Desktop（`claude-desktop-config.json`）：

```json
{
  "mcpServers": {
    "patchright": {
      "command": "node",
      "args": ["path/to/patchright-mcp/dist/index.js"]
    }
  }
}
```

### 工具概览

**轻量工具**（简单 API）：

- `browse`：打开 URL（默认复用持久 profile）
- `navigate`：在同一会话内跳转（保持登录态）
- `interact`：按 selector 做 click/fill/select
- `extract`：提取 text/html/screenshot
- `execute_script`：在页面上下文执行 JS
- `request`：使用浏览器上下文发请求（保留 cookie；无 CORS 限制）
- `wait_for_response`：等待匹配的网络响应并返回 body
- `close`：关闭浏览器会话

**Playwright MCP 风格**（`browser_*`）：

- 导航/会话：`browser_open`, `browser_navigate`, `browser_navigate_back`, `browser_tabs`, `browser_wait_for`
- 快照：`browser_snapshot`（使用 `type: "aria"` 获取带 ref 的 ARIA snapshot）
- 动作：`browser_click`, `browser_type`, `browser_hover`, `browser_drag`, `browser_select_option`, `browser_take_screenshot` 等
- 诊断：`browser_console_messages`, `browser_network_requests`, `browser_start_tracing`, `browser_stop_tracing`
- 生命周期：`browser_close`, `browser_install`, `browser_cleanup`

### ARIA snapshot + ref 用法

推荐流程：

1）先调用 `browser_snapshot` 且 `type: "aria"`，从快照文本中读取 ref。
2）动作工具使用结构化 `target`（推荐）：

```json
{
  "target": { "kind": "ref", "element": "登录按钮", "ref": "123" }
}
```

也支持 selector 回退：

```json
{
  "target": { "kind": "selector", "selector": "#login" }
}
```

为兼容旧调用，顶层 `selector` 或 `element`+`ref` 仍然可用。

### 磁盘占用与清理

本服务会把 profiles/downloads/traces 存在系统临时目录下（Windows 通常是 `%TEMP%\\patchright-mcp`，Linux 是 `/tmp/patchright-mcp`）。

建议周期性调用 `browser_cleanup` 防止磁盘无限增长。注意：清理 profiles 会清空持久化登录态。

### 环境变量

- `PATCHRIGHT_MCP_ENABLE_RUN_CODE=1`：启用 `browser_run_code`（危险能力，默认关闭）
- `PATCHRIGHT_MCP_SECRETS_JSON` / `PATCHRIGHT_MCP_SECRETS`：对输出文本中的敏感信息做掩码（JSON 对象，例如 `{"openai":"sk-..."}`）

### Docker

本地构建并运行：

```bash
docker build -t patchright-mcp .
docker run -it --rm patchright-mcp
```

仓库内已配置 GitHub Actions 自动推送 Docker Hub（见 `.github/workflows/docker-hub-publish.yml`）。如需启用，请修改镜像名并在仓库 Secrets 中配置 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`。

### License

Apache-2.0（见 `LICENSE`）。
