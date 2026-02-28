import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { reverseString } from './stringUtils.js';

test('reverseString returns reversed string for non-empty inputs', () => {
  assert.strictEqual(reverseString('hello'), 'olleh');
  assert.strictEqual(reverseString('12345'), '54321');
  assert.strictEqual(reverseString('a!@#'), '#@!a');
  assert.strictEqual(reverseString('👨‍💻🌍'), '🌍💻‍👨'); // Unicode emoji sequence
  assert.strictEqual(reverseString('a'), 'a'); // single char
  assert.strictEqual(reverseString('   '), '   '); // whitespace-only
  assert.strictEqual(reverseString('\n\t\r'), '\r\t\n'); // control chars
  // very long string (1000 chars)
  const longStr = 'x'.repeat(1000);
  const reversedLong = 'x'.repeat(1000);
  assert.strictEqual(reverseString(longStr), reversedLong);
});

test('reverseString throws Error for empty string', () => {
  assert.throws(
    () => reverseString(''),
    { name: 'Error', message: 'Cannot reverse empty string' },
    'Expected Error with message "Cannot reverse empty string" for empty input'
  );
});

test('reverseString throws TypeError for null input', () => {
  assert.throws(
    () => reverseString(null),
    { name: 'TypeError', message: 'Input must be a string' }
  );
});

test('reverseString throws TypeError for undefined input', () => {
  assert.throws(
    () => reverseString(undefined),
    { name: 'TypeError', message: 'Input must be a string' }
  );
});

test('reverseString throws TypeError for number input', () => {
  assert.throws(
    () => reverseString(123),
    { name: 'TypeError', message: 'Input must be a string' }
  );
});

test('reverseString throws TypeError for object input', () => {
  assert.throws(
    () => reverseString({}),
    { name: 'TypeError', message: 'Input must be a string' }
  );
});