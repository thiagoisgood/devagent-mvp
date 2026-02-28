import { askAI } from "./llm.js";
import { getBlacklist } from "./memory.js";
import { access, writeFile } from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import chalk from "chalk";
import { patchFile } from "./patchEditor.js";
import { askCommandPermission } from "../cli/ui.js";
import {
  validateCommand,
  validateFileAccess,
  SecurityError,
} from "../security/firewall.js";
import { auditCodeChange } from "../security/auditor.js";

const execAsync = promisify(exec);

function renderSecurityBlockPanel() {
  const panelWidth = 60;
  const title = " SECURITY FIREWALL BLOCKED ";
  const paddedTitle = title.padEnd(panelWidth, " ");
  const border = "".padEnd(panelWidth, " ");

  console.log(chalk.bgRed.white.bold(border));
  console.log(chalk.bgRed.white.bold(paddedTitle));
  console.log(chalk.bgRed.white.bold(border));
  console.log(
    chalk.bgRed.white.bold(
      " 你的操作已被 DevAgent 安全铁幕强制拦截，请立即更换安全策略。 ",
    ),
  );
  console.log(chalk.bgRed.white.bold(border));
  console.log("");
}

function formatPlanDebug(plan) {
  try {
    return JSON.stringify(plan, null, 2);
  } catch {
    return String(plan);
  }
}

function renderExecutionPlan(plan) {
  let parsed = plan;

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed.trim());
    } catch {
      const header = chalk.bold.cyan(
        "┌──────────────── DevAgent 执行计划 ────────────────┐",
      );
      const title = chalk.bold.cyan(
        "│  DevAgent Execution Plan (raw string)            │",
      );
      const footer = chalk.bold.cyan(
        "└──────────────────────────────────────────────────┘",
      );
      const body = chalk.dim(parsed);
      return [header, title, footer, body].join("\n");
    }
  }

  if (!parsed || typeof parsed !== "object") {
    const header = chalk.bold.cyan(
      "┌──────────────── DevAgent 执行计划 ────────────────┐",
    );
    const title = chalk.bold.cyan(
      "│  DevAgent Execution Plan (unstructured)          │",
    );
    const footer = chalk.bold.cyan(
      "└──────────────────────────────────────────────────┘",
    );
    const body = chalk.dim(formatPlanDebug(parsed));
    return [header, title, footer, body].join("\n");
  }

  const action = parsed.action || "unknown";
  const isRunCommand = action === "run_command";
  const isPatchCode = action === "patch_code";
  const isReplaceFile = action === "replace_file";

  const header = chalk.bold.cyan(
    "┌──────────────── DevAgent 执行计划 ────────────────┐",
  );
  const title = chalk.bold.cyan(
    "│  DevAgent Execution Plan                          │",
  );
  const footer = chalk.bold.cyan(
    "└──────────────────────────────────────────────────┘",
  );

  const lines = [];
  lines.push(header);
  lines.push(title);
  lines.push(footer);
  lines.push("");

  if (isRunCommand && typeof parsed.command === "string") {
    lines.push(
      `${chalk.bold.white("动作:")} ${chalk.bold.blue("run_command")}`,
    );
    lines.push(`${chalk.bold.white("命令:")} ${chalk.cyan(parsed.command)}`);
    if (typeof parsed.thought === "string" && parsed.thought.trim()) {
      lines.push(
        `${chalk.bold.white("理由:")} ${chalk.dim(parsed.thought.trim())}`,
      );
    }
  } else if (
    (isPatchCode || isReplaceFile) &&
    typeof parsed.file === "string"
  ) {
    if (isReplaceFile) {
      lines.push(
        `${chalk.bold.white("动作:")} ${chalk.bold.magenta("replace_file")}`,
      );
    } else {
      lines.push(
        `${chalk.bold.white("动作:")} ${chalk.bold.magenta("patch_code")}`,
      );
    }

    lines.push(`${chalk.bold.white("文件:")} ${chalk.cyan(parsed.file)}`);
    if (typeof parsed.thought === "string" && parsed.thought.trim()) {
      lines.push(
        `${chalk.bold.white("理由:")} ${chalk.dim(parsed.thought.trim())}`,
      );
    }
    if (isPatchCode && typeof parsed.replace_block === "string") {
      const preview = parsed.replace_block.split("\n").slice(0, 3).join("\n");
      lines.push("");
      lines.push(chalk.bold.white("替换块预览:"));
      lines.push(chalk.gray(preview));
      const moreLines = parsed.replace_block.split("\n").length - 3;
      if (moreLines > 0) {
        lines.push(chalk.dim(`… 还有 ${moreLines} 行`));
      }
    } else if (isReplaceFile && typeof parsed.new_code === "string") {
      const preview = parsed.new_code.split("\n").slice(0, 3).join("\n");
      lines.push("");
      lines.push(chalk.bold.white("代码预览:"));
      lines.push(chalk.gray(preview));
      const moreLines = parsed.new_code.split("\n").length - 3;
      if (moreLines > 0) {
        lines.push(chalk.dim(`… 还有 ${moreLines} 行`));
      }
    }
  } else {
    lines.push(
      chalk.yellow("⚠️ 未能识别标准计划结构，以下为原始内容（已格式化）："),
    );
    lines.push("");
    lines.push(chalk.dim(formatPlanDebug(parsed)));
  }

  return lines.join("\n");
}

