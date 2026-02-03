# Patchright Lite MCP Server

A streamlined Model Context Protocol (MCP) server that wraps the Patchright Node.js SDK to provide stealth browser automation capabilities to AI models. This lightweight server focuses on essential functionality to make it easier for simpler AI models to use.

## What is Patchright?

Patchright is an undetected version of the Playwright testing and automation framework. It's designed as a drop-in replacement for Playwright, but with advanced stealth capabilities to avoid detection by anti-bot systems. Patchright patches various detection techniques including:

- Runtime.enable leak
- Console.enable leak
- Command flags leaks
- General detection points
- Closed Shadow Root interactions

This MCP server wraps the Node.js version of Patchright to make its capabilities available to AI models through a simple, standardized protocol.

## Features

- **Simple Interface**: Focused on core functionality with a small set of tools
- **Stealth Automation**: Uses Patchright's stealth mode to avoid detection
- **MCP Standard**: Implements the Model Context Protocol for easy AI integration
- **Stdio Transport**: Uses standard input/output for seamless integration

## Prerequisites

- Node.js 18+
- npm or yarn

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/patchright-lite-mcp-server.git
   cd patchright-lite-mcp-server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the TypeScript code:
   ```bash
   npm run build
   ```

4. Install Chromium-Driver for Pathright:
   ```bash
   npx patchright install chromium
   ```


## Usage

Run the server with:

```bash
npm start
```

This will start the server with stdio transport, making it ready to integrate with AI tools that support MCP.

## Integrating with AI Models

### Claude Desktop

Add this to your `claude-desktop-config.json` file:

```json
{
  "mcpServers": {
    "patchright": {
      "command": "node",
      "args": ["path/to/patchright-lite-mcp-server/dist/index.js"]
    }
  }
}
```

### VS Code with GitHub Copilot

Use the VS Code CLI to add the MCP server:

```bash
code --add-mcp '{"name":"patchright","command":"node","args":["path/to/patchright-lite-mcp-server/dist/index.js"]}'
```

## Available Tools

The server provides the following tools:

### 1. browse

Navigates to a URL and extracts content. By default it reuses a persistent profile (`profile: "default"`) to preserve login/session state across calls and server restarts. Use different `profile` names for multi-account isolation, or `isolated: true` for a temporary clean session.

```
Tool: browse
Parameters: {
  "url": "https://example.com",
  "headless": true,
  "profile": "default",
  "waitUntil": "load",
  "waitFor": 1000,
  "isolated": false,
  "newPage": false
}
```

Returns:
- Page title
- Visible text preview
- Browser ID (for subsequent operations)
- Page ID (for subsequent operations)
- Screenshot path

### 2. interact

Performs a simple interaction on a page.

```
Tool: interact
Parameters: {
  "browserId": "browser-id-from-browse",
  "pageId": "page-id-from-browse", // optional
  "action": "click", // can be "click", "fill", or "select"
  "selector": "#submit-button",
  "value": "Hello World" // only needed for fill and select
}
```

Returns:
- Action result
- Current URL
- Screenshot path

### 3. extract

Extracts specific content from the current page.

```
Tool: extract
Parameters: {
  "browserId": "browser-id-from-browse",
  "pageId": "page-id-from-browse", // optional
  "type": "text" // can be "text", "html", or "screenshot"
}
```

Returns:
- Extracted content based on the requested type

### 4. close

Closes a browser to free resources.

```
Tool: close
Parameters: {
  "browserId": "browser-id-from-browse"
}
```

### 5. navigate

Reuses an existing page and navigates to a new URL (preserves login/session state).

```
Tool: navigate
Parameters: {
  "browserId": "browser-id-from-browse",
  "pageId": "page-id-from-browse", // optional
  "url": "https://example.com/dashboard",
  "waitFor": 1000,
  "waitUntil": "load"
}
```

### 6. execute_script

Executes JavaScript in the page context and returns the result.

```
Tool: execute_script
Parameters: {
  "browserId": "browser-id-from-browse",
  "pageId": "page-id-from-browse", // optional
  "code": "return localStorage.getItem('accessToken')"
}
```

### 7. request

Sends an HTTP request using the page's browser context (cookies/session preserved, no CORS) and returns JSON/text.

