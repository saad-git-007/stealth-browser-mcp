#!/usr/bin/env node
// browser-use: drive the user's real (snap) Firefox over WebDriver BiDi.
//
// ARCHITECTURE (v2): Firefox does NOT free BiDi sessions when the controlling
// WebSocket closes, and caps concurrent sessions — so a persistent DAEMON
// holds the single connection; CLI invocations are thin clients over a local
// unix socket (JSON lines). `serve` runs the daemon; everything else talks to
// it. This also makes every command ~instant.
//
// STEALTH: real system Firefox = genuine fingerprint. We only neutralize the
// navigator.webdriver flag via a preload script and humanize pointer/typing
// behavior. No fake chrome object / UA spoofing (that would be a Chromium tell
// and a mismatch giveaway on Firefox).

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = parseInt(process.env.BROWSER_USE_PORT || '9222', 10);
const WS_URL = `ws://127.0.0.1:${PORT}/session`;
const SOCK = process.env.BROWSER_USE_SOCK || '/tmp/opencode/browser-use.sock';
const SOCK_DIR = path.dirname(SOCK);
const LOG = process.env.BROWSER_USE_LOG || '/tmp/opencode/browser-use-daemon.log';
const PROFILE = process.env.BROWSER_USE_PROFILE ||
  path.join(os.homedir(), 'snap/firefox/common/browser-use-profile');

const FIREFOX_CANDIDATES = [
  '/snap/firefox/current/usr/lib/firefox/firefox',
  '/snap/firefox/current/usr/lib/firefox/firefox-bin',
  '/usr/lib/firefox/firefox',
  '/usr/bin/firefox',
];
const FIREFOX = FIREFOX_CANDIDATES.find(f => fs.existsSync(f));

const HOME = os.homedir();

function out(obj, code = 0) { console.log(JSON.stringify(obj, null, 2)); process.exit(code); }
function fail(err) { out({ ok: false, error: String(err && err.message || err).split('\n').slice(0, 4).join(' | ') }, 1); }

// ---------------------------------------------------------------- daemonside

// --- GUI session env (borrowed from the user's own running desktop firefox) ---
function sessionEnv() {
  const env = { DISPLAY: ':0', XAUTHORITY: '', XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`, DBUS_SESSION_BUS_ADDRESS: '' };
  try {
    const pids = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p));
    const picks = [];
    for (const pid of pids) {
      try {
        const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
        if (comm !== 'firefox' && comm !== 'gnome-shell') continue;
        const raw = fs.readFileSync(`/proc/${pid}/environ`);
        const map = {};
        for (const kv of raw.toString().split('\0')) {
          const i = kv.indexOf('=');
          if (i > 0) map[kv.slice(0, i)] = kv.slice(i + 1);
        }
        if (map.DISPLAY || map.WAYLAND_DISPLAY) picks.push(map);
      } catch { /* permission */ }
    }
    picks.sort(a => (a ? -1 : 1)); // prefer entries with DISPLAY
    if (picks.length) {
      env.DISPLAY = picks[0].DISPLAY || env.DISPLAY;
      env.XAUTHORITY = picks[0].XAUTHORITY || '';
      env.XDG_RUNTIME_DIR = picks[0].XDG_RUNTIME_DIR || env.XDG_RUNTIME_DIR;
      env.DBUS_SESSION_BUS_ADDRESS = picks[0].DBUS_SESSION_BUS_ADDRESS || '';
    }
  } catch { /* best effort */ }
  return env;
}

// --- persistent profile prefs (quiet Firefox, no automation noise) ---
const USER_JS = String.raw`
// browser-use persistent profile prefs
user_pref("dom.webdriver.enabled", false);          // belt&braces with runtime patch
user_pref("browser.chrome.disableRemoteControlCueForTests", true); // hides "under remote control" URL-bar cue (needs MOZ_IN_AUTOMATION=1 env)
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.tabs.warnOnCloseOtherTabs", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.upgradeDialog.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.unified", false);
user_pref("app.shield.optoutstudies.enabled", false);
user_pref("browser.warnOnQuit", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
`;
// hides the #remote-control-icon cue in the URL bar even if the JS guard ever changes
const CHROME_CSS = `/* browser-use: hide the Firefox remote-control cue */
#remote-control-icon { display: none !important; }
#urlbar[remotecontrol], #urlbar[remotecontrol] * { cursor: auto !important; }
`;
function ensureProfile() {
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'user.js'), USER_JS);
  const chromeDir = path.join(PROFILE, 'chrome');
  fs.mkdirSync(chromeDir, { recursive: true });
  fs.writeFileSync(path.join(chromeDir, 'userChrome.css'), CHROME_CSS);
}

// --- kill leftover automation instances (only ours: debug port) ---
function findDebugPids() {
  const pids = [];
  for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    try {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      if (comm !== 'firefox') continue;
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`).toString().replace(/\0/g, ' ');
      if (cmd.includes(`remote-debugging-port=${PORT}`)) pids.push(parseInt(pid, 10));
    } catch { /* race */ }
  }
  return pids;
}
async function killDebug() {
  const pids = findDebugPids();
  for (const p of pids) { try { process.kill(p, 'SIGTERM'); } catch {} }
  for (let i = 0; i < 10; i++) {
    if (!findDebugPids().length) return pids.length;
    await sleep(500);
  }
  for (const p of findDebugPids()) { try { process.kill(p, 'SIGKILL'); } catch {} }
  return pids.length;
}