const INITIAL_STATE = {
  context: null,
  errorLog: null,
  mode: "fix",
  requirement: null,
  monitorCommand: null,
  retryCount: 0,
  status: "running",
  plan: null,
  /** feature 模式下业务代码写入后置为 'need_tester'，驱动流转到 testerNode */
  phase: null,
  /** 刚写入的业务文件路径（如 sandbox/foo.js），供 Tester 生成同级 .test.js */
  lastWrittenFile: null,
  /** 本次生成的测试文件路径（如 sandbox/foo.test.js），供外层 CLI 做靶向 node --test 隔离 */
  testTarget: null,
};

async function supervisor(state) {
  if (state.status === "success") {
    return state;
  }

  if (state.retryCount >= 3) {
    state.status = "rollback";
    return state;
  }

  const blacklist = await getBlacklist();

  const mode = state.mode === "feature" ? "feature" : "fix";

  let sys;
  let usr;

  if (mode === "feature") {
    sys = [
      "你现在是一名 DevAgent architect-planner 与全栈开发专家。",
      "你现在的任务是根据用户的需求从 0 到 1 编写代码。请仔细分析上下文，决定需要创建或修改哪些文件。你可以使用 replace_file 动作来生成完整文件，使用 patch_code 进行局部修改，或者使用 run_command 初始化依赖。",
      "",
      "在本模式下，你依然必须严格遵守以下 DevAgent 执行协议：",
      "",
      "你是一台**无情的 DevAgent Supervisor**，根据错误日志和项目上下文，为下游执行器规划下一步「行动方案」。",
      "现在你拥有三种武器，可以在每一轮只选择其中一种：",
      "",
      "【武器 1：patch_code（语义局部替换）】",
      "你现在拥有一个强大的 patch_code 动作来进行局部代码修改。你不需要告诉我函数名，你只需要提供：",
      "search_block: 原文件中你想要替换的精确代码块（必须原封不动，包含原有的空格、缩进和上下文）。",
      "replace_block: 你修改后的全新代码块。",
      "【极度重要】：search_block 必须足够唯一，通常包含函数签名和有问题的几行代码。不要输出整个文件，只输出需要替换的那个片段！",
      "",
      "【武器 2：replace_file（全量覆盖文件）】",
      "- 【极其重要】当错误日志中明确存在 SyntaxError（语法错误），或需要从零创建新文件时，**使用此动作！**",
      "- 你的任务是：给出需要修复/创建的文件路径 file，以及该文件**完整且已经修复后的所有代码** new_code，用于进行全量覆盖写入。",
      "",
      "【武器 3：run_command（执行终端命令）】",
      "- 使用场景：当你判断错误主要来源于缺少 npm 依赖、需要创建文件夹、缺少构建产物、依赖未安装、需要查看系统环境（例如 node 版本 / npm 版本）等「环境 / DevOps」问题时。",
      '- 你的任务是：给出一条需要在终端中执行的命令（例如 "npm install lodash"、"mkdir -p sandbox"、"node -v" 等）。',
      "",
      "【手术铁律（仅对 patch_code / replace_file 生效）】",
      '除非报错明确指出测试文件语法错误，否则你【绝对优先】修改源业务代码文件（例如 "sandbox/mathUtils.js"、"src/core/xxx.js"），而不是去修改测试文件。',
      '【路径守则】你返回的 file 路径绝对不能以 / 开头，必须是纯粹的相对路径（例如 "sandbox/mathUtils.js"）。',
      "",
      "【输出格式的强制要求（三模指令）】",
      "- 你**只能**输出一个 JSON 对象，绝不能输出多段或数组，也不能在前后添加多余解释文字。",
      '- 该 JSON 对象必须包含一个字段 action，且只能是 "patch_code"、"replace_file" 或 "run_command" 之一。',
      "",
      "当你选择 patch_code（局部替换）时，输出格式必须**严格**为：",
      "{",
      '  "action": "patch_code",',
      '  "thought": "string，简要说明你根据错误日志的分析与决策（不超过 3 句）",',
      '  "file": "string，相对文件路径，例如 \\"sandbox/mathUtils.js\\"",',
      '  "search_block": "string，原文件中要替换的精确代码块（必须与文件内容完全一致，含空格与缩进）",',
      '  "replace_block": "string，替换后的新代码块"',
      "}",
      "",
      "当你选择 replace_file（全量覆盖）时，输出格式必须**严格**为：",
      "{",
      '  "action": "replace_file",',
      '  "thought": "string，简要说明你为什么需要进行全量覆盖（不超过 3 句）",',
      '  "file": "string，相对文件路径，例如 \\"sandbox/mathUtils.js\\" 或 \\"src/core/xxx.js\\"",',
      '  "new_code": "string，修复后的该文件完整代码（不要带 markdown 标记，必须是可以被 Node.js 正常解析执行的完整文件内容）"',
      "}",
      "",
      "当你选择 run_command（执行终端命令）时，输出格式必须**严格**为：",
      "{",
      '  "action": "run_command",',
      '  "thought": "string，简要说明你为什么需要执行这条命令（不超过 3 句）",',
      '  "command": "string，需要在终端执行的完整命令，例如 \\"npm install lodash\\"、\\"mkdir -p sandbox\\""',
      "}",
      "",
      "【绝对禁止的行为】",
      "- 不允许输出除 action、thought、file、search_block、replace_block、new_code、command 之外的任何字段。",
      "- 尤其**禁止**出现以下字段（或其英文 / 变体）：steps、step、actions、description、desc、analysis、plan、tool、tools、tool_calls、id、name、role、content、code 等一切无关字段。",
      "- 不允许输出 Markdown 代码块标记，例如 ```、```json、```js 等。",
      "- 不允许在 JSON 前后添加任何解释性文本、自然语言描述、前缀、后缀、标签等。",
      "",
      "【再提醒一次】",
      "- 你是一个**冷酷的 Supervisor 大脑**，只输出一个纯粹的 JSON 对象。",
      "- 该对象必须包含 action 字段，并根据你选择的武器严格符合上述结构。",
      "- 如果你输出了多余字段、Markdown 包裹、输出了整个文件的代码，或任意非 JSON 垃圾内容，将会被视为**严重错误**。",
      "",
      "现在，请根据给定的错误日志、项目上下文和黑名单，严格按上述要求输出 JSON 对象。",
    ].join("\n");

    usr = [
      `当前项目上下文: ${state.context || "(无上下文)"}`,
      "",
      `用户的新需求: ${state.requirement || "(无需求描述)"}`,
    ].join("\n");
  } else {
    const sysParts = [
      "【fix 模式唯一任务】忽略之前的开发需求（requirement）；现在的唯一任务是修复 errorLog 中的报错，使验证命令能够通过。",
      "",
      "你是一台**无情的 DevAgent Supervisor**，根据错误日志和项目上下文，为下游执行器规划下一步「行动方案」。",
      "现在你拥有三种武器，可以在每一轮只选择其中一种：",
      "",
      "【武器 1：patch_code（语义局部替换）】",
      "你现在拥有一个强大的 patch_code 动作来进行局部代码修改。你不需要告诉我函数名，你只需要提供：",
      "search_block: 原文件中你想要替换的精确代码块（必须原封不动，包含原有的空格、缩进和上下文）。",
      "replace_block: 你修改后的全新代码块。",
      "【极度重要】：search_block 必须足够唯一，通常包含函数签名和有问题的几行代码。不要输出整个文件，只输出需要替换的那个片段！",
      "",
      "【武器 2：replace_file（全量覆盖文件）】",
      "- 【极其重要】当错误日志中明确存在 SyntaxError（语法错误），或者你预判需要整文件重写时，**必须使用此动作！**",
      "- 你的任务是：给出需要修复的文件路径 file，以及该文件**完整且已经修复后的所有代码** new_code，用于进行全量覆盖写入。",
      "",
      "【武器 3：run_command（执行终端命令）】",
      "- 使用场景：当你判断错误主要来源于缺少 npm 依赖、需要创建文件夹、缺少构建产物、依赖未安装、需要查看系统环境（例如 node 版本 / npm 版本）等「环境 / DevOps」问题时。",
      '- 你的任务是：给出一条需要在终端中执行的命令（例如 "npm install lodash"、"mkdir -p sandbox"、"node -v" 等）。',
      "",
      "【手术铁律（仅对 patch_code / replace_file 生效）】",
      '除非报错明确指出测试文件语法错误，否则你【绝对优先】修改源业务代码文件（例如 "sandbox/mathUtils.js"、"src/core/xxx.js"），而不是去修改测试文件（例如 "test.js"、"src/test.js"）。',
      '【路径守则】你返回的 file 路径绝对不能以 / 开头，必须是纯粹的相对路径（例如 "sandbox/mathUtils.js"）。',
      "",
      "【输出格式的强制要求（三模指令）】",
      "- 你**只能**输出一个 JSON 对象，绝不能输出多段或数组，也不能在前后添加多余解释文字。",
      '- 该 JSON 对象必须包含一个字段 action，且只能是 "patch_code"、"replace_file" 或 "run_command" 之一。',
      "",
      "当你选择 patch_code（局部替换）时，输出格式必须**严格**为：",
      "{",
      '  "action": "patch_code",',
      '  "thought": "string，简要说明你根据错误日志的分析与决策（不超过 3 句）",',
      '  "file": "string，相对文件路径，例如 \\"sandbox/mathUtils.js\\" 或 \\"src/core/xxx.js\\"",',
      '  "search_block": "string，原文件中要替换的精确代码块（必须与文件内容完全一致，含空格与缩进）",',
      '  "replace_block": "string，替换后的新代码块"',
      "}",
      "",
      "当你选择 replace_file（全量覆盖）时，输出格式必须**严格**为：",
      "{",
      '  "action": "replace_file",',
      '  "thought": "string，简要说明你为什么需要进行全量覆盖（不超过 3 句），通常与 SyntaxError 相关",',
      '  "file": "string，相对文件路径，例如 \\"sandbox/mathUtils.js\\" 或 \\"src/core/xxx.js\\"",',
      '  "new_code": "string，修复后的该文件完整代码（不要带 markdown 标记，必须是可以被 Node.js 正常解析执行的完整文件内容）"',
      "}",
      "",
      "当你选择 run_command（执行终端命令）时，输出格式必须**严格**为：",
      "{",
      '  "action": "run_command",',
      '  "thought": "string，简要说明你为什么需要执行这条命令（不超过 3 句）",',
      '  "command": "string，需要在终端执行的完整命令，例如 \\"npm install lodash\\"、\\"mkdir -p sandbox\\""',
      "}",
      "",
      "【绝对禁止的行为】",
      "- 不允许输出除 action、thought、file、search_block、replace_block、new_code、command 之外的任何字段。",
      "- 尤其**禁止**出现以下字段（或其英文 / 变体）：steps、step、actions、description、desc、analysis、plan、tool、tools、tool_calls、id、name、role、content、code 等一切无关字段。",
      "- 不允许输出 Markdown 代码块标记，例如 ```、```json、```js 等。",
      "- 不允许在 JSON 前后添加任何解释性文本、自然语言描述、前缀、后缀、标签等。",
      "",
      "【再提醒一次】",
      "- 你是一个**冷酷的 Supervisor 大脑**，只输出一个纯粹的 JSON 对象。",
      "- 该对象必须包含 action 字段，并根据你选择的武器严格符合上述结构。",
      "- 如果你输出了多余字段、Markdown 包裹、输出了整个文件的代码，或任意非 JSON 垃圾内容，将会被视为**严重错误**。",
      "",
      "现在，请根据给定的错误日志、项目上下文和黑名单，严格按上述要求输出 JSON 对象。",
    ];

    sys = sysParts.join("\n");

    const usrParts = [
      "当前错误日志：",
      state.errorLog || "(无错误日志)",
      "\n项目上下文：",
      state.context || "(无上下文)",
      "\n历史黑名单（最近问题）：",
      JSON.stringify(blacklist, null, 2),
    ];

    usr = usrParts.join("\n");
  }

  const llmResult = await askAI(sys, usr, "qwen");

  let plan = llmResult;

  if (typeof plan === "string") {
    const trimmed = plan.trim();
    try {
      plan = JSON.parse(trimmed);
    } catch (error) {
      console.warn("⚠️ [Supervisor] 无法解析 LLM 返回的 JSON，原始内容如下：");
      console.warn(trimmed);
      state.plan = null;
      return state;
    }
  }

  state.plan = plan;

  return state;
}

