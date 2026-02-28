import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { once } from 'node:events';

// We cannot assign to process.stdin/stdout in ESM mode (they are read-only)
// Instead, we'll use t.mock.method() per-test to intercept usage.
// Import the module without prior global mutation.
let cliModule;
try {
  cliModule = await import('../cli/index.js');
} catch (err) {
  throw err;
}

// Helper to simulate stdin input and capture stdout writes
function createMockIO(inputs = []) {
  let stdoutWrites = [];
  const stdin = {
    setEncoding: () => {},
    resume: () => {},
    on: (event, handler) => {
      if (event === 'data') {
        let i = 0;
        const emitNext = () => {
          if (i < inputs.length) {
            handler(inputs[i].toString() + '\n');
            i++;
            // Schedule next after microtask to avoid sync blocking
            setTimeout(emitNext, 0);
          }
        };
        emitNext();
      }
    },
    once: (event, handler) => {
      if (event === 'data') {
        let i = 0;
        const emitNext = () => {
          if (i < inputs.length) {
            handler(inputs[i].toString() + '\n');
            i++;
            setTimeout(emitNext, 0);
          }
        };
        emitNext();
      }
    },
    removeAllListeners: () => {},
    isTTY: true,
  };

  const stdout = {
    write: (chunk) => {
      stdoutWrites.push(chunk);
    },
    isTTY: true,
  };

  return { stdin, stdout, getOutput: () => stdoutWrites.join(''), clearOutput: () => { stdoutWrites = []; } };
}

// Test case: normal valid selection (1, 2, 3)
test('CLI selects valid mode (1, 2, 3) and resolves with correct value', async (t) => {
  const { stdin, stdout, getOutput, clearOutput } = createMockIO(['1']);
  process.stdin = stdin;
  process.stdout = stdout;

  // Stub process.exit to prevent actual exit
  const exitSpy = t.mock.fn();
  process.exit = exitSpy;

  // Import fresh module to re-initialize with mocked IO
  const { selectMode } = await import('../cli/index.js');

  const result = await selectMode();
  assert.strictEqual(result, 'dev');
  assert.match(getOutput(), /Please select the current task mode:/i);
  assert.match(getOutput(), /1\. Development Mode/i);
  assert.doesNotMatch(getOutput(), /process\.exit/);
  assert.strictEqual(exitSpy.mock.callCount(), 0);
});

test('CLI selects valid mode 2 → prod', async (t) => {
  const { stdin, stdout, getOutput } = createMockIO(['2']);
  process.stdin = stdin;
  process.stdout = stdout;

  const exitSpy = t.mock.fn();
  process.exit = exitSpy;

  const { selectMode } = await import('../cli/index.js');

  const result = await selectMode();
  assert.strictEqual(result, 'prod');
  assert.match(getOutput(), /2\. Production Mode/i);
});

test('CLI selects valid mode 3 → debug', async (t) => {
  const { stdin, stdout, getOutput } = createMockIO(['3']);
  process.stdin = stdin;
  process.stdout = stdout;

  const exitSpy = t.mock.fn();
  process.exit = exitSpy;

  const { selectMode } = await import('../cli/index.js');

  const result = await selectMode();
  assert.strictEqual(result, 'debug');
  assert.match(getOutput(), /3\. Debug Mode/i);
});

// Edge: empty input
test('CLI handles empty input and reprompts', async (t) => {
  const { stdin, stdout, getOutput, clearOutput } = createMockIO(['', '1']);
  process.stdin = stdin;
  process.stdout = stdout;

  const exitSpy = t.mock.fn();
  process.exit = exitSpy;

  const { selectMode } = await import('../cli/index.js');

  const result = await selectMode();
  assert.strictEqual(result, 'dev');
  // Should show prompt at least twice
  assert.ok((getOutput().match(/Please select the current task mode:/g) || []).length >= 2);
});

// Edge: whitespace-only input
test('CLI handles whitespace-only input and reprompts', async (t) => {
  const { stdin, stdout, getOutput } = createMockIO(['   ', '\t\t', '1']);
  process.stdin = stdin;
  process.stdout = stdout;

  const exitSpy = t.mock.fn();
  process.exit = exitSpy;

  const { selectMode } = await import('../cli/index.js');

  const result = await selectMode();
  assert.strictEqual(result, 'dev');
  assert.ok((getOutput().match(/Please select the current task mode:/g) || []).length >= 3);
});

