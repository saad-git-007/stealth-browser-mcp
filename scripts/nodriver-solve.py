import asyncio, sys, json, shutil, tempfile, nodriver as uc

async def main():
    url = sys.argv[1]
    wait = int(sys.argv[2]) if len(sys.argv) > 2 else 30000
    profile_dir = tempfile.mkdtemp(prefix='nodriver-', dir='/tmp/opencode')
    browser = None
    try:
        browser = await uc.start(headless=False, browser_executable_path='/home/intelirain/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', sandbox=False, user_data_dir=profile_dir)
        page = await browser.get(url)
        start = asyncio.get_event_loop().time()
        while (asyncio.get_event_loop().time() - start) * 1000 < wait:
            title = await page.evaluate('document.title')
            text = await page.evaluate('document.body ? document.body.innerText.slice(0,3000) : ""')
            challenge = any(p in (title + '\n' + text).lower() for p in ['just a moment', 'verify you are human', 'performing security verification', 'attention required'])
            if not challenge:
                break
            await asyncio.sleep(2)
        title = await page.evaluate('document.title')
        text = await page.evaluate('document.body ? document.body.innerText.slice(0,3000) : ""')
        solved = not any(p in (title + '\n' + text).lower() for p in ['just a moment', 'verify you are human', 'performing security verification', 'attention required'])
        print(json.dumps({'ok': True, 'url': url, 'title': title, 'text': text, 'solved': solved}))
    finally:
        try:
            if browser is not None:
                browser.stop()
        except Exception:
            pass
        shutil.rmtree(profile_dir, ignore_errors=True)

asyncio.run(main())