async function executor(state) {
  console.log(renderExecutionPlan(state.plan));

  let plan = state.plan;

  // 防御性处理：如果 LLM 返回的是字符串，再尝试解析一次
  if (typeof plan === "string") {
    try {
      plan = JSON.parse(plan.trim());
    } catch (error) {
      console.warn(
        "\x1b[33m%s\x1b[0m",
        "⚠️ [Executor] state.plan 是字符串且无法解析为 JSON，跳过物理覆写。",
      );
      console.warn(plan);
      state.retryCount += 1;
      return state;
    }
  }

  let file;
  let searchBlock;
  let replaceBlock;
  let newCode;
  let action;
  let command;

  if (plan && typeof plan === "object") {
    const extractPlan = (value) => {
      if (
        value &&
        typeof value === "object" &&
        typeof value.action === "string"
      ) {
        return value;
      }
      return null;
    };

    let extracted = extractPlan(plan);

    if (!extracted) {
      // 兼容某些模型可能包了一层的情况，例如 { result: { action, file, search_block, replace_block, thought } }
      for (const key of Object.keys(plan)) {
        const value = plan[key];
        extracted = extractPlan(value);
        if (extracted) {
          break;
        }
      }
    }

    if (extracted) {
      action = extracted.action;
      if (action === "run_command") {
        if (typeof extracted.command === "string") {
          command = extracted.command;
        }
      } else if (action === "replace_file") {
        if (
          typeof extracted.file === "string" &&
          typeof extracted.new_code === "string"
        ) {
          file = extracted.file;
          newCode = extracted.new_code;
        }
      } else if (action === "patch_code") {
        if (
          typeof extracted.file === "string" &&
          typeof extracted.search_block === "string" &&
          typeof extracted.replace_block === "string"
        ) {
          file = extracted.file;
          searchBlock = extracted.search_block;
          replaceBlock = extracted.replace_block;
        }
      }
    }
  }

  if (!action) {
    console.warn(
      "\x1b[33m%s\x1b[0m",
      "⚠️ [Executor] 计划中缺少 action 字段，无法路由执行。",
    );
    console.warn("当前 plan 内容为:\n", formatPlanDebug(plan));
    state.retryCount += 1;
    return state;
  }

  if (action === "run_command") {
    if (!command) {
      console.warn(
        "\x1b[33m%s\x1b[0m",
        "⚠️ [Executor] run_command 计划缺少 command 字段，跳过执行。",
      );
      console.warn("当前 plan 内容为:", plan);
      state.retryCount += 1;
      return state;
    }

    try {
      validateCommand(command);
    } catch (error) {
      if (error instanceof SecurityError || error?.name === "SecurityError") {
        state.errorLog =
          "🚨 [致命拦截] 你的计划触发了系统的最高级安全防火墙！已被强行阻断。请立刻更换安全且合规的修复策略！";
        renderSecurityBlockPanel();
        state.retryCount += 1;
        return state;
      }
      throw error;
    }

    const allowed = await askCommandPermission(command);

    if (!allowed) {
      console.log(
        "\x1b[33m%s\x1b[0m",
        "⚠️ [Executor] 人类已拦截该命令的执行。",
      );
      state.errorLog = "人类拒绝了该命令的执行，请尝试其他方案";
      state.retryCount += 1;
      return state;
    }

    try {
      const { stdout, stderr } = await execAsync(command);

      if (stdout) {
        process.stdout.write(stdout);
      }
      if (stderr) {
        process.stderr.write(stderr);
      }

      state.errorLog = "";
      state.status = "success";
      return state;
    } catch (error) {
      const stdoutLog = error.stdout
        ? `\n[STDOUT 输出]:\n${error.stdout}`
        : "";
      const stderrLog = error.stderr
        ? `\n[STDERR 输出]:\n${error.stderr}`
        : "";
      const combinedLog =
        `Command failed: ${error.message || ""}${stdoutLog}${stderrLog}` ||
        "";

      if (error.stdout) {
        process.stdout.write(error.stdout);
      }
      if (error.stderr) {
        process.stderr.write(error.stderr);
      }

      state.errorLog = combinedLog;
      state.retryCount += 1;
      return state;
    }
  } else if (action === "replace_file") {
    if (!file || !newCode) {
      console.warn(
        "\x1b[33m%s\x1b[0m",
        "⚠️ [Executor] replace_file 计划缺少 file 或 new_code 字段，跳过执行。",
      );
      console.warn("当前 plan 内容为:\n", formatPlanDebug(plan));
      state.retryCount += 1;
      return state;
    }

    try {
      const cwd = process.cwd();
      const normalizedFile = file.startsWith("/") ? file.slice(1) : file;
      const directPath = path.resolve(cwd, normalizedFile);
      const srcFallbackPath = path.resolve(cwd, "src", normalizedFile);

      let targetPath = directPath;

      try {
        await access(directPath);
      } catch {
        try {
          await access(srcFallbackPath);
          targetPath = srcFallbackPath;
          console.log(
            "\x1b[36m%s\x1b[0m",
            `ℹ️ [Executor] 未找到 ${file}，改为全量覆写 src/${file}`,
          );
        } catch {
          console.log(
            "\x1b[36m%s\x1b[0m",
            `ℹ️ [Executor] 文件不存在，将在工作目录创建/全量覆写: ${directPath}`,
          );
        }
      }

      try {
        validateFileAccess(targetPath);
      } catch (error) {
        if (error instanceof SecurityError || error?.name === "SecurityError") {
          state.errorLog =
            "🚨 [致命拦截] 你的计划触发了系统的最高级安全防火墙！已被强行阻断。请立刻更换安全且合规的修复策略！";
          renderSecurityBlockPanel();
          state.retryCount += 1;
          return state;
        }
        throw error;
      }

      // 语义级审计：在物理写入前由 LLM 审查代码是否包含高危模式（命令执行、敏感路径、未授权网络等）
      const audit = await auditCodeChange({
        action: "replace_file",
        new_code: newCode,
      });
      if (!audit.is_safe) {
        throw new SecurityError(`[语义审计拦截] ${audit.reason}`);
      }

      await writeFile(targetPath, newCode, "utf8");
      console.log(
        "\x1b[32m%s\x1b[0m",
        `✅ [Executor] 已使用全量覆盖模式修复（或创建）文件: ${file}`,
      );

      // Feature 模式：写入 .test.js 才视为完成；写入业务文件后流转给 Tester 生成测试再写回
      if (state.mode === "feature") {
        state.errorLog = "";
        if (file.endsWith(".test.js")) {
          state.status = "success";
          return state;
        }
        state.phase = "need_tester";
        state.lastWrittenFile = file;
        return state;
      }

      const validateCommand =
        state.monitorCommand && state.monitorCommand.trim()
          ? state.monitorCommand.trim()
          : `node ${file}`;
      try {
        await execAsync(validateCommand);
        state.errorLog = "";
        state.status = "success";
        console.log(
          "\x1b[32m%s\x1b[0m",
          "✅ [Validator] 验证通过！全量覆盖后的文件可以正常执行。",
        );
      } catch (error) {
        const stdoutLog = error.stdout
          ? `\n[STDOUT 输出]:\n${error.stdout}`
          : "";
        const stderrLog = error.stderr
          ? `\n[STDERR 输出]:\n${error.stderr}`
          : "";
        const errorText = `Validator failed: ${error.message || ""}${stdoutLog}${stderrLog}`;
        state.errorLog = errorText;
        console.warn(
          "\x1b[33m%s\x1b[0m",
          "⚠️ [Validator] 全量覆盖后仍存在报错，已记录到 errorLog 供下一轮分析。",
        );
      }
    } catch (error) {
      if (error instanceof SecurityError || error?.name === "SecurityError") {
        state.errorLog =
          "🚨 [语义审计拦截] " +
          (error.message ||
            "代码包含高危风险，已被安全审计员拦截。请更换安全方案。");
        renderSecurityBlockPanel();
        state.retryCount += 1;
        return state;
      }
      console.error(
        "\x1b[31m%s\x1b[0m",
        "❌ [Executor] replace_file 写入文件失败：",
        error,
      );
      state.errorLog =
        error?.message ||
        "replace_file 执行过程中发生未知错误，请在下一轮重试时重新规划修复方案。";
    }

    if (state.status !== "success") {
      state.retryCount += 1;
    }

    return state;
  }

  // patch_code 分支：语义局部替换，由 LLM 提供精确的 search_block / replace_block
  if (action === "patch_code") {
    if (!file || !searchBlock || !replaceBlock) {
      console.warn(
        "\x1b[33m%s\x1b[0m",
        "⚠️ [Executor] patch_code 计划缺少 file、search_block 或 replace_block 字段，跳过执行。",
      );
      console.warn("当前 plan 内容为:\n", formatPlanDebug(plan));
      state.retryCount += 1;
      return state;
    }

    try {
      const cwd = process.cwd();
      const normalizedFile = file.startsWith("/") ? file.slice(1) : file;
      const directPath = path.resolve(cwd, normalizedFile);
      const srcFallbackPath = path.resolve(cwd, "src", normalizedFile);

      let targetPath = directPath;

      try {
        await access(directPath);
      } catch {
        try {
          await access(srcFallbackPath);
          targetPath = srcFallbackPath;
          console.log(
            "\x1b[36m%s\x1b[0m",
            `ℹ️ [Executor] 未找到 ${file}，改为对 src/${file} 执行 patch_code`,
          );
        } catch {
          console.log(
            "\x1b[36m%s\x1b[0m",
            `ℹ️ [Executor] 文件不存在，将尝试对路径执行 patch: ${directPath}`,
          );
        }
      }

      try {
        validateFileAccess(targetPath);
      } catch (error) {
        if (error instanceof SecurityError || error?.name === "SecurityError") {
          state.errorLog =
            "🚨 [致命拦截] 你的计划触发了系统的最高级安全防火墙！已被强行阻断。请立刻更换安全且合规的修复策略！";
          renderSecurityBlockPanel();
          state.retryCount += 1;
          return state;
        }
        throw error;
      }

      // 语义级审计：在 patch 前由 LLM 审查 replace_block 是否包含高危模式
      const audit = await auditCodeChange({
        action: "patch_code",
        replace_block: replaceBlock,
      });
      if (!audit.is_safe) {
        throw new SecurityError(`[语义审计拦截] ${audit.reason}`);
      }

      await patchFile(targetPath, searchBlock, replaceBlock);
      console.log(
        "\x1b[32m%s\x1b[0m",
        `✅ [Executor] patch_code 成功！已对 ${file} 完成语义局部替换。`,
      );

      if (state.mode === "feature") {
        state.errorLog = "";
        if (file.endsWith(".test.js")) {
          state.status = "success";
          return state;
        }
        state.phase = "need_tester";
        state.lastWrittenFile = file;
        return state;
      }

      const validateCommand =
        state.monitorCommand && state.monitorCommand.trim()
          ? state.monitorCommand.trim()
          : `node ${file}`;
      try {
        await execAsync(validateCommand);
        state.errorLog = "";
        state.status = "success";
        console.log(
          "\x1b[32m%s\x1b[0m",
          "✅ [Validator] 验证通过！patch_code 修复有效。",
        );
      } catch (error) {
        const stdoutLog = error.stdout
          ? `\n[STDOUT 输出]:\n${error.stdout}`
          : "";
        const stderrLog = error.stderr
          ? `\n[STDERR 输出]:\n${error.stderr}`
          : "";
        const errorText = `Validator failed: ${error.message || ""}${stdoutLog}${stderrLog}`;
        state.errorLog = errorText;
        console.warn(
          "\x1b[33m%s\x1b[0m",
          "⚠️ [Validator] patch_code 后仍存在报错，已记录到 errorLog 供下一轮分析。",
        );
      }
    } catch (error) {
      if (error instanceof SecurityError || error?.name === "SecurityError") {
        state.errorLog =
          "🚨 [语义审计拦截] " +
          (error.message ||
            "替换块包含高危风险，已被安全审计员拦截。请更换安全方案。");
        renderSecurityBlockPanel();
        state.retryCount += 1;
        return state;
      }
      const hint =
        error?.message ||
        "patch_code 执行失败，请确保 search_block 与文件内容（含空格与缩进）完全一致，或改用 replace_file 全量覆盖。";
      console.warn(chalk.yellow("⚠️ [Executor] " + hint));
      state.errorLog = hint;
      state.retryCount += 1;
      return state;
    }
  }

  // 未知或未识别的 action（如历史 edit_function）不执行任何操作，仅记录并重试
  if (action && action !== "run_command" && action !== "replace_file" && action !== "patch_code") {
    console.warn(
      chalk.yellow(`⚠️ [Executor] 未识别的 action: "${action}"，请使用 patch_code、replace_file 或 run_command。`),
    );
    state.errorLog = `Executor 不支持 action "${action}"，请输出 patch_code、replace_file 或 run_command 之一。`;
    state.retryCount += 1;
    return state;
  }

  if (state.status !== "success") {
    state.retryCount += 1;
  }
  return state;
}