// --- endpoint readiness WITHOUT consuming a BiDi session ---
async function endpointReady(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500) });
      if (r.status) return true;
    } catch { /* not yet */ }
    await sleep(400);
  }
  return false;
}
function launchFirefox() {
  if (!FIREFOX) throw new Error('firefox binary not found');
  const env = sessionEnv();
  const child = spawn(FIREFOX, [
    '--no-remote', '--profile', PROFILE,
    `--remote-debugging-port=${PORT}`,
    '--width', '1280', '--height', '900',
  ], { env: { ...process.env, ...env, MOZ_IN_AUTOMATION: '1' }, detached: true, stdio: 'ignore' });
  child.unref();
}
async function connectFirefox(maxAttempts = 2) {
  // connect, and if Firefox's session budget is exhausted (leftover leaked
  // sessions in an old instance), recycle the debug instance and retry once
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await sleep(600);
      return await puppeteer.connect({ browserWSEndpoint: WS_URL, protocol: 'webDriverBiDi' });
    } catch (e) {
      if (i < maxAttempts - 1 && /Maximum number of active sessions|session not created/i.test(String(e))) {
        await killDebug();
        launchFirefox();
        if (!await endpointReady(25000)) throw new Error('firefox relaunch failed (port ' + PORT + ' never came up)');
      } else if (i < maxAttempts - 1) {
        await sleep(1200);
      } else {
        throw e;
      }
    }
  }
}

// --- stealth preload ---
const STEALTH_FN = () => {
  try {
    const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
    if (!d || !d.get || !d.get.toString().includes('=> false')) {
      Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
    }
  } catch { /* already patched */ }
};

const BUMARK = '__buActive';
const rnd = (a, b) => a + Math.random() * (b - a);
const sleepMs = ms => sleep(ms);
const truncate = (s, n) => (s === undefined ? '' : (s.length > n ? s.slice(0, n) + ` …[truncated]` : s));

// --- daemon state: ONE living connection ---
const S = { browser: null, page: null, interval: null, mouse: null };

async function harden(page) {
  await page.evaluateOnNewDocument(STEALTH_FN).catch(() => {});
  await page.evaluate(STEALTH_FN).catch(() => {});
}
async function ensureBrowser() {
  if (S.browser) {
    try {
      if (S.browser.connected === false) throw new Error('disconnected');
      return S.browser;
    } catch { S.browser = null; }
  }
  ensureProfile();
  const pids = findDebugPids();
  // reuse only instances started with OUR profile
  const ours = pids.some(pid => {
    try {
      const t = fs.readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean);
      const i = t.indexOf('--profile');
      return i >= 0 && t[i + 1] === PROFILE;
    } catch { return false; }
  });
  if (!ours && pids.length) await killDebug();
  if (!await endpointReady(ours ? 5000 : 100)) {
    launchFirefox();
    if (!await endpointReady(25000)) throw new Error('firefox remote agent did not come up on port ' + PORT);
    await sleep(600);
  }
  S.browser = await connectFirefox();
  for (const p of await S.browser.pages()) await harden(p);
  // gentle keepalive: keeps the BiDi session healthy while idle
  if (S.interval) clearInterval(S.interval);
  S.interval = setInterval(async () => {
    try { if (S.page) await S.page.evaluate('1'); } catch { /* navigating or busy */ }
  }, 24000);
  S.interval.unref?.();
  return S.browser;
}
async function activePage(browser) {
  const pages = await browser.pages();
  for (const p of pages) {
    try { if (await p.evaluate(`window.${BUMARK} === true`)) { await harden(p); return p; } } catch { /* crashed tab */ }
  }
  if (!pages.length) { const p = await browser.newPage(); await harden(p); S.page = p; return p; }
  if (pages.length === 1) { await markActive(pages[0]); return pages[0]; }
  // multiple tabs, none of ours: use the newest but do NOT steal the mark
  const p = pages[pages.length - 1];
  await harden(p);
  S.page = p;
  return p;
}
async function markActive(page) {
  S.page = page;
  try { await page.evaluate(`window.${BUMARK} = true`); } catch { }
}

