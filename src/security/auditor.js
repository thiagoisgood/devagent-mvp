import { askAI } from "../core/llm.js";

/**
 * 语义级代码安全审计：将即将写入磁盘的代码交给 LLM，以 SecOps 视角审查是否包含高危模式。
 * 高危定义：系统命令执行、未授权网络请求、敏感路径访问等。
 *
 * @param {object} plan - Executor 的执行计划，需包含 action 以及 new_code（replace_file）或 replace_block（patch_code）
 * @returns {Promise<{ is_safe: boolean, reason: string }>} 审计结果，is_safe 为 false 时应阻断写入并抛出 SecurityError
 */
export async function auditCodeChange(plan) {
  const action = plan?.action;
  let codeToAudit = "";

  if (action === "replace_file" && typeof plan.new_code === "string") {
    codeToAudit = plan.new_code;
  } else if (
    action === "patch_code" &&
    typeof plan.replace_block === "string"
  ) {
    codeToAudit = plan.replace_block;
  } else {
    return { is_safe: true, reason: "无需审计：计划中无待审查代码内容。" };
  }

  const sys = [
    "你是一个极其严苛的企业级 SecOps（安全运维）专家。开发者刚刚提交了一段准备写入本地硬盘的代码。请审查该代码是否包含高危风险。",
    "",
    "【高危定义】满足以下任一即视为不安全，必须将 is_safe 设为 false：",
    "1. 任何形式的系统级命令静默执行（如 child_process.exec、child_process.spawn、execSync、require('child_process') 等）。",
    "2. 未经授权的网络请求（尤其是下载可执行文件、或向外发送本地密钥、环境变量中的敏感信息）。",
    "3. 试图读取、修改或删除 .env、~/.ssh、/etc/passwd、或项目之外的绝对路径文件（如 /tmp、/home、C:\\ 等）。",
    "4. 使用 eval、Function 构造函数、或其它动态执行用户可控/不可信输入的方式。",
    "",
    "若未发现上述高危模式，则 is_safe 为 true，reason 简要说明「未发现高危行为」即可。",
    "",
    "你必须只输出一个 JSON 对象，不要包含 Markdown 代码块或其它文字。格式严格为：",
    '{"is_safe": true 或 false, "reason": "审查理由（中文）"}',
  ].join("\n");

  const usr = `请审查以下即将写入文件的代码：\n\n\`\`\`\n${codeToAudit}\n\`\`\``;

  let raw;
  try {
    raw = await askAI(sys, usr, "qwen");
  } catch (err) {
    return {
      is_safe: false,
      reason: `语义审计服务异常，为安全起见拒绝写入：${err?.message || String(err)}`,
    };
  }

  const is_safe =
    raw?.is_safe === true ||
    (typeof raw?.is_safe === "string" && raw.is_safe.toLowerCase() === "true");
  const reason =
    typeof raw?.reason === "string" && raw.reason.trim()
      ? raw.reason.trim()
      : is_safe
        ? "未发现高危行为"
        : "模型未返回具体理由，视为不安全。";

  return { is_safe, reason };
}
