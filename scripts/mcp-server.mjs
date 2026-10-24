#!/usr/bin/env node
// MCP server exposing the browser-use daemon to MCP clients (OpenCode etc.).
// Design (borrowed from stealth-browser-mcp):
//  - FOCUSED tool surface (their "minimal mode"): ~16 well-described tools
//    beat a 100-tool wall for agent quality.
//  - stdout stays strictly JSON-RPC; ALL diagnostics go to stderr or to the
//    daemon log. Nothing else may print to stdout.
//  - every tool call shells out to browser.mjs (thin client → daemon → Firefox),
//    so MCP and CLI share one implementation and one connection.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SELF_DIR = path.dirname(new URL(import.meta.url).pathname);
const BROWSER = path.join(SELF_DIR, 'browser.mjs');
const SHOTS_DIR = '/tmp/opencode';

function callBrowser(cmd, argv = [], timeoutSec = 300) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--no-warnings', BROWSER, cmd, ...argv],
      { timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (stdout) {
          const text = stdout.trim();
          try {
            const parsed = JSON.parse(text); // whole pretty-printed document
            return resolve(parsed);
          } catch {
            // tolerate stray output lines: parse from first '{' to last '}'
            try {
              const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
              return resolve(parsed);
            } catch { /* fall through to error */ }
          }
        }
        resolve({ ok: false, error: (err && err.message || stderr || 'no output').split('\n').slice(0, 3).join(' | ') });
      });
  });
}

const JSON_OK = (r) => {
  const { ok, ...rest } = r || {};
  if (ok === false) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, ...rest }, null, 2) }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(rest, null, 2) }] };
};

const server = new McpServer({
  name: 'browser-use',
  version: '2.0.0',
}, {
  instructions: [
    'Controls the user\'s REAL visible Firefox (stealth: navigator.webdriver=false, remote-control banner hidden, humanized typing/clicking, persistent cookies/profile).',
    'Flow: browser_start → browser_open-url → verify with browser_text / browser_screenshot → interact with browser_click / browser_type / browser_fill.',
    'Indeed job search: browser_indeed (tld: com|ca|uk|in|au). Fingerprint self-audit: browser_fingerprint.',
    'Ask the user BEFORE submitting applications or payment forms. Never solve CAPTCHAs — ask the user.',
  ].join('\n'),
});

const reg = (name, desc, schema, fn) => server.registerTool(name, { description: desc, inputSchema: schema }, fn);

// ----- lifecycle -----
reg('browser_start', 'Start/ensure the stealth Firefox window + daemon. Idempotent; call before anything else.', {},
  () => callBrowser('start').then(JSON_OK));
reg('browser_status', 'Is the browser running? Lists tabs with URLs and titles.', {}, () => callBrowser('status').then(JSON_OK));
reg('browser_stop', 'Close the stealth browser and its daemon entirely.', {}, () => callBrowser('stop').then(JSON_OK));
reg('browser_restart', 'Recycle ONLY the browser (fresh session pool), keep daemon.', {}, () => callBrowser('restart').then(JSON_OK));
reg('browser_tabs', 'List open tabs of the browser, each with its index and its current page URL/title.', {}, () => callBrowser('tabs').then(JSON_OK));

// ----- navigation & reading -----
reg('browser_open', 'Navigate the active tab to a URL and return {url, title, text}. Waits out Cloudflare-style interstitials automatically.', { url: z.string() },
  (a) => callBrowser('open', [a.url]).then(JSON_OK));
reg('browser_text', 'Full visible text of the active page (≤6000 chars). Use to read content.', {},
  () => callBrowser('text').then(JSON_OK));
reg('browser_extract', 'Extract innerText (or an attribute) of all elements matching a CSS selector.', {
  selector: z.string(), attr: z.string().optional(), limit: z.number().optional(),
}, (a) => {
  const argv = [a.selector];
  if (a.attr) argv.push('--attr', a.attr);
  if (a.limit) argv.push('--limit', String(a.limit));
  return callBrowser('extract', argv).then(JSON_OK);
});
reg('browser_wait', 'Wait until a CSS selector exists (max ms).', { selector: z.string(), ms: z.number().optional() },
  (a) => callBrowser('wait', [a.selector, String(a.ms ?? 10000)]).then(JSON_OK));

// ----- interaction (humanized) -----
reg('browser_click', 'Humanized click on a CSS selector, @text=Button label, or @role=button:Name.', { selector: z.string() },
  (a) => callBrowser('click', [a.selector]).then(JSON_OK));
reg('browser_type', 'Humanized typing (45–160 ms/char) into a field. Keeps focus afterward — combine with browser_press Enter to submit search boxes.', { selector: z.string(), text: z.string() },
  (a) => callBrowser('type', [a.selector, a.text], 600).then(JSON_OK));
reg('browser_fill', 'Fill multiple fields at once (keys fuzzy-match name/id/placeholder/labels). Values are typed humanized. Returns filled/missing lists.', { fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) },
  (a) => callBrowser('fill', [JSON.stringify(a.fields)], 600).then(JSON_OK));
reg('browser_press', 'Press a key (Enter, Tab, Escape, ArrowDown…).', { key: z.string() },
  (a) => callBrowser('press', [a.key]).then(JSON_OK));

// ----- advanced -----
reg('browser_js', 'Evaluate JavaScript in the page (expression or statements). Use for probing DOM/sites with no selectors.', { code: z.string() },
  (a) => callBrowser('js', [a.code]).then(JSON_OK));
reg('browser_screenshot', 'PNG screenshot of the active tab. Returns path + the rendered image. BLOCKED while a password field is on the page unless allow=true (ask the user first — a manually revealed password could appear).', { path: z.string().optional(), fullPage: z.boolean().optional(), allow: z.boolean().optional() },
  (a) => {
    const argv2 = [a.path || `/tmp/opencode/browser-${Date.now()}.png`];
    if (a.allow) argv2.push('--allow');
    return callBrowser('screenshot', argv2, 120).then(async (r) => {
      const { ok, screenshot: shot, ...rest } = r || {};
      const out = { content: [{ type: 'text', text: JSON.stringify(ok === false ? { ok, ...rest } : { screenshot: shot, ...rest }, null, 2) }] };
      if (ok !== false) {
        try {
          if (shot && fs.existsSync(shot)) {
            const b64 = fs.readFileSync(shot).toString('base64');
            if (b64.length < 6_000_000) out.content.push({ type: 'image', data: b64, mimeType: 'image/png' });
          }
        } catch { /* text only */ }
      }
      return out;
    });
  });
reg('browser_indeed', 'Search jobs on Indeed (country via tld: com/ca/uk/in/au; ca = ca.indeed.com). Returns parsed jobs with title/company/location/salary/link/jk.', {
  query: z.string(), location: z.string().optional(), tld: z.string().optional(), page: z.number().optional(),
}, (a) => {
  const argv = [a.query];
  if (a.location) argv.push('--location', a.location);
  if (a.tld) argv.push('--tld', a.tld);
  if (a.page != null) argv.push('--page', String(a.page));
  return callBrowser('indeed', argv, 420).then(JSON_OK);
});
reg('browser_fingerprint', 'Stealth self-audit: run the same JS checks bot-detection run on the page (webdriver flag, chrome object, plugins, WebGL…). Should report zero issues.', {},
  () => callBrowser('fingerprint').then(JSON_OK));

process.stderr.write('browser-use MCP server starting (tools talk to the Firefox daemon)…\n');
await server.connect(new StdioServerTransport());
process.stderr.write('browser-use MCP server connected over stdio.\n');