// ---------------------------------------------------------------- humanizers

async function humanType(page, text, opts = {}) {
  const min = opts.minDelay ?? 45, max = opts.maxDelay ?? 160;
  let spaces = 0;
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 1 });
    let d = rnd(min, max);
    if (ch === ' ') {
      spaces++;
      if (spaces % Math.floor(rnd(5, 10)) === 0) d += rnd(180, 520);
    }
    if (ch === '\n' || ch === '\t') d += rnd(120, 400);
    await sleepMs(d);
  }
}
async function humanClickPoint(page, dest) {
  // BiDi input.performActions requires integer coords in Firefox → we step
  // manually along integer waypoints of a slightly wobbly path
  const last = S.mouse || { x: Math.floor(rnd(300, 700)), y: Math.floor(rnd(250, 550)) };
  const segs = Math.floor(rnd(4, 9));
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const gx = Math.round(last.x + (dest.x - last.x) * t + (i < segs ? rnd(-14, 14) : 0));
    const gy = Math.round(last.y + (dest.y - last.y) * t + (i < segs ? rnd(-10, 10) : 0));
    await page.mouse.move(gx, gy);
    await sleepMs(rnd(25, 70));
  }
  S.mouse = { x: Math.round(dest.x), y: Math.round(dest.y) };
  await sleepMs(rnd(50, 140));
}
async function humanClick(page, selOrText) {
  let el;
  if (selOrText.startsWith('@text=')) {
    const t = selOrText.slice(6);
    const h = await page.evaluateHandle((needle) => [...document
      .querySelectorAll('a, button, input[type=button], input[type=submit], [role=button], summary')]
      .find(e => (e.innerText || '').trim().toLowerCase().includes(needle.toLowerCase())) || null, t);
    el = h;
  } else if (selOrText.startsWith('@role=')) {
    const [role, name] = selOrText.slice(6).split(':');
    el = await page.evaluateHandle((r, n) =>
      [...document.querySelectorAll(`[role="${r}"]`)]
        .find(e => ((e.innerText || '') + (e.getAttribute('aria-label') || '')).toLowerCase().includes((n || '').toLowerCase())) || null,
      role, name || '');
  } else {
    el = await page.$(selOrText);
  }
  const isElement = el && await el.evaluate(e => e instanceof Element).catch(() => false);
  if (!isElement) throw new Error(`click: no element for ${selOrText}`);
  await el.evaluate(e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const box = await el.evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const jitter = { x: box.x + box.w / 2 + rnd(-0.18, 0.18) * box.w, y: box.y + box.h / 2 + rnd(-0.18, 0.18) * box.h };
  await humanClickPoint(page, jitter);
  await page.mouse.down(); await sleepMs(rnd(50, 140)); await page.mouse.up();
  await sleepMs(rnd(200, 500));
  return { clicked: selOrText, at: jitter };
}

// ---------------------------------------------------------------- form fill

const FILL_FN = (fields) => {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const filled = [], missing = [], typed = [];
  const els = [...document.querySelectorAll('input, textarea, select')];
  const visible = e => !e.disabled && e.type !== 'hidden' && (e.offsetParent !== null || e.getClientRects().length);
  const cssPath = (e) => {
    if (!(e instanceof Element)) return null;
    const parts = [];
    while (e && e.nodeType === 1 && parts.length < 6) {
      let sel = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(sel + '#' + e.id); break; }
      const sib = e.parentElement ? [...e.parentElement.children].filter(x => x.tagName === e.tagName) : [];
      if (sib.length > 1) sel += `:nth-of-type(${sib.indexOf(e) + 1})`;
      parts.unshift(sel);
      e = e.parentElement;
    }
    return parts.join(' > ');
  };
  const labelOf = (e) => {
    const t = [];
    if (e.labels) for (const l of e.labels) t.push(l.innerText || '');
    if (e.getAttribute('aria-label')) t.push(e.getAttribute('aria-label'));
    if (e.placeholder) t.push(e.placeholder);
    if (e.title) t.push(e.title);
    if (e.name) t.push(e.name);
    const wrap = e.closest('p, li, td, fieldset');
    if (wrap) { const lab = wrap.querySelector('label'); if (lab && !lab.contains(e)) t.push(lab.innerText); }
    return norm(t.join(' '));
  };
  const truthy = v => /^([1t](rue)?|y(es)?|on)$/i.test(String(v).trim());
  const fire = (e, ev) => e.dispatchEvent(new Event(ev, { bubbles: true }));
  for (const [key, value] of Object.entries(fields)) {
    const k = norm(key);
    let el = null;
    el ||= els.find(e => norm(e.name) === k);
    el ||= els.find(e => norm(e.id) === k);
    el ||= els.find(e => norm(e.placeholder) === k);
    el ||= els.find(e => norm(e.autocomplete) === k);
    el ||= els.find(e => e.getAttribute('aria-label') && norm(e.getAttribute('aria-label')) === k);
    if (!el) {
      const scored = els.filter(e => visible(e) && k.length > 1 && labelOf(e).includes(k));
      if (scored.length) el = scored[0];
    }
    if (!el || !visible(el)) { missing.push({ field: key, reason: 'no matching/visible field' }); continue; }
    if (el.type === 'checkbox') {
      const want = truthy(value);
      if (el.checked !== want) { fire(el, 'mousedown'); el.click(); fire(el, 'mouseup'); fire(el, 'change'); }
      filled.push({ field: key, as: want ? 'checked' : 'unchecked' }); continue;
    }
    if (el.type === 'radio') {
      const group = [...document.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)];
      const target = group.find(r => norm(r.value) === norm(value)) || group.find(r => norm(labelOf(r)) === norm(value));
      if (!target) { missing.push({ field: key, reason: `no radio with value ${value}` }); continue; }
      fire(target, 'mousedown'); target.click(); fire(target, 'mouseup'); fire(target, 'change');
      filled.push({ field: key, as: target.value }); continue;
    }
    if (el.tagName === 'SELECT') {
      const sv = norm(value);
      const opt = [...el.options].find(o => norm(o.value) === sv || norm(o.text) === sv || norm(o.text).includes(sv));
      if (!opt) { missing.push({ field: key, reason: `no option like ${value}` }); continue; }
      el.value = opt.value; opt.selected = true;
      fire(el, 'input'); fire(el, 'change');
      filled.push({ field: key, as: opt.text }); continue;
    }
    // text-ish input/textarea → CSS path out, human-typed by Node
    el.focus(); fire(el, 'focus');
    const p2 = cssPath(el);
    if (!p2) { missing.push({ field: key, reason: 'cannot build css path' }); continue; }
    filled.push({ field: key, as: 'text', length: String(value).length });
    typed.push({ selector: p2, value: String(value) });
  }
  return { filled, missing, typed };
};

