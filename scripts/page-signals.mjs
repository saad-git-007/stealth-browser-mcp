// Small, dependency-free page/process signals used by the browser daemon.
// A positive challenge result is detected for CAPTCHA/anti-bot handling:
// automation pauses, the visible browser is used to resolve the challenge, and
// page state is re-checked before continuing.
export function detectHumanVerification(title = '', text = '') {
  const sample = `${title}\n${text}`.slice(0, 5000);
  const patterns = [
    /additional verification required/i,
    /verify (?:that )?you(?:'re| are) human/i,
    /complete (?:the )?(?:security|verification) check/i,
    /checking your browser/i,
    /just a moment/i,
    /attention required/i,
    /enable javascript and cookies to continue/i,
    /please complete (?:the )?captcha/i,
    /security check before proceeding/i,
  ];
  return patterns.some(pattern => pattern.test(sample));
}

export function requiresManualVerification(title = '', text = '') {
  const sample = `${title}\n${text}`.slice(0, 5000);
  return /additional verification required|verify (?:that )?you(?:'re| are) human|complete (?:the )?(?:security|verification) check|please complete (?:the )?captcha|security check before proceeding/i.test(sample);
}

// --- IP-cap detection --------------------------------------------------------
// IP-based caps: per-IP rate limits, "too many requests", "unusual traffic"
// blocks and other throttling. Distinct from human-verification challenges
// (those are waited out). The daemon retries IP-cap pages with backoff
// (see browser.mjs open) and reports the cap state back to the caller.
const IP_CAP_PATTERNS = [
  /unusual traffic/i,
  /too many requests/i,
  /excessive requests|excessive traffic/i,
  /maximum number of requests|requests exceeded|quota exceeded|rate limit|rate.limited/i,
  /suspicious activity|suspected robot|suspected automated/i,
  /ip address[^.\n]*(?:blocked|limited|banned|suspended|flagged|restricted)/i,
  /your network is sending|requests from your network/i,
  /please wait and try again|try again later/i,
  /temporarily blocked|temporary suspension/i,
  // Z-Library-style daily-limit pages (az.1lib.sk; observed via the stealth
  // browser — "Gündəlik limitiniz aşılıb … 70.72.216.93-dən çox yüzləmə olub").
  /gündəlik limitiniz aşılıb|daily limit is exceeded|your daily limit is exceeded/i,
  /\d{2,3}\.\d{2,3}\.\d{2,3}\.\d{2,3}[^.\n]{0,120}çox/i,              // "<IP> … çox…" — exceeded from an IP
  /daily download limit|too many downloads|exceeded your (?:daily )?(?:download )?limit/i,
];

export function detectIPCap(title = '', text = '') {
  const sample = `${title || ''}\n${text || ''}`.slice(0, 5000);
  return IP_CAP_PATTERNS.some(pattern => pattern.test(sample));
}

// --- IP-cap structures → the surmount mechanism that fits each -------------
//   rate_limit → wait (jittered backoff) and retry while the cap lifts
//   cooldown   → the page suggests a wait ("try again in 30 seconds") — honor it
//   block      → hard per-IP block: back off and retry, then report to the user
function suggestedCapWaitMs(sample) {
  const m = /(?:try again(?: in| after)?|wait(?: at least)?)\D{0,24}(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|h)/i.exec(sample);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const factor = unit.startsWith('h') ? 3600000 : unit.startsWith('m') ? 60000 : 1000;
  return Math.max(0, Math.round(n * factor));
}

export function classifyIPCap(title = '', text = '') {
  if (!detectIPCap(title, text)) return null;
  const sample = `${title || ''}\n${text || ''}`.slice(0, 5000);
  const suggestedMs = suggestedCapWaitMs(sample);
  if (/(?:^|\W)\d{2,3}\.\d{2,3}\.\d{2,3}\.\d{2,3}[^.\n]{0,120}çox|gündəlik limitiniz aşılıb|daily limit is exceeded|your daily limit is exceeded|daily download limit|too many downloads/i.test(sample)) {
    return { type: 'daily_limit', suggestedMs };
  }
  if (/(?:too many requests|excessive requests|excessive traffic|maximum number of requests|requests exceeded|quota exceeded|rate limit|rate.limited)/i.test(sample)) {
    return { type: 'rate_limit', suggestedMs };
  }
  if (/(?:unusual traffic|suspicious activity|suspected robot|suspected automated|your (?:public )?ip address (?:is|has been)|ip address (?:is|has been)(?: blocked| limited| banned| suspended| flagged| restricted))/i.test(sample)) {
    return { type: 'block', suggestedMs };
  }
  return { type: 'cooldown', suggestedMs };
}

// --- IP-detection audit helpers -------------------------------------------
// Classification of addresses that WebRTC host candidates would expose
// (RFC1918 private, loopback, link-local, CGNAT, IPv6 ULA/link-local).
// `.local` obfuscation names are opaque to us and correctly NOT flagged.
const IPV4_PRIVATE_RE =
  /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})$/;

export function isPrivateOrLoopbackIPv4(ip) {
  return typeof ip === 'string' && IPV4_PRIVATE_RE.test(ip.trim());
}

export function isPrivateOrLoopbackIPv6(ip) {
  if (typeof ip !== 'string') return false;
  const s = ip.trim().toLowerCase();
  return s === '::1' || s === '::' ||
    s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fec0');
}

// Best-effort: does this address belong to this machine's private/local space?
export function isPrivateOrLoopbackIP(ip) {
  if (typeof ip !== 'string') return false;
  const s = ip.trim();
  return s.includes(':') ? isPrivateOrLoopbackIPv6(s) : isPrivateOrLoopbackIPv4(s);
}

// Firefox can have a wrapper and a binary child. Match both by the exact
// debug port AND the dedicated profile before signaling either process.
export function isOwnedFirefoxArgv(commandLine, port, profile) {
  if (!commandLine || !profile || !Number.isInteger(Number(port))) return false;
  const args = Array.isArray(commandLine) ? commandLine : commandLine.trim().split(/\s+/);
  const portArg = `--remote-debugging-port=${Number(port)}`;
  const portMatches = args.includes(portArg);
  const profileIndex = args.indexOf('--profile');
  const profileMatches = profileIndex >= 0 && args[profileIndex + 1] === profile;
  return portMatches && profileMatches;
}
