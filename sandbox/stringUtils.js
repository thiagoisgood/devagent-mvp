export function reverseString(str) {
  if (typeof str !== 'string') {
    throw new TypeError('Input must be a string');
  }
  if (str === '') {
    throw new Error('Cannot reverse empty string');
  }
  // Correctly handle surrogate pairs (emojis) by using Array.from()
  return Array.from(str).reverse().join('');
}