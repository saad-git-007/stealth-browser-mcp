# Stealth Browser MCP

**Stealth browser automation for AI agents (Claude, Codex, OpenCode, Cursor, and any MCP client).**

This repository is a **stealth browsing** MCP server: it drives a **real Firefox** (and, for hardened targets, a **stealth Chromium via nodriver**) to **bypass anti-bot detection** and automate real sites — Cloudflare challenges, login walls, forms, job search, and more — while looking like a normal human user.

- **Stealth browsing**: real system Firefox/Chromium with a genuine fingerprint (UA, fonts, TLS, plugins). No fake `window.chrome` or UA spoofing.
- **Anti-bot bypass**: patches `navigator.webdriver`, hides the remote-control cue, humanizes typing/clicking, uses persistent profiles, and can solve Cloudflare managed challenges with nodriver.
- **Two engines**: Firefox (default) + Chromium/nodriver (stealth) for tougher challenges.
- **Ready-to-use MCP**: clone, `npm ci`, add the config snippet, and any LLM can call the tools.

## What this repo does (at a glance)

- Automates a browser over MCP (stdio) with ~17 focused tools.
- Detects and solves Cloudflare/anti-bot challenges (nodriver Chromium).
- Handles CAPTCHAs and human-verification flows (wait, then hand off if needed).
- Keeps passwords safe: Chromium solves use ephemeral profiles deleted after each run.

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
- **Two engines** — Firefox (default) and Chromium/nodriver (stealth) for harder challenges.
- **Ephemeral Chromium profiles** — challenge solves use a temp profile under `/tmp/opencode` that is deleted after the run; no passwords or sessions persist.

## Requirements

- Node.js 22.12 or newer.
- Firefox installed on the host.
- Python 3.10+ with `nodriver` and Chrome for Testing (for Chromium challenge solving).
- A desktop session for the browser window.

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

The screenshot tool refuses to capture a page with a password field unless its explicit override is used with user approval. CAPTCHAs and other human verifications are detected and handled; review actions before submitting applications, purchases, or other consequential forms.

Chromium challenge solves use an ephemeral profile under `/tmp/opencode` that is deleted immediately after the run, so no passwords, cookies, or sessions persist between solves. Firefox keeps a dedicated persistent profile; disable its password manager if you do not want credentials stored.

## Main tools (MCP)

| Tool | Purpose |
|---|---|
| `browser_start` / `status` / `stop` / `restart` / `tabs` | Browser lifecycle & tab listing |
| `browser_open` / `text` / `extract` / `wait` | Navigate & read pages |
| `browser_click` / `type` / `fill` / `press` | Humanized interaction |
| `browser_js` / `screenshot` / `fingerprint` | Advanced inspection |
| `browser_chromium_solve` | Solve Cloudflare/anti-bot challenges via nodriver Chromium |

## Add this MCP to any LLM (ready to go)

1. Clone & install:
   ```bash
   git clone https://github.com/saad-git-007/stealth-browser-mcp.git
   cd stealth-browser-mcp
   npm ci
   pip install --break-system-packages nodriver
   ```
2. Add to your MCP client config:
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
3. Restart the client — tools `browser_*` (including `browser_chromium_solve`) become available.

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
