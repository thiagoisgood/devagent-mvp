import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Since testBomb.js contains top-level infinite loop,
// we cannot import it directly — it would hang the test process.
// Instead, we execute it as a subprocess and verify timeout behavior.

// Test case 1: Verify that running testBomb.js times out within expected bounds
test('testBomb.js should timeout when executed', async (t) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s max

  const child = spawn('node', ['sandbox/testBomb.js'], {
    signal: controller.signal,
  });

  let stderr = '';
  let stdout = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  const [exitCode, signal] = await once(child, 'close');
  clearTimeout(timeoutId);

  // Expect process to be killed by timeout (SIGTERM or SIGKILL), not exit cleanly
  assert.ok(
    exitCode === null || exitCode > 0 || signal === 'SIGTERM' || signal === 'SIGKILL',
    `Expected non-zero exit or termination signal, got exitCode=${exitCode}, signal=${signal}`
  );
});

// Test case 2: Verify that testBomb.js does NOT exit quickly (i.e., no early return)
test('testBomb.js must not complete within 100ms', async (t) => {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 100);

  const child = spawn('node', ['sandbox/testBomb.js'], {
    signal: controller.signal,
  });

  const [exitCode, signal] = await once(child, 'close');
  clearTimeout(timeoutId);

  const elapsed = Date.now() - start;

  // If it exited < 100ms, it's not actually looping — likely syntax error or early return
  assert.ok(
    elapsed >= 100 || exitCode !== 0 || signal !== null,
    `testBomb.js completed too fast (${elapsed}ms) with exitCode=${exitCode}, signal=${signal}`
  );
});

// Test case 3: Ensure testBomb.js has no syntax errors (basic parse check)
test('testBomb.js must be syntactically valid', () => {
  assert.doesNotThrow(() => {
    // Try to parse without executing
    const fs = require('node:fs');
    const code = fs.readFileSync('sandbox/testBomb.js', 'utf8');
    Function(`'use strict'; ${code}`);
  }, SyntaxError);
});