import { readFile, writeFile } from "node:fs/promises";

/**
 * 语义替换引擎：根据大模型提供的精确代码块进行局部替换，不依赖 AST 解析。
 * 将「定位要修改的代码」的权力交给 LLM，避免 acorn 等解析器对复杂 JS/TS/ESM 语法的脆弱性。
 *
 * @param {string} filePath - 目标文件的绝对路径
 * @param {string} searchBlock - 原文件中要替换的精确代码块（必须与原文件内容完全一致，含空格与缩进）
 * @param {string} replaceBlock - 替换后的新代码块
 * @returns {Promise<void>}
 * @throws 当 searchBlock 在文件中不存在时抛出错误，提示确保内容完全一致
 */
export async function patchFile(filePath, searchBlock, replaceBlock) {
  const content = await readFile(filePath, "utf8");

  if (!content.includes(searchBlock)) {
    throw new Error(
      "[Patch 失败] 未能在文件中找到目标替换块，请确保 search_block 的内容（含空格和缩进）与原文件完全一致！",
    );
  }

  const newContent = content.replace(searchBlock, replaceBlock);
  await writeFile(filePath, newContent, "utf8");
}
