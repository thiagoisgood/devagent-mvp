function bubbleSort(arr) {
  if (!Array.isArray(arr)) {
    throw new TypeError('Input must be an array');
  }
  const sorted = [...arr];
  const n = sorted.length;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - i - 1; j++) {
      if (sorted[j] > sorted[j + 1]) {
        [sorted[j], sorted[j + 1]] = [sorted[j + 1], sorted[j]];
      }
    }
  }
  return sorted;
}

export default bubbleSort;