// Edge: non-numeric input
test('CLI handles non-numeric input and reprompts', async (t) => {
  const { stdin, stdout, getOutput } = createMockIO(['abc', '42', '2']);
  process.stdin = stdin;
  process.stdout = stdout;

  const exitSpy = t.mock.fn();
  process.exit = exitSpy;

  const { selectMode } = await import('../cli/index.js');

  const result = await selectMode();
  assert.strictEqual(result, 'prod');
  assert.ok((getOutput().match(/Please select the current task mode:/g) || []).length >= 3);
});

// Edge: out-of-range number
test('CLI handles out-of-range number (0, 4, -1) and reprompts', async (t) => {
  const { stdin, stdout, getOutput } = createMockIO(['0', '4', '-1', '2']);
  process.stdin = stdin;
  process.stdout = stdout;

  const exitSpy = t.mock.fn();
  process.exit = exitSpy;

  const { selectMode } = await import('../cli/index.js');

  const result = await selectMode();
  assert.strictEqual(result, 'prod');
  assert.ok((getOutput().match(/Please select the current task mode:/g) || []).length >= 4);
});

// Edge: Ctrl+C (SIGINT)
test('CLI handles SIGINT (Ctrl+C) and exits with code 130', async (t) => {
  const { stdin, stdout } = createMockIO([]);
  process.stdin = stdin;
  process.stdout = stdout;

  // Simulate SIGINT
  const exitSpy = t.mock.fn();
  process.exit = exitSpy;

  const { selectMode } = await import('../cli/index.js');

  // Trigger SIGINT manually by emitting 'SIGINT' on process
  // Since we can't send real SIGINT in test, we stub the listener registration and trigger manually
  // Instead: override the internal readline interface behavior via mocking
  // But simpler: spy on process.exit and verify it's called with 130 when SIGINT occurs
  // We'll simulate by patching the internal event handler — but since module is ESM and not exposing internals,
  // we rely on the fact that selectMode() calls process.on('SIGINT', ...) — so we mock process.on too

  const originalOn = process.on;
  const sigintHandlers = [];
  process.on = (event, handler) => {
    if (event === 'SIGINT') sigintHandlers.push(handler);
  };

  // Run selectMode and immediately trigger SIGINT handler
  const promise = selectMode();

  // Give it a tick to register handler
  await new Promise(resolve => setTimeout(resolve, 1));

  // Now call the registered SIGINT handler
  if (sigintHandlers.length > 0) {
    sigintHandlers[0]();
  }

  try {
    await promise;
    assert.fail('Expected promise to reject or exit');
  } catch (err) {
    // Expected: process.exit(130) throws, caught here
    assert.match(err.message, /process\.exit\(130\) called/);
  }
  assert.strictEqual(exitSpy.mock.callCount(), 1);
  assert.deepStrictEqual(exitSpy.mock.calls[0].arguments, [130]);

  process.on = originalOn;
});

// Edge: multiple spaces between digits (should still parse)
test('CLI handles input with extra spaces like "  2  " and accepts it', async (t) => {
  const { stdin, stdout, getOutput } = createMockIO(['  2  ']);
  process.stdin = stdin;
  process.stdout = stdout;

  const exitSpy = t.mock.fn();
  process.exit = exitSpy;

  const { selectMode } = await import('../cli/index.js');

  const result = await selectMode();
  assert.strictEqual(result, 'prod');
  assert.match(getOutput(), /2\. Production Mode/i);
});

// Edge: very long whitespace prefix/suffix
test('CLI trims extreme whitespace (100 spaces)', async (t) => {
  const hugeSpace = ' '.repeat(100);
  const { stdin, stdout } = createMockIO([hugeSpace + '3' + hugeSpace]);
  process.stdin = stdin;
  process.stdout = stdout;

  const exitSpy = t.mock.fn();
  process.exit = exitSpy;

  const { selectMode } = await import('../cli/index.js');

  const result = await selectMode();
  assert.strictEqual(result, 'debug');
});

// Edge: no valid input forever — but we won't test infinite loop; instead verify guard logic exists via coverage
// Not applicable in unit test without timeout; skip

// Final integration: ensure exported function exists and is async
test('CLI module exports selectMode as an async function', async (t) => {
  const { selectMode } = await import('../cli/index.js');
  assert.strictEqual(typeof selectMode, 'function');
  assert.ok(selectMode.constructor.name === 'AsyncFunction');
});