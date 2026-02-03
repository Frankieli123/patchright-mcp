# Patchright MCP

[![npm version](https://img.shields.io/npm/v/@a3180623/patchright-mcp.svg)](https://www.npmjs.com/package/@a3180623/patchright-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@a3180623/patchright-mcp.svg)](https://www.npmjs.com/package/@a3180623/patchright-mcp)
[![license](https://img.shields.io/npm/l/@a3180623/patchright-mcp.svg)](https://github.com/Frankieli123/patchright-mcp/blob/main/LICENSE)

[中文](#中文) | [English](#english)

---

## 📦 版本 / Version

**当前版本 / Current**: `v1.0.0`

### 更新日志 / Changelog

#### v1.0.0 (2026-02-03)
- 🎉 首次发布
- ✨ 支持 ARIA Snapshot + Ref 定位工作流
- ✨ 完整 Playwright MCP 风格工具集（`browser_*`）
- ✨ 会话持久化（profile 复用）
- ✨ 扩展工具：`request` / `wait_for_response`
- ✨ 磁盘治理：`browser_cleanup`

---

## 中文

基于 **Patchright Node.js SDK**（Playwright 兼容 + 隐身增强）的 MCP（Model Context Protocol）服务器。专为 AI 代理设计，提供完整的浏览器自动化能力。

### ✨ 核心特性

| 特性 | 说明 |
|------|------|
| 🎭 **隐身浏览** | 基于 Patchright，绕过常见反爬检测（CDP/Webdriver 指纹等） |
| 🎯 **ARIA Snapshot + Ref 定位** | 用 `browser_snapshot(type="aria")` 产出带 `ref` 的快照，精准元素交互 |
| 🔄 **会话持久化** | 默认使用持久化 profile 保留登录态，免重复登录 |
| 📦 **结构化响应** | 返回 `result/code/tabs/console/downloads/page/snapshot/images` |
| 🧹 **磁盘治理** | `browser_cleanup` 清理临时文件，防止无限增长 |
| 🌐 **HTTP 扩展** | `request` / `wait_for_response` 用浏览器上下文发请求（带 Cookie） |

### 📋 环境要求

- **Node.js** 18+
- **npm** 或 **pnpm**

### 🚀 快速使用（无需下载源码）

#### 方法 1：npx 直接运行（推荐）

```bash
npx @a3180623/patchright-mcp
```

Claude Desktop 配置：
```json
{
  "mcpServers": {
    "patchright": {
      "command": "npx",
      "args": ["-y", "@a3180623/patchright-mcp"]
    }
  }
}
```

#### 方法 2：全局安装

```bash
# 从 npm 安装
npm install -g @a3180623/patchright-mcp

# 运行
patchright-mcp
```

Claude Desktop 配置：
```json
{
  "mcpServers": {
    "patchright": {
      "command": "patchright-mcp"
    }
  }
}
```

### 📦 从源码安装

```bash
# 克隆仓库
git clone https://github.com/Frankieli123/patchright-mcp.git
cd patchright-mcp

# 安装依赖
npm ci

# 构建项目
npm run build
```

**安装浏览器二进制**（二选一）：

```bash
# 方式 1：命令行安装
npx patchright install chromium

# 方式 2：通过 MCP 工具安装（适合远程/容器环境）
# 调用 browser_install 工具
```

### ▶️ 运行

```bash
# 生产模式
npm start

# 开发模式（热重载）
npm run dev
```

**可选能力控制**（通过 `--caps` 或环境变量 `PATCHRIGHT_MCP_CAPS`）：

```bash
# 仅启用 vision 和 pdf 能力
npm start -- --caps=vision,pdf

# 启用所有能力
npm start -- --caps=all
```

### 🔧 集成配置

#### Claude Desktop

编辑 `claude-desktop-config.json`：

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

#### Amp / VS Code

在 `.amp/settings.json` 或项目配置中添加：

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

### 📖 推荐工作流（ARIA Snapshot + Ref）

**步骤 1：获取页面快照**

```json
{ "type": "aria" }
```

返回带 `ref` 标识的 ARIA 快照，如：
```
[ref=123] button "登录"
[ref=456] textbox "用户名"
```

**步骤 2：基于 ref 交互**

```json
{
  "target": { "kind": "ref", "element": "登录按钮", "ref": "123" }
}
```

**备选：使用 CSS 选择器**

```json
{
  "target": { "kind": "selector", "selector": "#login-btn" }
}
```

### 🛠️ 工具一览

#### 核心工具（Playwright MCP 风格）

| 类别 | 工具 |
|------|------|
| **导航** | `browser_open`, `browser_navigate`, `browser_navigate_back`, `browser_tabs` |
| **快照** | `browser_snapshot`（支持 aria/text/html） |
| **交互** | `browser_click`, `browser_type`, `browser_hover`, `browser_drag`, `browser_select_option`, `browser_press_key` |
| **表单** | `browser_fill_form`, `browser_file_upload` |
| **等待** | `browser_wait_for` |
| **JavaScript** | `browser_evaluate`, `browser_run_code`（需启用） |
| **截图/PDF** | `browser_take_screenshot`, `browser_pdf_save` |
| **诊断** | `browser_console_messages`, `browser_network_requests` |
| **生命周期** | `browser_close`, `browser_install`, `browser_cleanup` |
| **鼠标** | `browser_mouse_click_xy`, `browser_mouse_move_xy`, `browser_mouse_drag_xy` |
| **验证** | `browser_verify_element_visible`, `browser_verify_text_visible`, `browser_verify_value` |
| **追踪** | `browser_start_tracing`, `browser_stop_tracing` |

#### 扩展工具（独有）

| 工具 | 说明 |
|------|------|
| `request` | 用浏览器上下文发 HTTP 请求（保留 Cookie），返回 JSON/text |
| `wait_for_response` | 等待匹配 URL 片段的网络响应并返回 body |

### 🔄 从旧版迁移

旧版 Lite 工具已移除，替换如下：

| 旧工具 | 新工具 |
|--------|--------|
| `browse` | `browser_open` 或 `browser_navigate` |
| `navigate` | `browser_navigate` |
| `interact` | `browser_click` / `browser_type` / `browser_select_option` |
| `extract` | `browser_snapshot` / `browser_take_screenshot` |
| `execute_script` | `browser_evaluate`（或 `browser_run_code`） |
| `close` | `browser_close` |

### 💾 磁盘占用与清理

临时文件默认目录：
- **Windows**: `%TEMP%\patchright-mcp`
- **Linux/macOS**: `/tmp/patchright-mcp`

包含子目录：
- `profiles/` - 持久化浏览器 profile
- `downloads/` - 下载文件
- `traces/` - 追踪记录
- `pdfs/` - PDF 导出

**建议**：周期性调用 `browser_cleanup` 清理，注意清理 profiles 会清除登录态。

### ⚙️ 环境变量

| 变量 | 说明 |
|------|------|
| `PATCHRIGHT_MCP_CAPS` | 可选能力（逗号分隔：`vision,pdf,testing,tracing`；支持 `all`）。不设置时默认全开 |
| `PATCHRIGHT_MCP_ENABLE_RUN_CODE=1` | 启用 `browser_run_code`（危险能力，默认关闭） |
| `PATCHRIGHT_MCP_SECRETS_JSON` | 对输出文本中的敏感信息做掩码（JSON 对象，如 `{"openai":"sk-..."}`) |
| `PATCHRIGHT_MCP_SECRETS` | 同上（别名） |

### 📄 License

Apache-2.0（见 [LICENSE](LICENSE)）

---

## English

An MCP (Model Context Protocol) server powered by **Patchright Node.js SDK** (Playwright-compatible with stealth enhancements). Designed for AI agents with comprehensive browser automation capabilities.

### ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🎭 **Stealth Browsing** | Based on Patchright, bypasses common anti-bot detection (CDP/Webdriver fingerprints) |
| 🎯 **ARIA Snapshot + Ref Targeting** | Use `browser_snapshot(type="aria")` to get snapshots with `ref`s for precise element interaction |
| 🔄 **Session Persistence** | Persistent profiles keep login state by default |
| 📦 **Structured Responses** | Returns `result/code/tabs/console/downloads/page/snapshot/images` |
| 🧹 **Disk Hygiene** | `browser_cleanup` cleans temp files to prevent disk bloat |
| 🌐 **HTTP Extensions** | `request` / `wait_for_response` for browser-context HTTP requests with cookies |

### 📋 Requirements

- **Node.js** 18+
- **npm** or **pnpm**

### 🚀 Quick Start (No Source Code Download)

#### Option 1: npx (Recommended)

```bash
npx @a3180623/patchright-mcp
```

Claude Desktop config:
```json
{
  "mcpServers": {
    "patchright": {
      "command": "npx",
      "args": ["-y", "@a3180623/patchright-mcp"]
    }
  }
}
```

#### Option 2: Global Install

```bash
npm install -g @a3180623/patchright-mcp
patchright-mcp
```

### 📦 Install from Source

```bash
# Clone repository
git clone https://github.com/Frankieli123/patchright-mcp.git
cd patchright-mcp

# Install dependencies
npm ci

# Build project
npm run build
```

**Install browser binaries** (pick one):

```bash
# Option 1: CLI install
npx patchright install chromium

# Option 2: MCP tool (recommended for remote/container environments)
# Call browser_install tool
```

### ▶️ Running

```bash
# Production mode
npm start

# Development mode (hot reload)
npm run dev
```

**Optional capabilities** (via `--caps` or env `PATCHRIGHT_MCP_CAPS`):

```bash
# Enable only vision and pdf
npm start -- --caps=vision,pdf

# Enable all capabilities
npm start -- --caps=all
```

### 🔧 Integration

#### Claude Desktop

Edit `claude-desktop-config.json`:

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

### 📖 Recommended Workflow (ARIA Snapshot + Ref)

**Step 1: Get page snapshot**

```json
{ "type": "aria" }
```

Returns ARIA snapshot with `ref` identifiers:
```
[ref=123] button "Login"
[ref=456] textbox "Username"
```

**Step 2: Interact using ref**

```json
{
  "target": { "kind": "ref", "element": "Login button", "ref": "123" }
}
```

**Fallback: CSS selector**

```json
{
  "target": { "kind": "selector", "selector": "#login-btn" }
}
```

### 🛠️ Tools Overview

#### Core Tools (Playwright MCP Style)

| Category | Tools |
|----------|-------|
| **Navigation** | `browser_open`, `browser_navigate`, `browser_navigate_back`, `browser_tabs` |
| **Snapshot** | `browser_snapshot` (aria/text/html) |
| **Interaction** | `browser_click`, `browser_type`, `browser_hover`, `browser_drag`, `browser_select_option`, `browser_press_key` |
| **Forms** | `browser_fill_form`, `browser_file_upload` |
| **Wait** | `browser_wait_for` |
| **JavaScript** | `browser_evaluate`, `browser_run_code` (requires enable) |
| **Screenshot/PDF** | `browser_take_screenshot`, `browser_pdf_save` |
| **Diagnostics** | `browser_console_messages`, `browser_network_requests` |
| **Lifecycle** | `browser_close`, `browser_install`, `browser_cleanup` |
| **Mouse** | `browser_mouse_click_xy`, `browser_mouse_move_xy`, `browser_mouse_drag_xy` |
| **Verification** | `browser_verify_element_visible`, `browser_verify_text_visible`, `browser_verify_value` |
| **Tracing** | `browser_start_tracing`, `browser_stop_tracing` |

#### Extension Tools (Unique)

| Tool | Description |
|------|-------------|
| `request` | HTTP request using browser context (with cookies), returns JSON/text |
| `wait_for_response` | Wait for network response matching URL substring and return body |

### 🔄 Migration from Legacy

Legacy Lite tools removed. Replacements:

| Old | New |
|-----|-----|
| `browse` | `browser_open` or `browser_navigate` |
| `navigate` | `browser_navigate` |
| `interact` | `browser_click` / `browser_type` / `browser_select_option` |
| `extract` | `browser_snapshot` / `browser_take_screenshot` |
| `execute_script` | `browser_evaluate` (or `browser_run_code`) |
| `close` | `browser_close` |

### 💾 Disk Usage & Cleanup

Default temp directory:
- **Windows**: `%TEMP%\patchright-mcp`
- **Linux/macOS**: `/tmp/patchright-mcp`

Subdirectories: `profiles/`, `downloads/`, `traces/`, `pdfs/`

**Recommendation**: Periodically call `browser_cleanup`. Note: cleaning profiles will clear login state.

### ⚙️ Environment Variables

| Variable | Description |
|----------|-------------|
| `PATCHRIGHT_MCP_CAPS` | Capabilities (comma-separated: `vision,pdf,testing,tracing`; supports `all`). All enabled by default |
| `PATCHRIGHT_MCP_ENABLE_RUN_CODE=1` | Enable `browser_run_code` (dangerous; disabled by default) |
| `PATCHRIGHT_MCP_SECRETS_JSON` | Mask sensitive info in output (JSON object, e.g., `{"openai":"sk-..."}`) |
| `PATCHRIGHT_MCP_SECRETS` | Same as above (alias) |

### 📄 License

Apache-2.0 (see [LICENSE](LICENSE))
