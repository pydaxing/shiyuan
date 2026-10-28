import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const sourceRoot = new URL('../src/', import.meta.url);
const source = readFileSync(new URL('services/feedback.js', sourceRoot), 'utf8');
const feedbackScript = `${source.replace('export function tapFeedback', 'function tapFeedback')}\ntapFeedback;`;

test('tap feedback never invokes native or browser vibration, including repeated taps', () => {
  const effects = [];
  const vibrate = () => effects.push('vibration');
  const navigator = { vibrate };
  const feedback = runInNewContext(feedbackScript, {
    uni: { vibrateShort: vibrate, vibrateLong: vibrate },
    wx: { vibrateShort: vibrate, vibrateLong: vibrate },
    navigator,
    window: { navigator },
    setTimeout: () => effects.push('timer'),
    Date: { now: () => effects.push('clock') },
  });
  for (let index = 0; index < 100; index += 1) assert.equal(feedback(), undefined);
  assert.deepEqual(effects, []);
});

test('the compatibility feedback hook remains callable before platform initialization', () => {
  const feedback = runInNewContext(feedbackScript);
  assert.doesNotThrow(() => feedback());
});

test('no application entry bypasses the disabled feedback hook with a vibration API', () => {
  const files = [];
  function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) collect(filename);
      else if (/\.(?:[cm]?[jt]s|vue|nvue)$/.test(entry.name)) files.push(filename);
    }
  }
  collect(sourceRoot);
  assert.ok(files.length > 0);
  for (const filename of files) assert.doesNotMatch(readFileSync(filename, 'utf8'), /\bvibrate(?:Short|Long)?\b|UI(?:Impact|Selection|Notification)FeedbackGenerator/, filename.pathname);
});
