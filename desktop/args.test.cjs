'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('./args.cjs');

test('run', () => {
  assert.deepEqual(parseArgs(['/s']), { mode: 'run', hwnd: null });
  assert.deepEqual(parseArgs(['/S']), { mode: 'run', hwnd: null });
  assert.deepEqual(parseArgs(['-s']), { mode: 'run', hwnd: null });
});

test('preview carries the window handle', () => {
  assert.deepEqual(parseArgs(['/p', '1234']), { mode: 'preview', hwnd: '1234' });
  assert.deepEqual(parseArgs(['/P:99']), { mode: 'preview', hwnd: '99' });
});

test('settings', () => {
  assert.deepEqual(parseArgs([]), { mode: 'config', hwnd: null });
  assert.deepEqual(parseArgs(['/c']), { mode: 'config', hwnd: null });
  assert.deepEqual(parseArgs(['/c:5678']), { mode: 'config', hwnd: '5678' });
});

test('other arguments are skipped, not mistaken for switches', () => {
  assert.deepEqual(parseArgs(['--no-sandbox', '/home/x/app', '/s']), { mode: 'run', hwnd: null });
  assert.deepEqual(parseArgs(['/some/path', '--flag']), { mode: 'config', hwnd: null });
  assert.deepEqual(parseArgs(['/stuff']), { mode: 'config', hwnd: null });
});
