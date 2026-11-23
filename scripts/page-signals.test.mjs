import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIPCap, detectHumanVerification, detectIPCap, isOwnedFirefoxArgv, isPrivateOrLoopbackIP, requiresManualVerification } from './page-signals.mjs';

test('detects an additional verification page', () => {
  assert.equal(detectHumanVerification('Just a moment...', 'Additional Verification Required'), true);
});

test('detects common human verification text in body or title', () => {
  assert.equal(detectHumanVerification('', 'Please complete the security check before proceeding.'), true);
  assert.equal(detectHumanVerification('Verify you are human', 'Continue'), true);
  assert.equal(requiresManualVerification('Just a moment...', 'Additional Verification Required'), true);
});

test('does not flag ordinary content mentioning automation generally', () => {
  assert.equal(detectHumanVerification('AI Engineer jobs', 'The role works with automation and browser tests.'), false);
});

test('only matches Firefox processes with both the exact debug port and profile', () => {
  const own = '/usr/lib/firefox/firefox --profile /tmp/test-profile --remote-debugging-port=19323';
  assert.equal(isOwnedFirefoxArgv(own, 19323, '/tmp/test-profile'), true);
  assert.equal(isOwnedFirefoxArgv(own, 19322, '/tmp/test-profile'), false);
  assert.equal(isOwnedFirefoxArgv(own, 19323, '/tmp/other-profile'), false);
  assert.equal(isOwnedFirefoxArgv(['/usr/lib/firefox', '--profile', '/tmp/profile with spaces', '--remote-debugging-port=19323'], 19323, '/tmp/profile with spaces'), true);
});

test('flags private/loopback/link-local/CGNAT IPv4 as local', () => {
  for (const ip of ['192.168.1.42', '10.0.0.1', '10.255.255.255', '172.16.5.5', '172.31.255.255',
    '127.0.0.1', '127.1.2.3', '169.254.169.254', '100.64.0.1', '100.127.255.255', '192.168.0.1']) {
    assert.equal(isPrivateOrLoopbackIP(ip), true, `expected local: ${ip}`);
  }
});

test('does not flag public IPv4, out-of-range 172.x, or non-IP strings', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '192.169.1.1', '198.51.100.7', '203.0.113.9']) {
    assert.equal(isPrivateOrLoopbackIP(ip), false, `expected public: ${ip}`);
  }
  assert.equal(isPrivateOrLoopbackIP('abc123.local'), false);
  assert.equal(isPrivateOrLoopbackIP('2001:db8::1'), false);
  assert.equal(isPrivateOrLoopbackIP('myhost'), false);
  assert.equal(isPrivateOrLoopbackIP('192.168.1.42 '), true, 'trims whitespace');
});

test('flags loopback/ULA/link-local IPv6 as local', () => {
  assert.equal(isPrivateOrLoopbackIP('::1'), true);
  assert.equal(isPrivateOrLoopbackIP('fe80::1'), true);
  assert.equal(isPrivateOrLoopbackIP('fc00::1'), true);
  assert.equal(isPrivateOrLoopbackIP('fdab:1234::1'), true);
});

test('detects IP-cap / rate-limit pages by site text', () => {
  assert.equal(detectIPCap('', 'Our systems have detected unusual traffic from your computer network'), true);
  assert.equal(detectIPCap('', 'Too many requests. Rate limit exceeded.'), true);
  assert.equal(detectIPCap('', 'You are temporarily blocked due to suspicious activity.'), true);
  assert.equal(detectIPCap('', 'Your IP address is blocked'), true);
  assert.equal(detectIPCap('Indeed Jobs', 'Search jobs by keyword and location'), false);
  assert.equal(detectIPCap('', 'Welcome to our site — please log in to see your jobs.'), false);
});

test('classifies IP caps: structure drives the mechanism choice', () => {
  assert.deepEqual(classifyIPCap('', 'Too many requests. Rate limit exceeded — try again in 60 seconds.'), { type: 'rate_limit', suggestedMs: 60000 });
  assert.deepEqual(classifyIPCap('Too Many Requests', 'Try again after 2 minutes.'), { type: 'rate_limit', suggestedMs: 120000 });
  assert.deepEqual(classifyIPCap('', 'Our systems have detected unusual traffic from your computer network'), { type: 'block', suggestedMs: null });
  assert.deepEqual(classifyIPCap('', 'Your IP address is blocked'), { type: 'block', suggestedMs: null });
  assert.equal(classifyIPCap('Indeed Jobs', 'Search jobs by keyword and location'), null);
});

test('detects Z-Library daily-limit pages (az.1lib.sk cap page)', () => {
  const title = 'Downloading The story of writing, from cave art to computer | Z-Library';
  const text = 'Gündəlik limitiniz aşılıb\nSon 24 saat ərzində sizin 5 İP üzrə 70.72.216.93-dən çox yüzləmə olub';
  assert.equal(detectIPCap(title, text), true);
  assert.equal(classifyIPCap(title, text).type, 'daily_limit');
});
