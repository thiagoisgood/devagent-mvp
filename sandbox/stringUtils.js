/*
 * @Author: Thiago
 * @Date: 2026-02-27 23:01:30
 * @LastEditors: Thiago
 * @LastEditTime: 2026-02-28 15:49:04
 * @FilePath: /devagent-mvp/sandbox/stringUtils.js
 * @Description:
 */
export function reverseString(str) {
  if (typeof str !== "string") {
    throw new TypeError("Input must be a string");
  }
  if (str === "") {
    throw new Error("Cannot reverse empty string");
  }
  // Correctly handle surrogate pairs (emojis) by using Array.from()
  return Array.from(str).reverse().join("");
}
