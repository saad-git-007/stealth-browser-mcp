# Browser Use MCP

A local [Model Context Protocol](https://modelcontextprotocol.io/) server for automating a real, visible Firefox browser through WebDriver BiDi. It provides focused tools for navigation, page reading, form interaction, screenshots, tab management, and Indeed job search.

The MCP process communicates over stdio. A persistent local daemon owns the Firefox connection, so MCP calls and the command-line client use the same browser session.

## Features

- Start, inspect, restart, and stop the browser; list open tabs.
- Open pages, read visible text, extract matching elements, and wait for selectors.
- Click, type, fill fields, and press keys with human-paced input.
- Capture screenshots, with a safeguard that blocks capture while a password field is visible unless explicitly allowed.
- Search Indeed for jobs by query and location.
- Inspect the current page's browser fingerprint signals.
- Use a persistent Firefox profile so site sessions can remain available between runs.

## Requirements

- Node.js 22.12 or newer (required by the current Puppeteer browser tooling dependencies).
- Firefox installed on the host. The launcher checks common Snap and system Firefox locations.
- A desktop session for the visible browser window.

## Install

```bash
git clone https://github.com/saad-git-007/browser-use-mcp.git
cd browser-use-mcp
npm ci
```

## Configure an MCP client

Point your MCP client to `scripts/mcp-server.mjs` using an absolute path. For clients that use the standard `mcpServers` JSON shape:

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "node",
      "args": ["/absolute/path/to/browser-use-mcp/scripts/mcp-server.mjs"]
    }
  }
}
```

Restart or reload the MCP client after saving its configuration. The server writes startup diagnostics to stderr; its stdout is reserved for MCP protocol messages.

## Start the browser manually

The MCP server starts the browser when needed. You can also use the CLI directly:

```bash
node scripts/browser.mjs start
node scripts/browser.mjs status
node scripts/browser.mjs tabs
node scripts/browser.mjs stop
```

The CLI prints JSON. Run `node scripts/browser.mjs` without a command to see the available commands.

## Configuration

These environment variables can be set in the MCP client's server configuration:

| Variable | Default | Purpose |
|---|---|---|
| `BROWSER_USE_PORT` | `9222` | Local Firefox WebDriver BiDi port. |
| `BROWSER_USE_SOCK` | `/tmp/opencode/browser-use.sock` | Unix socket used by the daemon and CLI. |
| `BROWSER_USE_LOG` | `/tmp/opencode/browser-use-daemon.log` | Daemon log path. |
| `BROWSER_USE_PROFILE` | `~/snap/firefox/common/browser-use-profile` | Persistent Firefox profile directory. |
| `BROWSER_IDLE_TIMEOUT` | `0` | Optional daemon idle timeout in seconds; `0` leaves it running. |

## Safety and privacy

This server can navigate websites, read page content, run page JavaScript, and interact with forms using the configured Firefox profile. That profile may contain signed-in sessions and cookies. Keep the MCP server local and only connect trusted clients. Do not provide secrets to page JavaScript or expose profile data.

The browser window is visible to the user. The screenshot tool refuses to capture a page with a visible password field unless its explicit override is used with user approval. If a CAPTCHA or other human verification appears, solve it in the visible browser yourself; this project does not automate CAPTCHA solving. Review actions before submitting applications, purchases, or other consequential forms.

The implementation uses Firefox/WebDriver BiDi rather than pretending to be another browser engine. It includes small compatibility adjustments for Firefox automation, including hiding Firefox's remote-control cue and setting `navigator.webdriver` to false; it does not spoof a Chromium fingerprint.

## Project structure

```text
scripts/
  browser.mjs      Persistent Firefox daemon and command-line client
  mcp-server.mjs   MCP stdio server exposing the browser tools
```