async function doFill(page, fields) {
  const res = await page.evaluate(FILL_FN, fields);
  for (const t of res.typed) {
    const el = await page.$(t.selector);
    if (!el) { res.missing.push({ field: t.value, reason: 'path lost: ' + t.selector }); continue; }
    await el.evaluate(e => { e.select && e.select(); });
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await sleepMs(rnd(80, 220));
    await page.keyboard.press('Backspace');
    await sleepMs(rnd(200, 500));
    try { await humanType(page, t.value); }
    catch (e) { res.missing.push({ field: t.value, reason: 'typing interrupted: ' + e.message.split('\n')[0] }); continue; }
    await el.evaluate(e => { e.dispatchEvent(new Event('change', { bubbles: true })); if (e.blur) e.blur(); });
    await sleepMs(rnd(150, 400));
  }
  delete res.typed;
  return res;
}

// --- stealth self-audit: what can that page's JS see? (STEALTH_TESTS-style) ---
const FP_FN = () => {
  const issues = [];
  const wd = navigator.webdriver;
  if (wd === true) issues.push('navigator.webdriver is TRUE');
  if (typeof window.chrome !== 'undefined') issues.push('window.chrome exists on Firefox (injected)');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const gl = (() => { try {
    const c = document.createElement('canvas').getContext('webgl');
    const i = c.getExtension('WEBGL_debug_renderer_info');
    return i ? `${c.getParameter(i.UNMASKED_VENDOR_WEBGL)} / ${c.getParameter(i.UNMASKED_RENDERER_WEBGL)}` : 'masked';
  } catch { return 'none'; } })();
  return {
    webdriver: wd,
    chromeObject: typeof window.chrome,
    plugins: navigator.plugins.length,
    languages: navigator.languages,
    userAgentData: 'userAgentData' in navigator ? 'present (odd for FF)' : 'absent (correct for Firefox)',
    timezone: tz,
    hardwareConcurrency: navigator.hardwareConcurrency,
    webgl: gl,
    screen: `${screen.width}x${screen.height} dpr=${devicePixelRatio}`,
    issues,
  };
};

