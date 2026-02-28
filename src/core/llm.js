/*
 * @Author: Thiago
 * @Date: 2026-02-27 17:04:30
 * @LastEditors: Thiago
 * @LastEditTime: 2026-02-28 22:03:57
 * @FilePath: /devagent-mvp/src/core/llm.js
 * @Description:
 */
import "dotenv/config";
function cleanJson(str) {
  return str
    .trim()
    .replace(/^```json\n/, "")
    .replace(/\n```$/, "");
}
export async function askAI(sys, usr, model) {
  if (model === "qwen") {
    const res = await fetch(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.QWEN_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "qwen3-max-preview",
          messages: [
            { role: "system", content: sys },
            { role: "user", content: usr },
          ],
          response_format: { type: "json_object" },
        }),
      },
    );
    const data = await res.json();
    return JSON.parse(cleanJson(data.choices[0].message.content));
  }
  // (Gemini 逻辑省略，由于用户当前使用 qwen，保持极简确保不出错)
}
