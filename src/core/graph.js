import { askAI } from "./llm.js";
import { getBlacklist } from "./memory.js";
import { getAllMemories, saveMemory } from "../memory/db.js";
import { access, writeFile, readdir, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { exec, spawn } from "child_process";
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

const EXEC_TIMEOUT_MS = 10000;

/**
 * 判断 exec 抛错是否由超时/终止引起（案发现场保留场景）。
 * @param {object} error - exec 回调或 execAsync 抛出的错误
 * @returns {boolean}
 */
function isExecTimeoutOrKilled(error) {
  if (!error || typeof error !== "object") return false;
  if (error.killed === true) return true;
  if (error.signal === "SIGTERM" || error.signal === "SIGKILL") return true;
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return true;
  if (String(error.code || "").toLowerCase().includes("timeout")) return true;
  return false;
}

/**
 * 根据 exec 错误拼装送给大模型的错误日志：超时/终止时保留 stdout/stderr 作为案发现场，由 AI 自行推断，不写死结论。
 * @param {object} error - execAsync 抛出的错误（含 stdout、stderr）
 * @param {string} [prefix] - 前缀，如 "Command failed" 或 "Validator failed"
 * @returns {string}
 */
function buildExecErrorLog(error, prefix = "Command failed") {
  const stdoutLog = error.stdout ? `\n[STDOUT 输出]:\n${error.stdout}` : "";
  const stderrLog = error.stderr ? `\n[STDERR 输出]:\n${error.stderr}` : "";
  if (isExecTimeoutOrKilled(error)) {
    return `${prefix}: 命令执行被终止（超时或信号）。以下是终止前捕获的输出，请根据此推断当时状态并给出修复建议：${stdoutLog || "\n[STDOUT]: (无)"}${stderrLog || "\n[STDERR]: (无)"}`;
  }
  return `${prefix}: ${error.message || ""}${stdoutLog}${stderrLog}` || "";
}

/**
 * 确保解析后的路径位于 cwd 之下，防止路径穿越（只读检索用）。
 * @param {string} resolvedPath - 已 resolve 的绝对路径
 * @returns {string} 规范化后的路径
 * @throws {SecurityError} 若路径在工作区外
 */
function ensureUnderCwd(resolvedPath) {
  const cwd = process.cwd();
  const normalized = path.resolve(resolvedPath);
  const rel = path.relative(cwd, normalized);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new SecurityError(`路径不允许访问工作区之外: ${resolvedPath}`);
  }
  return normalized;
}

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
  } else if (action === "list_dir" && typeof parsed.path === "string") {
    lines.push(
      `${chalk.bold.white("动作:")} ${chalk.bold.blue("list_dir")}（只读检索）`,
    );
    lines.push(`${chalk.bold.white("目录:")} ${chalk.cyan(parsed.path)}`);
  } else if (action === "read_file" && typeof parsed.file === "string") {
    lines.push(
      `${chalk.bold.white("动作:")} ${chalk.bold.blue("read_file")}（只读检索）`,
    );
    lines.push(`${chalk.bold.white("文件:")} ${chalk.cyan(parsed.file)}`);
  } else if (
    action === "search_code" &&
    typeof parsed.keyword === "string" &&
    typeof parsed.path === "string"
  ) {
    lines.push(
      `${chalk.bold.white("动作:")} ${chalk.bold.blue("search_code")}（只读检索）`,
    );
    lines.push(`${chalk.bold.white("关键词:")} ${chalk.cyan(parsed.keyword)}`);
    lines.push(`${chalk.bold.white("范围:")} ${chalk.cyan(parsed.path)}`);
  } else if (action === "browse_web" && typeof parsed.url === "string") {
    lines.push(
      `${chalk.bold.white("动作:")} ${chalk.bold.blue("browse_web")}（联网查阅）`,
    );
    lines.push(`${chalk.bold.white("URL:")} ${chalk.cyan(parsed.url)}`);
  } else if (
    action === "memorize" &&
    typeof parsed.context === "string" &&
    typeof parsed.lesson === "string"
  ) {
    lines.push(
      `${chalk.bold.white("动作:")} ${chalk.bold.magenta("memorize")}（刻入记忆）`,
    );
    lines.push(
      `${chalk.bold.white("场景:")} ${chalk.cyan(parsed.context)}`,
    );
    lines.push(
      `${chalk.bold.white("教训:")} ${chalk.cyan(parsed.lesson)}`,
    );
  } else if (action === "finish" && typeof parsed.message === "string") {
    lines.push(
      `${chalk.bold.white("动作:")} ${chalk.bold.green("finish")}（主动交卷）`,
    );
    lines.push(
      `${chalk.bold.white("说明:")} ${chalk.cyan(parsed.message)}`,
    );
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
  /** Agentic Search：检索工具（list_dir/read_file/search_code）的返回结果，供 Supervisor 下一轮决策 */
  observations: [],
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
  const memories = getAllMemories();

  const memoryBlock =
    Array.isArray(memories) && memories.length > 0
      ? [
          "【项目专属记忆与黑名单 (极度重要)】：",
          "以下是你在这个项目中曾经踩过的坑或被定下的死规矩，请在规划和写代码时**绝对遵守**：",
          ...memories.map(
            (m) => `- [场景: ${m.context}] 教训: ${m.lesson}`,
          ),
        ].join("\n")
      : "";

  const mode = state.mode === "feature" ? "feature" : "fix";

  let sys;
  let usr;

  if (mode === "feature") {
    const baseSys = [
      "你现在是一名 DevAgent architect-planner 与全栈开发专家。",
      "你现在的任务是根据用户的需求从 0 到 1 编写代码。请仔细分析上下文，决定需要创建或修改哪些文件。你可以使用 replace_file 动作来生成完整文件，使用 patch_code 进行局部修改，或者使用 run_command 初始化依赖。",
      "",
      "在本模式下，你依然必须严格遵守以下 DevAgent 执行协议：",
      "",
      "你是一台**无情的 DevAgent Supervisor**，根据错误日志和项目上下文，为下游执行器规划下一步「行动方案」。",
      "现在你拥有多种武器，可以在每一轮只选择其中一种：",
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
      "【武器 4：list_dir（查看目录结构）】",
      '- 用于查看某个目录下的文件树结构。输出格式：{ "action": "list_dir", "path": "目录路径（相对路径，如 sandbox 或 src/core）" }',
      "",
      "【武器 5：read_file（读取文件内容）】",
      '- 当你需要了解某个文件的具体代码时使用。输出格式：{ "action": "read_file", "file": "文件路径（相对路径，如 sandbox/mathUtils.js）" }',
      "",
      "【武器 6：search_code（全局搜索）】",
      '- 在指定目录下全局搜索某个函数名或变量名。输出格式：{ "action": "search_code", "keyword": "搜索关键词", "path": "搜索范围目录（相对路径）" }',
      "",
      "【武器 7：browse_web（联网查阅）】",
      '- 用于访问外网获取文档、报错说明或第三方库用法。输出格式：{ "action": "browse_web", "url": "你想访问的完整URL(如 https://react.dev/)" }',
      "",
      "【武器 8：memorize（刻入记忆）】",
      '当你成功修复了一个非常隐蔽的 Bug，或者用户明确要求你记住某条规则时，可调用 memorize 将其永久刻入记忆库。输出格式：{ "action": "memorize", "context": "触发这个教训的场景，如\'升级 React\'", "lesson": "得出的结论或黑名单，如\'绝对不能使用过期的某库\'" }',
      "",
      "【武器 9：finish（主动交卷）】",
      '当你已经完全满足了用户的需求（例如：仅仅是查阅了网页并得出结论，或者仅仅是调用 memorize 记住了某条规矩），并且不需要修改任何代码时，**请务必调用 finish 动作来主动结束任务**！不要重复调用已执行过的动作。输出格式：{ "action": "finish", "message": "对用户的最终回复说明" }',
      "",
      "【Web 查阅策略】",
      "如果你遇到不熟悉的报错、未知的第三方库用法、或者需要查阅最新的官方文档，请毫不犹豫地使用 browse_web 动作去获取外部知识。获取到的网页内容会以 Markdown 格式返回到你的 observations 中。",
      "",
      "【Agentic Search 策略】",
      "在决定修改代码之前，如果你对项目结构或相关函数定义不清晰，请优先使用上述 list_dir、read_file、search_code 三种工具来收集上下文。收集到的信息会返回给你（observations），你可以据此再进行下一步动作。",
      "",
      "【手术铁律（仅对 patch_code / replace_file 生效）】",
      '除非报错明确指出测试文件语法错误，否则你【绝对优先】修改源业务代码文件（例如 "sandbox/mathUtils.js"、"src/core/xxx.js"），而不是去修改测试文件。',
      '【路径守则】你返回的 file/path 路径绝对不能以 / 开头，必须是纯粹的相对路径（例如 "sandbox/mathUtils.js"）。',
      "",
      "【输出格式的强制要求（三模指令）】",
      "- 你**只能**输出一个 JSON 对象，绝不能输出多段或数组，也不能在前后添加多余解释文字。",
      '- 该 JSON 对象必须包含一个字段 action，且只能是 "patch_code"、"replace_file"、"run_command"、"list_dir"、"read_file"、"search_code"、"browse_web"、"memorize"、"finish" 之一。',
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
      "当你选择 list_dir 时，输出格式必须**严格**为：",
      "{",
      '  "action": "list_dir",',
      '  "path": "string，相对目录路径，例如 \\"sandbox\\"、\\"src/core\\""',
      "}",
      "",
      "当你选择 read_file 时，输出格式必须**严格**为：",
      "{",
      '  "action": "read_file",',
      '  "file": "string，相对文件路径，例如 \\"sandbox/mathUtils.js\\""',
      "}",
      "",
      "当你选择 search_code 时，输出格式必须**严格**为：",
      "{",
      '  "action": "search_code",',
      '  "keyword": "string，搜索关键词（函数名、变量名等）",',
      '  "path": "string，搜索范围目录相对路径，例如 \\"src\\"、\\"sandbox\\""',
      "}",
      "",
      "当你选择 browse_web 时，输出格式必须**严格**为：",
      "{",
      '  "action": "browse_web",',
      '  "url": "string，你想访问的完整 URL，例如 \\"https://react.dev/\\""',
      "}",
      "",
      "当你选择 memorize 时，输出格式必须**严格**为：",
      "{",
      '  "action": "memorize",',
      '  "context": "string，触发这个教训的场景，如 \\"升级 React\\"",',
      '  "lesson": "string，得出的结论或黑名单，如 \\"绝对不能使用过期的某库\\""',
      "}",
      "",
      "当你选择 finish（主动交卷）时，输出格式必须**严格**为：",
      "{",
      '  "action": "finish",',
      '  "message": "string，对用户的最终回复说明"',
      "}",
      "",
      "【绝对禁止的行为】",
      "- 不允许输出除 action、thought、file、search_block、replace_block、new_code、command、path、keyword、url、context、lesson（memorize 时）、message（finish 时）之外的任何字段。",
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
    sys = (memoryBlock ? memoryBlock + "\n\n" : "") + baseSys.join("\n");

    usr = [
      `当前项目上下文: ${state.context || "(无上下文)"}`,
      "",
      `用户的新需求: ${state.requirement || "(无需求描述)"}`,
      "",
      "检索结果（observations，上一轮 list_dir/read_file/search_code 的返回）：",
      Array.isArray(state.observations) && state.observations.length > 0
        ? state.observations.join("\n\n---\n\n")
        : "(无)",
    ].join("\n");
  } else {
    const sysParts = [
      "【fix 模式唯一任务】忽略之前的开发需求（requirement）；现在的唯一任务是修复 errorLog 中的报错，使验证命令能够通过。",
      "",
      "【fix 模式铁律】在 fix 模式下，**严禁使用 finish 动作**，你必须通过修改代码或执行正确的环境命令来解决当前日志中的报错！不得以 finish 逃避问题。",
      "",
      "你是一台**无情的 DevAgent Supervisor**，根据错误日志和项目上下文，为下游执行器规划下一步「行动方案」。",
      "现在你拥有多种武器，可以在每一轮只选择其中一种：",
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
      "【武器 4：list_dir（查看目录结构）】",
      '- 用于查看某个目录下的文件树结构。输出格式：{ "action": "list_dir", "path": "目录路径（相对路径，如 sandbox 或 src/core）" }',
      "",
      "【武器 5：read_file（读取文件内容）】",
      '- 当你需要了解某个文件的具体代码时使用。输出格式：{ "action": "read_file", "file": "文件路径（相对路径，如 sandbox/mathUtils.js）" }',
      "",
      "【武器 6：search_code（全局搜索）】",
      '- 在指定目录下全局搜索某个函数名或变量名。输出格式：{ "action": "search_code", "keyword": "搜索关键词", "path": "搜索范围目录（相对路径）" }',
      "",
      "【武器 7：browse_web（联网查阅）】",
      '- 用于访问外网获取文档、报错说明或第三方库用法。输出格式：{ "action": "browse_web", "url": "你想访问的完整URL(如 https://react.dev/)" }',
      "",
      "【武器 8：memorize（刻入记忆）】",
      '当你成功修复了一个非常隐蔽的 Bug，或者用户明确要求你记住某条规则时，可调用 memorize 将其永久刻入记忆库。输出格式：{ "action": "memorize", "context": "触发这个教训的场景，如\'升级 React\'", "lesson": "得出的结论或黑名单，如\'绝对不能使用过期的某库\'" }',
      "",
      "【Web 查阅策略】",
      "如果你遇到不熟悉的报错、未知的第三方库用法、或者需要查阅最新的官方文档，请毫不犹豫地使用 browse_web 动作去获取外部知识。获取到的网页内容会以 Markdown 格式返回到你的 observations 中。",
      "",
      "【Agentic Search 策略】",
      "在决定修改代码之前，如果你对项目结构或相关函数定义不清晰，请优先使用上述 list_dir、read_file、search_code 三种工具来收集上下文。收集到的信息会返回给你（observations），你可以据此再进行下一步动作。",
      "",
      "【手术铁律（仅对 patch_code / replace_file 生效）】",
      '除非报错明确指出测试文件语法错误，否则你【绝对优先】修改源业务代码文件（例如 "sandbox/mathUtils.js"、"src/core/xxx.js"），而不是去修改测试文件（例如 "test.js"、"src/test.js"）。',
      '【路径守则】你返回的 file/path 路径绝对不能以 / 开头，必须是纯粹的相对路径（例如 "sandbox/mathUtils.js"）。',
      "",
      "【输出格式的强制要求（三模指令）】",
      "- 你**只能**输出一个 JSON 对象，绝不能输出多段或数组，也不能在前后添加多余解释文字。",
      '- 该 JSON 对象必须包含一个字段 action，且只能是 "patch_code"、"replace_file"、"run_command"、"list_dir"、"read_file"、"search_code"、"browse_web"、"memorize" 之一。（fix 模式下禁止使用 finish）',
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
      "当你选择 list_dir 时，输出格式必须**严格**为：",
      "{",
      '  "action": "list_dir",',
      '  "path": "string，相对目录路径，例如 \\"sandbox\\"、\\"src/core\\""',
      "}",
      "",
      "当你选择 read_file 时，输出格式必须**严格**为：",
      "{",
      '  "action": "read_file",',
      '  "file": "string，相对文件路径，例如 \\"sandbox/mathUtils.js\\""',
      "}",
      "",
      "当你选择 search_code 时，输出格式必须**严格**为：",
      "{",
      '  "action": "search_code",',
      '  "keyword": "string，搜索关键词（函数名、变量名等）",',
      '  "path": "string，搜索范围目录相对路径，例如 \\"src\\"、\\"sandbox\\""',
      "}",
      "",
      "当你选择 browse_web 时，输出格式必须**严格**为：",
      "{",
      '  "action": "browse_web",',
      '  "url": "string，你想访问的完整 URL，例如 \\"https://react.dev/\\""',
      "}",
      "",
      "当你选择 memorize 时，输出格式必须**严格**为：",
      "{",
      '  "action": "memorize",',
      '  "context": "string，触发这个教训的场景，如 \\"升级 React\\"",',
      '  "lesson": "string，得出的结论或黑名单，如 \\"绝对不能使用过期的某库\\""',
      "}",
      "",
      "【绝对禁止的行为】",
      "- **fix 模式下禁止使用 finish 动作**。不允许输出除 action、thought、file、search_block、replace_block、new_code、command、path、keyword、url、context、lesson（memorize 时）之外的任何字段。",
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

    sys = (memoryBlock ? memoryBlock + "\n\n" : "") + sysParts.join("\n");

    const usrParts = [
      "当前错误日志：",
      state.errorLog || "(无错误日志)",
      "\n项目上下文：",
      state.context || "(无上下文)",
      "\n历史黑名单（最近问题）：",
      JSON.stringify(blacklist, null, 2),
      "\n检索结果（observations，上一轮 list_dir/read_file/search_code 的返回）：",
      Array.isArray(state.observations) && state.observations.length > 0
        ? state.observations.join("\n\n---\n\n")
        : "(无)",
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
  let dirPath;
  let readFilePath;
  let searchKeyword;
  let searchDirPath;
  let browseUrl;
  let memorizeContext;
  let memorizeLesson;
  let finishMessage;

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
      } else if (action === "list_dir" && typeof extracted.path === "string") {
        dirPath = extracted.path;
      } else if (action === "read_file" && typeof extracted.file === "string") {
        readFilePath = extracted.file;
      } else if (
        action === "search_code" &&
        typeof extracted.keyword === "string" &&
        typeof extracted.path === "string"
      ) {
        searchKeyword = extracted.keyword;
        searchDirPath = extracted.path;
      } else if (
        action === "browse_web" &&
        typeof extracted.url === "string"
      ) {
        browseUrl = extracted.url;
      } else if (
        action === "memorize" &&
        typeof extracted.context === "string" &&
        typeof extracted.lesson === "string"
      ) {
        memorizeContext = extracted.context;
        memorizeLesson = extracted.lesson;
      } else if (
        action === "finish" &&
        typeof extracted.message === "string"
      ) {
        finishMessage = extracted.message;
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

  // finish：主动交卷，使用专属状态 interaction_completed，与“写完代码跑测试”的 success 区分
  if (action === "finish") {
    const msg = finishMessage != null ? String(finishMessage).trim() : "(无说明)";
    console.log(chalk.green("✅ [Executor] 任务已确认完成: " + msg));
    state.status = "interaction_completed";
    return state;
  }

  // memorize：将教训写入 SQLite 记忆库，observations 追加日志后回 Supervisor
  if (action === "memorize") {
    if (!memorizeContext || !memorizeLesson) {
      console.warn(
        chalk.yellow("⚠️ [Executor] memorize 计划缺少 context 或 lesson 字段，跳过。"),
      );
      state.retryCount += 1;
      return state;
    }
    try {
      saveMemory(memorizeContext, memorizeLesson);
      if (!Array.isArray(state.observations)) state.observations = [];
      state.observations.push(
        "🧠 [Memory] 已将该教训永久刻入 SQLite 记忆库",
      );
      state.observations.push(
        "系统反馈：记忆已成功刻入 SQLite。如果用户没有其他编码需求，你可以调用 finish 动作结束任务了。",
      );
      console.log(
        chalk.magenta("🧠 [Memory] 已将该教训永久刻入 SQLite 记忆库"),
      );
      state.status = "running";
      return state;
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn(chalk.yellow("⚠️ [Executor] memorize 失败: " + msg));
      if (!Array.isArray(state.observations)) state.observations = [];
      state.observations.push(`[memorize] 错误: ${msg}`);
      state.status = "running";
      return state;
    }
  }

  // 只读检索工具：不触发 Validator/Auditor，结果写入 observations 后直接回 Supervisor
  if (action === "list_dir") {
    if (!dirPath) {
      console.warn(
        chalk.yellow("⚠️ [Executor] list_dir 计划缺少 path 字段，跳过。"),
      );
      state.retryCount += 1;
      return state;
    }
    try {
      const cwd = process.cwd();
      const normalized = dirPath.startsWith("/") ? dirPath.slice(1) : dirPath;
      const resolved = path.resolve(cwd, normalized);
      ensureUnderCwd(resolved);
      const entries = await readdir(resolved, { withFileTypes: true });
      const lines = entries.map((e) =>
        e.isDirectory() ? `${e.name}/` : e.name,
      );
      const text = `[list_dir] ${dirPath}\n${lines.join("\n")}`;
      if (!Array.isArray(state.observations)) state.observations = [];
      state.observations.push(text);
      console.log(
        chalk.cyan("🔍 [Executor] list_dir 已执行，结果已写入 observations。"),
      );
      state.status = "running";
      return state;
    } catch (err) {
      if (err instanceof SecurityError || err?.name === "SecurityError") {
        state.errorLog = "🚨 [安全] " + (err.message || "路径被拒绝");
        state.retryCount += 1;
        return state;
      }
      const msg = err?.message || String(err);
      console.warn(chalk.yellow("⚠️ [Executor] list_dir 失败: " + msg));
      if (!Array.isArray(state.observations)) state.observations = [];
      state.observations.push(`[list_dir] ${dirPath} 错误: ${msg}`);
      state.status = "running";
      return state;
    }
  }

  if (action === "read_file") {
    if (!readFilePath) {
      console.warn(
        chalk.yellow("⚠️ [Executor] read_file 计划缺少 file 字段，跳过。"),
      );
      state.retryCount += 1;
      return state;
    }
    try {
      const cwd = process.cwd();
      const normalized = readFilePath.startsWith("/")
        ? readFilePath.slice(1)
        : readFilePath;
      const resolved = path.resolve(cwd, normalized);
      ensureUnderCwd(resolved);
      const content = await readFile(resolved, "utf8");
      const text = `[read_file] ${readFilePath}\n${content}`;
      if (!Array.isArray(state.observations)) state.observations = [];
      state.observations.push(text);
      console.log(
        chalk.cyan("🔍 [Executor] read_file 已执行，结果已写入 observations。"),
      );
      state.status = "running";
      return state;
    } catch (err) {
      if (err instanceof SecurityError || err?.name === "SecurityError") {
        state.errorLog = "🚨 [安全] " + (err.message || "路径被拒绝");
        state.retryCount += 1;
        return state;
      }
      const msg = err?.message || String(err);
      console.warn(chalk.yellow("⚠️ [Executor] read_file 失败: " + msg));
      if (!Array.isArray(state.observations)) state.observations = [];
      state.observations.push(`[read_file] ${readFilePath} 错误: ${msg}`);
      state.status = "running";
      return state;
    }
  }

  if (action === "search_code") {
    if (!searchKeyword || !searchDirPath) {
      console.warn(
        chalk.yellow(
          "⚠️ [Executor] search_code 计划缺少 keyword 或 path 字段，跳过。",
        ),
      );
      state.retryCount += 1;
      return state;
    }
    try {
      const cwd = process.cwd();
      const normalized = searchDirPath.startsWith("/")
        ? searchDirPath.slice(1)
        : searchDirPath;
      const resolved = path.resolve(cwd, normalized);
      ensureUnderCwd(resolved);
      const result = await new Promise((resolve, reject) => {
        const child = spawn("grep", ["-rn", searchKeyword, resolved], { cwd });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => {
          stdout += d.toString();
        });
        child.stderr.on("data", (d) => {
          stderr += d.toString();
        });
        child.on("close", (code) => resolve({ stdout, stderr, code }));
        child.on("error", reject);
      });
      const out =
        [result.stdout, result.stderr].filter(Boolean).join("\n") ||
        "(无匹配或无输出)";
      const text = `[search_code] keyword="${searchKeyword}" path=${searchDirPath}\n${out}`;
      if (!Array.isArray(state.observations)) state.observations = [];
      state.observations.push(text);
      console.log(
        chalk.cyan(
          "🔍 [Executor] search_code 已执行，结果已写入 observations。",
        ),
      );
      state.status = "running";
      return state;
    } catch (err) {
      if (err instanceof SecurityError || err?.name === "SecurityError") {
        state.errorLog = "🚨 [安全] " + (err.message || "路径被拒绝");
        state.retryCount += 1;
        return state;
      }
      const msg = err?.message || String(err);
      console.warn(chalk.yellow("⚠️ [Executor] search_code 失败: " + msg));
      if (!Array.isArray(state.observations)) state.observations = [];
      state.observations.push(
        `[search_code] keyword="${searchKeyword}" path=${searchDirPath} 错误: ${msg}`,
      );
      state.status = "running";
      return state;
    }
  }

  // 只读联网工具：通过 r.jina.ai 获取网页 Markdown，截断防爆破，不触发 Validator
  if (action === "browse_web") {
    if (!browseUrl) {
      console.warn(
        chalk.yellow("⚠️ [Executor] browse_web 计划缺少 url 字段，跳过。"),
      );
      state.retryCount += 1;
      return state;
    }
    try {
      console.log(
        chalk.cyan(`🌐 [Executor] 正在联网读取网页: ${browseUrl} ...`),
      );
      const response = await fetch("https://r.jina.ai/" + browseUrl);
      const markdownContent = await response.text();
      const truncatedContent = markdownContent.slice(0, 8000);
      const text = `\n\n[来自 ${browseUrl} 的网页内容]:\n${truncatedContent}`;
      if (!Array.isArray(state.observations)) state.observations = [];
      state.observations.push(text);
      console.log(
        chalk.cyan("🌐 [Executor] 网页内容已写入 observations，已交还 Supervisor。"),
      );
      return { ...state, status: "running" };
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn(chalk.yellow("⚠️ [Executor] browse_web 失败: " + msg));
      if (!Array.isArray(state.observations)) state.observations = [];
      state.observations.push(`[browse_web] ${browseUrl} 错误: ${msg}`);
      return { ...state, status: "running" };
    }
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
        state.status = "fatal_security";
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
      const { stdout, stderr } = await execAsync(command, {
        timeout: EXEC_TIMEOUT_MS,
      });

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
      if (error.stdout) {
        process.stdout.write(error.stdout);
      }
      if (error.stderr) {
        process.stderr.write(error.stderr);
      }
      state.errorLog = buildExecErrorLog(error, "Command failed");
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
          state.status = "fatal_security";
          renderSecurityBlockPanel();
          state.retryCount += 1;
          return state;
        }
        throw error;
      }

      // 语义级审计：在物理写入前由 LLM 审查代码是否包含高危模式（命令执行、敏感路径、未授权网络等）
      const audit = await auditCodeChange({
        action: "replace_file",
        file,
        new_code: newCode,
      });
      if (!audit.is_safe) {
        throw new SecurityError(`[语义审计拦截] ${audit.reason}`);
      }

      // 父目录不存在时 writeFile 会 ENOENT，先递归创建所有缺失父目录
      const dirPath = path.dirname(targetPath);
      await mkdir(dirPath, { recursive: true });

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
        await execAsync(validateCommand, { timeout: EXEC_TIMEOUT_MS });
        state.errorLog = "";
        state.status = "success";
        console.log(
          "\x1b[32m%s\x1b[0m",
          "✅ [Validator] 验证通过！全量覆盖后的文件可以正常执行。",
        );
      } catch (error) {
        state.errorLog = buildExecErrorLog(error, "Validator failed");
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
        state.status = "fatal_security";
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
          state.status = "fatal_security";
          renderSecurityBlockPanel();
          state.retryCount += 1;
          return state;
        }
        throw error;
      }

      // 语义级审计：在 patch 前由 LLM 审查 replace_block 是否包含高危模式
      const audit = await auditCodeChange({
        action: "patch_code",
        file,
        replace_block: replaceBlock,
      });
      if (!audit.is_safe) {
        throw new SecurityError(`[语义审计拦截] ${audit.reason}`);
      }

      // 若目标路径为新文件或父目录缺失，patch 前先确保父目录存在，避免后续写入 ENOENT
      const patchDirPath = path.dirname(targetPath);
      await mkdir(patchDirPath, { recursive: true });

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
        await execAsync(validateCommand, { timeout: EXEC_TIMEOUT_MS });
        state.errorLog = "";
        state.status = "success";
        console.log(
          "\x1b[32m%s\x1b[0m",
          "✅ [Validator] 验证通过！patch_code 修复有效。",
        );
      } catch (error) {
        state.errorLog = buildExecErrorLog(error, "Validator failed");
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
        state.status = "fatal_security";
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
  const knownActions = [
    "run_command",
    "replace_file",
    "patch_code",
    "list_dir",
    "read_file",
    "search_code",
    "browse_web",
  ];
  if (action && !knownActions.includes(action)) {
    console.warn(
      chalk.yellow(
        `⚠️ [Executor] 未识别的 action: "${action}"，请使用 patch_code、replace_file、run_command、list_dir、read_file、search_code 或 browse_web。`,
      ),
    );
    state.errorLog = `Executor 不支持 action "${action}"，请输出上述六种之一。`;
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
      chalk.yellow(
        "⚠️ [Tester] 缺少 lastWrittenFile，无法生成测试计划，跳过。",
      ),
    );
    state.plan = null;
    return state;
  }

  // 同目录、同名 + .test.js，例如 sandbox/foo.js → sandbox/foo.test.js
  const baseDir = path.dirname(baseFile);
  const baseName = path.basename(baseFile, path.extname(baseFile));
  const suggestedTestPath = baseDir
    ? `${baseDir}/${baseName}.test.js`
    : `${baseName}.test.js`;

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
          // 物理级刹车：安全拦截或重试耗尽时立即跳出状态机，不再进入下一轮 supervisor
          if (
            state.status === "rollback" ||
            state.status === "fatal_security"
          ) {
            break;
          }
          await executor(state);
          // interaction_completed：纯交互交卷，在此拦截并跳出循环导向 END，与正常“写完代码跑测试”的 success 区分
          if (state.status === "interaction_completed") {
            break;
          }
          // executor 内可能将 status 置为 fatal_security，需再次检查后立即跳出，避免下一轮再次进入 supervisor
          if (state.status === "fatal_security") {
            break;
          }
        }

        return state;
      },
    };
  },
};

export const appGraph = workflow.compile();