// --- Cloudflare/queue interstitial patience: wait it out instead of failing ---
const isCfChallengeText = (t) => /just a moment|verify you are human|checking your browser|attention required|enable javascript and cookies to continue/i.test(t.slice(0, 3000));
async function waitOutChallenge(page, maxSec = 30) {
  const t0 = Date.now();
  let challenged = false;
  while (Date.now() - t0 < maxSec * 1000) {
    const text = await page.evaluate('document.body.innerText').catch(() => '');
    if (!isCfChallengeText(text)) return { challenged, waited: Math.round((Date.now() - t0) / 1000) };
    challenged = true;
    await sleep(rnd(1500, 2800));
  }
  return { challenged: true, waited: maxSec, stillChallenged: true };
}

// ---------------------------------------------------------------- commands

const WAIT_FN = sel => document.querySelector(sel) !== null;

async function runCommand(cmd, args, flags = {}) {
  const pos = args || [];
  // 'ping' must answer even when no browser exists (clients poll it as the
  // readiness gate); every other command guarantees a live browser first.
  let browser = null;
  if (cmd !== 'ping') browser = await ensureBrowser();
  switch (cmd) {    case 'status': {
      const pages = await browser.pages();
      const tabs = [];
      for (const p of pages) tabs.push({ url: p.url(), title: await p.title().catch(() => '') });
      return { running: true, port: PORT, profile: PROFILE, tabs };
    }
    case 'tabs': {
      const pages = await browser.pages();
      const tabs = [];
      for (const p of pages) tabs.push({ url: p.url(), title: await p.title().catch(() => '') });
      return { tabs };
    }
    case 'open': {
      if (!pos[0]) throw new Error('usage: open <url>');
      const page = await activePage(browser);
      try {
        await page.goto(pos[0], { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch {
        await page.goto(pos[0], { waitUntil: 'load', timeout: 45000 });
      }
      await sleep(700);
      await markActive(page);
      const cf = await waitOutChallenge(page);
      return {
        url: page.url(), title: await page.title(),
        text: truncate(await page.evaluate('document.body.innerText'), 800),
        cfChallenge: cf.challenged || undefined,
        cfWaitedSec: cf.challenged ? cf.waited : undefined,
        stillChallenged: cf.stillChallenged || undefined,
      };
    }
    case 'data': { // open a data: URL (used for throwaway form tests)
      const page = await activePage(browser);
      await page.goto(pos[0], { timeout: 30000 });
      await markActive(page);
      return { url: 'data:...' };
    }
    case 'text': {
      const page = await activePage(browser);
      return { url: page.url(), title: await page.title(), text: truncate(await page.evaluate('document.body.innerText'), 6000) };
    }
    case 'extract': {
      const page = await activePage(browser);
      const sel = pos[0] || '*';
      const attr = flags.attr;
      const limit = parseInt(flags.limit || '200', 10) || 200;
      const items = await page.evaluate((selector, a, lim) => {
        const els = [...document.querySelectorAll(selector)].slice(0, lim);
        return els.map(e => {
          if (a) { const v = e.getAttribute(a); return v === null ? undefined : v; }
          const t = (e.innerText || e.value || '').trim();
          return t.length > 400 ? t.slice(0, 400) + '…' : t;
        }).filter(t => t !== undefined && t !== '');
      }, sel, attr, limit);
      const uniq = [...new Set(items)];
      return { url: page.url(), count: uniq.length, items: uniq };
    }
    case 'wait': {
      const page = await activePage(browser);
      await page.waitForFunction(WAIT_FN, { timeout: parseInt(pos[1] || '10000', 10) }, pos[0]);
      return { found: pos[0], url: page.url() };
    }
    case 'click': {
      if (!pos[0]) throw new Error('usage: click <selector | @text=... | @role=role:name>');
      const page = await activePage(browser);
      const r = await humanClick(page, pos[0]);
      await markActive(page);
      return { ...r, url: page.url() };
    }
    case 'fingerprint': {
      const page = await activePage(browser);
      const fp = await page.evaluate(FP_FN);
      const verdict = fp.issues.length === 0
        ? 'clean — the page JS sees a normal Firefox user'
        : `issues detectable by page JS: ${fp.issues.join('; ')}`;
      return { url: page.url(), stealth: verdict, issues: fp.issues, details: fp };
    }
    case 'press': {
      const key = pos[0];
      if (!key) throw new Error('usage: press <Key>  (Enter, Tab, Escape, ArrowDown, a, …)');
      const page = await activePage(browser);
      await page.keyboard.press(key);
      await sleepMs(rnd(120, 350));
      await markActive(page);
      return { pressed: key, url: page.url() };
    }
    case 'type': {
      const sel = pos[0], text = pos.slice(1).join(' ');
      if (!sel || !text) throw new Error('usage: type <selector> <text>');
      const page = await activePage(browser);
      const el = await page.$(sel);
      if (!el) throw new Error(`type: no element ${sel}`);
      await el.evaluate(e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const box = await el.evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      await humanClickPoint(page, { x: box.x + rnd(0.3, 0.6) * box.w, y: box.y + box.h / 2 });
      await page.mouse.down(); await sleepMs(rnd(40, 90)); await page.mouse.up();
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await sleepMs(rnd(80, 200));
      await page.keyboard.press('Backspace');
      await sleepMs(rnd(200, 450));
      await humanType(page, text);
      await el.evaluate(e => e.dispatchEvent(new Event('change', { bubbles: true })));
      await sleepMs(rnd(100, 300));
      await markActive(page);
      return { typed: sel, length: text.length, url: page.url() };
    }
    case 'fill': {
      let raw;
      if (pos[0] === '-') raw = fs.readFileSync(0, 'utf8');
      else if (pos.length) raw = pos.join(' ');
      if (!raw) throw new Error('usage: fill <json> | fill - <<EOF>');
      let fields;
      try { fields = JSON.parse(raw); } catch { throw new Error('fill: payload is not valid JSON'); }
      const page = await activePage(browser);
      const r = await doFill(page, fields);
      await markActive(page);
      return { ...r, url: page.url() };
    }
    case 'js': {
      const code = pos.join(' ');
      if (!code) throw new Error('usage: js <expression>');
      const page = await activePage(browser);
      let result;
      try { result = await page.evaluate(`(async () => { return (${code}); })()`); }
      catch { result = await page.evaluate(`(async () => { ${code} })()`); }
      return { url: page.url(), result: typeof result === 'string' ? truncate(result, 12000) : result };
    }
    case 'screenshot': {
      const page = await activePage(browser);
      const dest = pos[0] || `/tmp/opencode/browser-${Date.now()}.png`;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // SENSITIVE-GATE: refuse to capture while credential fields exist on the
      // page unless the user explicitly allowed it — screenshots go to the
      // agent/model, and a visible/shown password must never reach them.
      const pwOnPage = await page.evaluate(
        `(() => { const els = document.querySelectorAll('input[type=password]'); \
           return els.length ? [...els].some(e => e.offsetParent !== null || e.getClientRects().length) : false; })()`
      ).catch(() => false);
      if (pwOnPage && !flags.allow) {
        return {
          blocked: 'sensitive',
          reason: 'a password field is visible on this page. Screenshots can capture secrets (especially if shown in plaintext). Ask the USER then retry with --allow after they approve.',
        };
      }
      await page.screenshot({ path: dest, fullPage: !!flags.fullPage });
      return { screenshot: dest, url: page.url(), title: await page.title() };
    }
    case 'stop': {
      let closed = false;
      try { await browser.close(); closed = true; } catch { /* maybe already gone */ }
      await killDebug();
      if (S.interval) clearInterval(S.interval);
      S.browser = null; S.page = null;
      setTimeout(() => process.exit(0), 100);
      return { closed, closedBrowser: closed };
    }
    case 'restart': {
      // recycle ONLY the browser (fresh session budget), keep the daemon alive
      try { await S.browser.close(); } catch { /* maybe already gone */ }
      if (S.interval) clearInterval(S.interval);
      S.browser = null; S.page = null;
      await killDebug();
      launchFirefox();
      if (!await endpointReady(25000)) throw new Error('firefox relaunch failed');
      S.browser = await connectFirefox();
      for (const p of await S.browser.pages()) await harden(p);
      return { restarted: true, profile: PROFILE };
    }
    case 'ping': {
      return { pong: true, port: PORT, browser: !!S.browser };
    }
    default:
      throw new Error(`unknown command "${cmd}" — try: start | status | tabs | open | text | extract | wait | click | type | fill | js | screenshot | restart | stop | ping`);
  }
}

// ---------------------------------------------------------------- daemon mode

function startServe() {
  fs.mkdirSync(SOCK_DIR, { recursive: true });
  try { fs.unlinkSync(SOCK); } catch { }

  // idle reaper (idea from stealth-browser-mcp): close the browser after
  // BROWSER_IDLE_TIMEOUT seconds of inactivity — 0 (default) = disabled
  let lastActivity = Date.now();
  const idleSec = parseFloat(process.env.BROWSER_IDLE_TIMEOUT || '0') || 0;
  const idleTimer = idleSec > 0 ? setInterval(async () => {
    if (!S.browser) return;
    if (Date.now() - lastActivity < idleSec * 1000) return;
    try { await S.browser.close(); } catch { /* died on its own */ }
    if (S.interval) clearInterval(S.interval);
    S.browser = null; S.page = null;
  }, 30000) : null;
  idleTimer?.unref?.();

  const server = net.createServer(socket => {
    let buf = '';
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); } catch {
          socket.write(JSON.stringify({ ok: false, error: 'bad request json' }) + '\n'); continue;
        }
        runCommand(req.cmd, req.args, req.flags)
          .then(res => { lastActivity = Date.now(); socket.write(JSON.stringify({ ok: true, ...res }) + '\n'); })
          .catch(err => {
            // if the browser/connection died, drop state so next call relaunches
            const msg = String(err && err.message || err);
            lastActivity = Date.now();
            if (/Target closed|Session closed|Connection closed|browser has been closed|closedSession|protocol error/i.test(msg)) {
              if (S.interval) clearInterval(S.interval);
              S.browser = null; S.page = null;
            }
            socket.write(JSON.stringify({ ok: false, error: msg.split('\n').slice(0, 4).join(' | ') }) + '\n');
          });
      }
    });
    socket.on('error', () => { });
  });
  server.listen(SOCK, () => {
    // ready marker for clients
    fs.writeFileSync(SOCK + '.ready', String(Date.now()));
  });
  server.on('error', err => {
    console.error('daemon socket error:\n' + err.stack);
    process.exit(1);
  });
  // self watchdog: exit if firefox core is gone and unreachable (avoid orphans)
  setInterval(() => { try { if (S.browser && !S.browser.connected) { } } catch { } }, 60000).unref?.();
}