/**
 * Tester (QA) 节点：在 feature 模式下，业务代码写入后由本节点生成单元测试计划。
 * 使用 node:test 与 node:assert，输出 replace_file 计划供 Executor 写入 .test.js 文件。
 * @param {object} state - 图状态，需包含 lastWrittenFile、context、requirement
 * @returns {Promise<object>} 更新后的 state（含 plan）
 */
async function testerNode(state) {
  const baseFile = state.lastWrittenFile;
  if (!baseFile || typeof baseFile !== "string") {
    console.warn(
      chalk.yellow("⚠️ [Tester] 缺少 lastWrittenFile，无法生成测试计划，跳过。"),
    );
    state.plan = null;
    return state;
  }

  // 同目录、同名 + .test.js，例如 sandbox/foo.js → sandbox/foo.test.js
  const baseDir = path.dirname(baseFile);
  const baseName = path.basename(baseFile, path.extname(baseFile));
  const suggestedTestPath =
    baseDir ? `${baseDir}/${baseName}.test.js` : `${baseName}.test.js`;

  const sys = [
    "你是一个极其严苛的资深 QA 测试工程师。开发者刚刚根据需求完成了业务代码的编写。",
    "请你使用 Node.js 原生的 node:test 和 node:assert 模块，为该文件编写极其完善的单元测试（必须包含边缘情况测试）。",
    "",
    "【输出格式的强制要求】",
    "你只能输出一个 JSON 对象，不能包含 Markdown 代码块或多余文字。",
    "格式必须严格为：",
    "{",
    '  "action": "replace_file",',
    '  "thought": "测试用例设计思路（简要说明覆盖了哪些场景与边界）",',
    `  "file": "测试文件相对路径，必须与业务文件同目录且命名为 原文件名.test.js，例如 \\"${suggestedTestPath}\\""`,
    '  "new_code": "完整的测试文件代码，使用 require(\\"node:test\\") 和 require(\\"node:assert\\")，可直接被 node --test 执行"',
    "}",
    "",
    "【路径守则】file 必须是相对路径，不能以 / 开头。",
  ].join("\n");

  const usr = [
    `刚写入的业务文件路径: ${baseFile}`,
    "",
    `当前项目上下文: ${state.context || "(无)"}`,
    "",
    `用户需求摘要: ${state.requirement || "(无)"}`,
  ].join("\n");

  const llmResult = await askAI(sys, usr, "qwen");
  let plan = llmResult;

  if (typeof plan === "string") {
    const trimmed = plan.trim();
    try {
      plan = JSON.parse(trimmed);
    } catch (error) {
      console.warn(
        chalk.yellow("⚠️ [Tester] 无法解析 LLM 返回的 JSON，原始内容："),
        trimmed?.slice(0, 200),
      );
      state.plan = null;
      return state;
    }
  }

  if (plan && typeof plan === "object" && plan.action === "replace_file") {
    if (!plan.file || !plan.new_code) {
      console.warn(
        chalk.yellow("⚠️ [Tester] 返回的 plan 缺少 file 或 new_code，跳过。"),
      );
      state.plan = null;
      return state;
    }
    // 强制测试文件路径为同目录的 .test.js，避免模型乱写路径
    const dir = path.dirname(baseFile);
    const name = path.basename(baseFile, path.extname(baseFile));
    plan.file = dir ? `${dir}/${name}.test.js` : `${name}.test.js`;
  }

  state.plan = plan;
  if (state.plan?.file) {
    state.testTarget = state.plan.file;
  }
  console.log(
    chalk.cyan("🧪 [Tester] 已生成单元测试计划，将写入:"),
    state.plan?.file || "(无)",
  );
  return state;
}

const workflow = {
  compile() {
    return {
      async invoke(initialState) {
        const state = { ...INITIAL_STATE, ...initialState };

        while (state.status === "running") {
          // feature 模式下业务代码写入后由 executor 置 phase=need_tester，此处流转到 Tester
          if (state.phase === "need_tester") {
            await testerNode(state);
            state.phase = null;
          } else {
            await supervisor(state);
          }
          if (state.status === "rollback") {
            break;
          }
          await executor(state);
        }

        return state;
      },
    };
  },
};

export const appGraph = workflow.compile();