```
Tool: request
Parameters: {
  "browserId": "browser-id-from-browse",
  "pageId": "page-id-from-browse", // optional
  "method": "POST",
  "url": "https://example.com/api/checkout",
  "headers": { "content-type": "application/json" },
  "data": { "plan": "pro" },
  "responseType": "json"
}
```

### 8. wait_for_response

Waits for a network response matching a URL substring and returns its JSON/text body.

```
Tool: wait_for_response
Parameters: {
  "browserId": "browser-id-from-browse",
  "pageId": "page-id-from-browse", // optional
  "urlContains": "/api/checkout",
  "timeoutMs": 30000,
  "responseType": "json"
}
```

## Playwright-style Tools

For compatibility with Playwright MCP style clients, this server also exposes `browser_*` tools. Most of them default to `browserId = profile:default` if omitted (create a session first with `browse` or `browser_navigate`).

- Navigation/session: `browser_open`, `browser_navigate`, `browser_navigate_back`, `browser_tabs`, `browser_snapshot`, `browser_wait_for`
- Input/actions: `browser_click`, `browser_type`, `browser_press_key`, `browser_press_sequentially`, `browser_hover`, `browser_drag`, `browser_mouse_move_xy`, `browser_mouse_click_xy`, `browser_mouse_drag_xy`, `browser_select_option`, `browser_fill_form`, `browser_file_upload`, `browser_handle_dialog`, `browser_resize`, `browser_take_screenshot`
- Logs: `browser_console_messages`, `browser_network_requests`
- JS: `browser_evaluate`
- Output: `browser_pdf_save`
- Tracing: `browser_start_tracing`, `browser_stop_tracing`
- Testing helpers: `browser_generate_locator`, `browser_verify_element_visible`, `browser_verify_text_visible`, `browser_verify_list_visible`, `browser_verify_value`
- Lifecycle: `browser_close`, `browser_install`

Notes:
- `browser_run_code` exists for parity but is disabled by default. Set `PATCHRIGHT_MCP_ENABLE_RUN_CODE=1` to enable it.
- `browser_generate_locator` / `browser_verify_*` treat `ref` as a Playwright locator selector in this server (not Playwright MCP's snapshot-ref system).

## Example Usage Flow

1. Launch a browser and navigate to a site:
   ```
   Tool: browse
   Parameters: {
     "url": "https://example.com/login",
     "headless": false
   }
   ```

2. Fill in a login form:
   ```
   Tool: interact
   Parameters: {
     "browserId": "browser-id-from-step-1",
     "pageId": "page-id-from-step-1",
     "action": "fill",
     "selector": "#username",
     "value": "user@example.com"
   }
   ```

3. Fill in password:
   ```
   Tool: interact
   Parameters: {
     "browserId": "browser-id-from-step-1",
     "pageId": "page-id-from-step-1",
     "action": "fill",
     "selector": "#password",
     "value": "password123"
   }
   ```

4. Click the login button:
   ```
   Tool: interact
   Parameters: {
     "browserId": "browser-id-from-step-1",
     "pageId": "page-id-from-step-1",
     "action": "click",
     "selector": "#login-button"
   }
   ```

5. Extract text to verify login:
   ```
   Tool: extract
   Parameters: {
     "browserId": "browser-id-from-step-1",
     "pageId": "page-id-from-step-1",
     "type": "text"
   }
   ```

6. Close the browser:
   ```
   Tool: close
   Parameters: {
     "browserId": "browser-id-from-step-1"
   }
   ```

## Security Considerations

- This server provides powerful automation capabilities. Use it responsibly and ethically.
- Avoid automating actions that would violate websites' terms of service.
- Be mindful of rate limits and don't overload websites with requests.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Patchright-nodejs by Kaliiiiiiiiii-Vinyzu
- Model Context Protocol by modelcontextprotocol

## Docker Usage

You can run this server using Docker:

```bash
docker run -it --rm dylangroos/patchright-mcp
```

### Building the Docker Image Locally

Build the Docker image:

```bash
docker build -t patchright-mcp .
```

Run the container:

```bash
docker run -it --rm patchright-mcp
```

### Docker Hub

The image is automatically published to Docker Hub when changes are merged to the main branch.
You can find the latest image at: [dylangroos/patchright-mcp](https://hub.docker.com/r/dylangroos/patchright-mcp)