// ---------------------------------------------------------------- client mode

function request(cmd, args, flags, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const sock = net.connect(SOCK);
    let buf = '';
    const to = setTimeout(() => {
      try { sock.destroy(); } catch { }
      resolve({ ok: false, error: `timeout after ${timeoutMs / 1000}s — is the browser stuck?` });
    }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ cmd, args, flags }) + '\n'));
    sock.on('data', c => {
      buf += c.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        try {
          clearTimeout(to);
          sock.end();
          resolve(JSON.parse(line));
        } catch { /* keep waiting */ }
      }
    });
    sock.on('error', err => {
      clearTimeout(to);
      resolve({ ok: false, error: err.code === 'ECONNREFUSED' || err.code === 'ENOENT'
        ? `daemon not running on ${SOCK}` : String(err.message || err) });
    });
  });
}

// kill orphaned serve daemons (stale code / lost socket) — our own cmdline
// ("node ... browser.mjs start") has no " serve" so self-match isn't possible
function findServePids() {
  const pids = [];
  for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`).toString().replace(/\0/g, ' ');
      if (cmd.includes('browser.mjs') && cmd.includes(' serve') && parseInt(pid, 10) !== process.pid) pids.push(parseInt(pid, 10));
    } catch { /* race */ }
  }
  return pids;
}

async function startDaemon() {
  // clean the lane: previously orphaned daemons die first, so we never have two
  for (const p of findServePids()) { try { process.kill(p, 'SIGTERM'); } catch { } }
  await sleep(700);
  for (const p of findServePids()) { try { process.kill(p, 'SIGKILL'); } catch { } }
  fs.mkdirSync(SOCK_DIR, { recursive: true });
  try { fs.existsSync(SOCK + '.ready') && fs.unlinkSync(SOCK + '.ready'); } catch { }
  const logFd = fs.openSync(LOG, 'a');
  fs.appendFileSync(LOG, `--- daemon spawn ${new Date().toISOString()} ---\n`);
  const self = path.join(new URL('.', import.meta.url).pathname, path.basename(new URL(import.meta.url).pathname));
  const child = spawn(process.execPath, ['--no-warnings', self, 'serve'], { detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (fs.existsSync(SOCK + '.ready')) {
      const r = await request('ping', [], {}, 8000);
      if (r && r.pong) return true;
    }
    await sleep(500);
  }
  return false;
}

// ---------------------------------------------------------------- client main

const { flags, pos } = parseArgs(process.argv.slice(2));
const cmd = pos[0];
const args = pos.slice(1);

function parseArgs(argv) {
  // flags that are pure booleans — never consume the next token as their value
  const BOOL = new Set(['allow', 'fullPage']);
  const flags2 = {}, p = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let key = a.slice(2), val;
      const eq = key.indexOf('=');
      if (eq !== -1) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      if (val !== undefined) flags2[key] = val;
      else if (BOOL.has(key)) flags2[key] = true;
      else {
        const nx = argv[i + 1];
        if (nx !== undefined && !nx.startsWith('--')) { flags2[key] = nx; i++; }
        else flags2[key] = true;
      }
    } else p.push(a);
  }
  return { flags: flags2, pos: p };
}

if (cmd === 'serve') {
  startServe();
} else if (!cmd) {
  out({
    ok: false,
    usage: [
      'start | stop | restart | status | tabs | ping',
      'open <url> | text | extract <selector> [--attr href] [--limit N]',
      'wait <selector> <ms> | press <key>',
      'click <selector | @text=Button text | @role=button:Sign in>',
      'type <selector> <text>',
      'fill <json>   (or: fill -  with JSON on stdin)',
      'js <expression> | screenshot <path> [--fullPage]',
    ],
  }, 1);
} else {
  // thin client: ensure daemon, then send
  const SELF = path.join(new URL('.', import.meta.url).pathname, path.basename(new URL(import.meta.url).pathname));
  (async () => {
    // v2: the daemon guarantees the browser on every command; "start" is an alias
    const realCmd = (cmd === 'start') ? 'status' : cmd;
    // stdin payloads must be read in the CLIENT (daemon has no stdin)
    if (cmd === 'fill' && args[0] === '-') {
      const raw = fs.readFileSync(0, 'utf8').trim();
      if (!raw) fail(new Error('fill: empty stdin — pipe JSON into fill -'));
      args[0] = raw;
    }
    if (cmd === 'start') {
      let up = true;
      const p = await request('ping', [], {}, 5000);
      if (!p.ok || !p.pong) up = await startDaemon();
      else {
        // daemon alive but older than the script on disk → recycle it
        let readyTs = 0;
        try { readyTs = parseInt(fs.readFileSync(SOCK + '.ready', 'utf8'), 10) || 0; } catch { }
        if (readyTs && readyTs < fs.statSync(SELF).mtimeMs) up = await startDaemon();
      }
      if (!up) fail(new Error('could not start daemon in 60s (see ' + LOG + ')'));
      const r = await request('status', [], flags);
      if (r.ok) { r.started = true; r.port = r.port || PORT; }
      out(r, r.ok ? 0 : 1);
      return;
    }
    let r = await request(realCmd, args, flags);
    if (!r.ok && /daemon not running/.test(r.error || '')) {
      if (realCmd === 'status') { out({ ok: true, running: false, port: PORT }); return; }
      if (realCmd === 'stop') { out({ ok: true, running: false, note: 'nothing to stop' }); return; }
      const up = await startDaemon();
      if (!up) fail(new Error('could not start daemon in 20s (see ' + LOG + ')'));
      r = await request(realCmd, args, flags);
    }
    if (cmd === 'start' && r.ok) r.started = true;
    out(r, r.ok ? 0 : 1);
  })().catch(e => fail(e));
}
