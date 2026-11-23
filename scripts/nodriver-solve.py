import asyncio, json, random, re, shutil, sys, tempfile
import nodriver as uc

CHROME = '/home/intelirain/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'

CHALLENGE_PATTERNS = ['just a moment', 'verify you are human', 'performing security verification', 'attention required']
IP_CAP_PATTERNS = [
    r'unusual traffic',
    r'too many requests',
    r'excessive requests|excessive traffic',
    r'maximum number of requests|requests exceeded|quota exceeded|rate limit|rate.limited',
    r'suspicious activity|suspected robot|suspected automated',
    r'ip address[^.\n]*(?:blocked|limited|banned|suspended|flagged|restricted)',
    r'your network is sending|requests from your network',
    r'please wait and try again|try again later',
    r'temporarily blocked|temporary suspension',
]


def detect_ip_cap(title='', text=''):
    sample = ((title or '') + '\n' + (text or ''))[:5000]
    return any(re.search(p, sample, re.I) for p in IP_CAP_PATTERNS)


def suggested_cap_wait_ms(sample):
    m = re.search(r'(?:try again(?: in| after)?|wait(?: at least)?)\D{0,24}(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|h)', sample, re.I)
    if not m:
        return None
    n = float(m.group(1))
    unit = m.group(2).lower()
    factor = 3600000 if unit.startswith('h') else 60000 if unit.startswith('m') else 1000
    return max(0, round(n * factor))


async def main():
    url = sys.argv[1]
    wait = int(sys.argv[2]) if len(sys.argv) > 2 else 30000
    profile_dir = tempfile.mkdtemp(prefix='nodriver-', dir='/tmp/opencode')
    browser = None
    ip_cap_retries = 0
    try:
        browser = await uc.start(headless=False, browser_executable_path=CHROME, sandbox=False, user_data_dir=profile_dir)
        page = await browser.get(url)
        start = asyncio.get_event_loop().time()
        while (asyncio.get_event_loop().time() - start) * 1000 < wait:
            title = await page.evaluate('document.title')
            text = await page.evaluate('document.body ? document.body.innerText.slice(0,3000) : ""')
            sample = (title or '') + '\n' + (text or '')
            if any(p in sample.lower() for p in CHALLENGE_PATTERNS):
                await asyncio.sleep(2)
                continue
            if detect_ip_cap(title, text):
                ip_cap_retries += 1
                if ip_cap_retries > 3:
                    break
                suggested = suggested_cap_wait_ms(sample)
                base = [15, 25, 35, 45][min(ip_cap_retries - 1, 3)]
                wait_s = min(suggested / 1000 if suggested is not None else base, 60)
                await asyncio.sleep(max(wait_s, 2) + random.uniform(0, 2))
                page = await browser.get(url)
                continue
            break
        title = await page.evaluate('document.title')
        text = await page.evaluate('document.body ? document.body.innerText.slice(0,3000) : ""')
        final_sample = (title or '') + '\n' + (text or '')
        solved = (not any(p in final_sample.lower() for p in CHALLENGE_PATTERNS)
                  and not detect_ip_cap(title, text))
        print(json.dumps({'ok': True, 'url': url, 'title': title, 'text': text, 'solved': solved,
                          'ipCap': ip_cap_retries > 0, 'ipCapRetries': ip_cap_retries}))
    finally:
        try:
            if browser is not None:
                browser.stop()
        except Exception:
            pass
        shutil.rmtree(profile_dir, ignore_errors=True)

asyncio.run(main())
