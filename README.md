# Stealth Browser MCP

A local [Model Context Protocol](https://modelcontextprotocol.io/) server for automating a real, visible Firefox browser through WebDriver BiDi, plus a stealth Chromium/nodriver engine for hardened challenges. It provides focused tools for navigation, page reading, form interaction, screenshots, tab management, browser fingerprint diagnostics, and anti-bot evasion.

The MCP process communicates over stdio. A persistent local daemon owns the Firefox connection, so MCP calls and the command-line client use the same browser session.

## Features

- Start, inspect, restart, and stop the browser; list open tabs.
- Open pages, read visible text, extract matching elements, and wait for selectors.
- Click, type, fill fields, and press keys with human-paced input.
- Capture screenshots, with a safeguard that blocks capture while a password field is visible unless explicitly allowed.
- Inspect the current page's browser fingerprint signals.
- Use a persistent Firefox profile so site sessions can remain available between runs.
- **Anti-bot resistance** — drives a real system Firefox with a genuine fingerprint (user agent, fonts, TLS, plugins). It reduces automation indicators. Hardened challenges (e.g. Cloudflare managed interstitials) are detected and can be solved with the Chromium/nodriver engine. Results vary by site, region, browser version, and detector version.
- **CAPTCHA and human-verification handling** — automatically detects verification interstitials (Cloudflare "Just a moment", "Verify you are human", reCAPTCHA/hCaptcha prompts, security checks). Simple challenges are waited out and re-checked; harder ones can be solved with `browser_chromium_solve`.
- **Two engines** — Firefox (default, visible) and Chromium/nodriver (stealth) for harder challenges.
- **Ephemeral Chromium profiles** — challenge solves use a temp profile under `/tmp/opencode` that is deleted after the run; no passwords or sessions persist.

## Requirements

- Node.js 22.12 or newer.
- Firefox installed on the host.
- Python 3.10+ with `nodriver` and Chrome for Testing (for Chromium challenge solving).
- A desktop session for the visible browser window.

## Install

```bash
git clone https://github.com/saad-git-007/stealth-browser-mcp.git
cd stealth-browser-mcp
npm ci
pip install --break-system-packages nodriver
```

## Configure an MCP client

Point your MCP client to `scripts/mcp-server.mjs` using an absolute path:

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "node",
      "args": ["/absolute/path/to/stealth-browser-mcp/scripts/mcp-server.mjs"]
    }
  }
}
```

## Engines

1. **Firefox (default)** — real system Firefox over WebDriver BiDi. Best for everyday browsing, forms, and signed-in sessions.
2. **Chromium (stealth)** — Chrome for Testing with nodriver. More robust against hardened anti-bot/Cloudflare challenges. Use `browser_chromium_solve(url)` (MCP) or `python3 scripts/nodriver-solve.py <url>` (CLI).

When not specified, the agent should ask: (1) Firefox or nodriver Chromium? (2) hidden virtual screen (xvfb) or real desktop display?

## Stealth and anti-bot evasion

- A preload makes `navigator.webdriver` report `false` to page JavaScript.
- The dedicated profile enables Firefox’s `browser.chrome.disableRemoteControlCueForTests` preference, and `userChrome.css` hides the URL-bar remote-control icon.
- Pointer movement and typing use human-paced delays.
- Firefox runs with a persistent, dedicated profile.
- Real system Firefox is used; we do not fabricate a fake `window.chrome`.
- **CAPTCHA / challenge handling**: verification interstitials are detected. Simple ones are waited out; harder ones can be solved with the Chromium/nodriver engine on a real or virtual display.

## Safety and privacy

This server can navigate websites, read page content, run page JavaScript, and interact with forms using the configured Firefox profile. That profile may contain signed-in sessions and cookies. Keep the MCP server local and only connect trusted clients.

The browser window is visible to the user. The screenshot tool refuses to capture a page with a visible password field unless its explicit override is used with user approval. CAPTCHAs and other human verifications are detected and handled; review actions before submitting applications, purchases, or other consequential forms.

Chromium challenge solves use an ephemeral profile under `/tmp/opencode` that is deleted immediately after the run, so no passwords, cookies, or sessions persist between solves. Firefox keeps a dedicated persistent profile; disable its password manager if you do not want credentials stored.

## Toolbox

| Group | Tools |
|---|---|
| Browser management | `browser_start`, `browser_status`, `browser_stop`, `browser_restart`, `browser_tabs` |
| Navigation & reading | `browser_open`, `browser_text`, `browser_extract`, `browser_wait` |
| Interaction | `browser_click`, `browser_type`, `browser_fill`, `browser_press` |
| Inspection | `browser_js`, `browser_screenshot`, `browser_fingerprint` |
| Challenge solving | `browser_chromium_solve` |

## Project structure

```text
scripts/
  browser.mjs            Persistent Firefox daemon and command-line client
  mcp-server.mjs         MCP stdio server exposing the browser tools
  page-signals.mjs       Challenge/CAPTCHA detection helpers
  nodriver-solve.py      Chromium/nodriver challenge solver
  chromium-solve.mjs     (legacy) puppeteer stealth solver
```
