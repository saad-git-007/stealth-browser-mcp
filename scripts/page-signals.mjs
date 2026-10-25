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
