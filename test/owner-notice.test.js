// Runs the Python validator and queue tests for deploy/canary/owner-notice.py. Skips when python3 is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const python = spawnSync('python3', ['--version'], {encoding: 'utf8'});
test('canary owner-notice validator and queue (python3 unittest)', {skip: python.error || python.status !== 0 ? 'python3 is not installed' : false}, () => {
  const file = fileURLToPath(new URL('./owner_notice_test.py', import.meta.url));
  const result = spawnSync('python3', ['-I', '-B', file], {encoding: 'utf8', env: {PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: 'never-use-command'}});
  assert.equal(result.status, 0, result.stderr);
});
