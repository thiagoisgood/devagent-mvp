/**
 * 计算第 n 项斐波那契数（Fibonacci Number）
 * 斐波那契数列定义为：F(0) = 0, F(1) = 1, F(n) = F(n-1) + F(n-2)（n ≥ 2）
 * 本实现采用迭代法，时间复杂度 O(n)，空间复杂度 O(1)，避免递归导致的栈溢出与重复计算。
 *
 * @param {number} n - 非负整数，表示要计算的斐波那契数列索引位置
 * @returns {number} 第 n 项斐波那契数；若输入非法则抛出错误
 * @throws {TypeError} 当 n 不是数字类型时
 * @throws {RangeError} 当 n 是负数或非整数时
 */
export function fibonacci(n) {
  if (typeof n !== 'number') {
    throw new TypeError('fibonacci() 参数 n 必须是数字类型');
  }
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError('fibonacci() 参数 n 必须是非负整数');
  }

  if (n === 0) return 0;
  if (n === 1) return 1;

  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i++) {
    const temp = a + b;
    a = b;
    b = temp;
  }

  return b;
}
