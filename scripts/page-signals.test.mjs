import test from 'node:test';
import assert from 'node:assert/strict';
import { detectHumanVerification, isOwnedFirefoxArgv, requiresManualVerification } from './page-signals.mjs';

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
