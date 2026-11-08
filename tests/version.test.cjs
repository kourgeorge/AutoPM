const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
require('ts-node/register');
const root = path.resolve(__dirname, '..');
const { engineVersion, recordEngineVersion } = require('../src/core/version');

test('the engine reports the commits it started with, and is not behind its own folder', () => {
  recordEngineVersion();
  const v = engineVersion();
  const head = execFileSync('git', ['log', '-1', '--format=%h'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(v.commits[0].hash, head);
  assert.ok(v.commits.length > 1 && v.commits.length <= 5, 'the last few commits');
  assert.ok(v.commits.every(c => c.subject && c.date));
  assert.equal(v.build, 'src');
  assert.equal(v.headNow, head);
  assert.equal(v.behind, false);
});
