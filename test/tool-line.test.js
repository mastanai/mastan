import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toolLine} from '../src/channels/tool-line.js';

test('Playwright navigation shows only the host and other browser calls get a short status', () => {
  assert.equal(toolLine('mcp__playwright__browser_navigate', {url: 'https://example.test/appointments?name=invented'}), 'Opening example.test...');
  assert.equal(toolLine('mcp__playwright__browser_navigate', {url: 'https://example.test:8443/'}), 'Opening example.test:8443...');
  for (const url of [undefined, 'invalid', 'about:blank', 'file:///invented']) {
    assert.equal(toolLine('mcp__playwright__browser_navigate', {url}), 'Using the browser...');
  }
  for (const tool of ['browser_snapshot', 'browser_fill_form', 'browser_take_screenshot', 'browser_tabs']) {
    assert.equal(toolLine(`mcp__playwright__${tool}`, {url: 'https://example.test/', path: 'atlas/invented'}), 'Using the browser...');
  }
});

test('existing tool statuses are unchanged', () => {
  assert.equal(toolLine('mcp__smartsheet__get_sheet_summary'), 'Reading Smartsheet...');
  assert.equal(toolLine('mcp__other__read'), 'Working (other)...');
  assert.equal(toolLine('WebSearch'), 'Searching the web...');
  assert.equal(toolLine('Bash', {command: 'mastan-me-board list'}), 'Checking the board...');
  assert.equal(toolLine('Bash', {command: 'mastan-me-youtube comments dQw4w9WgXcQ'}), 'Checking YouTube...');
});
