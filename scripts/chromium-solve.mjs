#!/usr/bin/env node
// Chromium-based stealth solver for hardened challenges (Cloudflare, etc.).
// Uses puppeteer-extra + stealth plugin with Chrome for Testing.
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const CHROME = process.env.CHROME_PATH || '/home/intelirain/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const url = process.argv[2];
const waitMs = parseInt(process.argv[3] || '30000', 10);

if (!url) { console.log(JSON.stringify({ ok: false, error: 'usage: chromium-solve.mjs <url> [waitMs]' })); process.exit(1); }

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: false,
      userDataDir: '/tmp/opencode/chromium-profile',
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // human-like warmup
    await page.mouse.move(100, 100);
    await new Promise(r => setTimeout(r, 500));
    await page.mouse.move(400, 300, { steps: 20 });
    await page.evaluate(() => window.scrollBy(0, 200));
    const start = Date.now();
    let title = '', text = '';
    while (Date.now() - start < waitMs) {
      title = await page.title();
      text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 3000) : '');
      const challenge = /just a moment|verify you are human|performing security verification|attention required/i.test(title + '\n' + text);
      if (!challenge) break;
      await page.mouse.move(Math.random()*400+100, Math.random()*300+100, { steps: 10 });
      await new Promise(r => setTimeout(r, 3000));
    }
    title = await page.title();
    text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 3000) : '');
    const solved = !/just a moment|verify you are human|performing security verification|attention required/i.test(title + '\n' + text);
    console.log(JSON.stringify({ ok: true, url: page.url(), title, text, solved }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  } finally {
    if (browser) await browser.close();
  }
})();