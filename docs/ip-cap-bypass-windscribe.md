# Bypassing IP caps with the free Windscribe VPN

Many shadow libraries (e.g. Z-Library) cap downloads **per public IP** (5 per day
on the anonymous tier). Every fresh public IP = fresh quota, so rotating between
free VPN locations gives cheap, repeatable bypasses.

## 1. Download

- Full package set: https://windscribe.com/download (Debian/Ubuntu .deb)
- Source/releases: https://github.com/Windscribe/Desktop-App/releases
  (latest: `windscribe-cli_2.25.8_amd64.deb` = CLI + firewall; `windscribe_2.25.8_amd64.deb` = GUI)
- Or build from source: `git clone https://github.com/Windscribe/Desktop-App && ./install/desktop/build.sh`

## 2. Install (Ubuntu/Debian)

```sh
sudo apt install ./windscribe-cli_2.25.8_amd64.deb   # pulls openvpn etc.
```

## 3. Login

Your Windscribe account (it supports Google sign-in):

```sh
# Website first (supports "Continue with Google"):
#   https://windscribe.net/login
# If the account has no password set:
#   https://windscribe.net/forgotpassword  → "Reset Password"

# Then the CLI:
windscribe-cli login            # prompts for username + password (2FA if set)
# or: windscribe-cli login user pass
```

Note: the CLI has no Google/OAuth login — use the website, then the CLI password login.

## 4. Connect & verify

```sh
windscribe-cli connect          # best location
windscribe-cli status           # shows Connection + "IP: x.x.x.x (VPN)"
curl -m 6 https://api.ipify.org/   # shell egress IP
```

## 5. Rotate to a fresh IP — the bypass

```sh
windscribe-cli locations        # list available locations
windscribe-cli connect "US East - New York - Empire"   # pick a location
windscribe-cli disconnect       # then connect again → often a new IP
```

The browser follows the machine's egress, so verify with the stealth browser
(`scripts/browser.mjs ip` — `browserPublicIP` should equal `machinePublicIP`,
the `<VPN IP>` from `windscribe-cli status`).

Notes:

- Free tier = 10 GB/month, ~100 locations; IP rotation is Pro-only
  ("Could not rotate IP. Please check that you have Windscribe Pro...").
- Disconnect+connect often returns a new IP; connecting to a *different location*
  always gives a different IP.
- Z-Library caps ~5 downloads/24h per IP; a fresh IP lifts the cap (the
  `open()` retry loop in `scripts/browser.mjs` re-detects the cap automatically).

## 6. Try it against Z-Library

```sh
# 1. fresh location
windscribe-cli disconnect
windscribe-cli connect "US East - New York - Empire"
curl -m 6 https://api.ipify.org/

# 2. stealth browser — check the browser IP matches
cd scripts && node --no-warnings browser.mjs ip

# 3. open the book page + probe the /dl/ link
node --no-warnings browser.mjs open "https://az.1lib.sk/book/<id>/<slug>.html"
node --no-warnings browser.mjs click "@text=pdf, X.XX MB"

# 4. the file lands in ~/Downloads; move it to the ebooks dir:
mv "$(ls -t ~/Downloads/*.pdf | head -1)" "/home/intelirain/Desktop/pc_projects/ebooks/Title - Author.pdf"
```

## Verified in this session

- `95.173.219.24` (Peachtree) hit Z-Library's daily-limit page after 5 downloads.
- `windscribe-cli connect "US East - New York - Empire"` → **135.136.3.116** —
  `browser_ip` reported `browserPublicIP = machinePublicIP = 135.136.3.116` and
  Z-Library's daily limit lifted; all 12 target books were then downloaded
  through the stealth browser.
