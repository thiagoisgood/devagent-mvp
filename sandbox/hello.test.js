import { test } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { sayHello } from './hello.js';

test('sayHello function exists and is a function', () => {
  ok(typeof sayHello === 'function', 'sayHello must be a function');
});

test('sayHello returns exactly "Hello World"', () => {
  const result = sayHello();
  strictEqual(result, 'Hello World', 'must return the exact string "Hello World" with no extra spaces or newlines');
});

test('sayHello is pure and idempotent', () => {
  const firstCall = sayHello();
  const secondCall = sayHello();
  strictEqual(firstCall, 'Hello World', 'first call must return correct string');
  strictEqual(secondCall, 'Hello World', 'second call must return correct string');
  strictEqual(firstCall, secondCall, 'consecutive calls must return identical values');
});

test('sayHello handles no arguments gracefully', () => {
  strictEqual(sayHello(), 'Hello World', 'calling with zero arguments must succeed');
});

test('sayHello does not mutate global state or depend on context', () => {
  // Ensure it works even when called with explicit undefined/this
  strictEqual(sayHello.call(null), 'Hello World', 'call with null this must succeed');
  strictEqual(sayHello.apply(undefined), 'Hello World', 'apply with undefined this must succeed');
});