import { askAI } from './llm.js';
import { getBlacklist } from './memory.js';
import { access } from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { replaceFunction } from './astEditor.js';
import { askCommandPermission } from '../cli/ui.js';

const execAsync = promisify(exec);

function formatPlanDebug(plan) {
  try {
    return JSON.stringify(plan, null, 2);
  } catch {
    return String(plan);
  }
}

function renderExecutionPlan(plan) {
  let parsed = plan;

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed.trim());
    } catch {
      const header = chalk.bold.cyan('┌──────────────── DevAgent 执行计划 ────────────────┐');
      const title = chalk.bold.cyan('│  DevAgent Execution Plan (raw string)            │');
      const footer = chalk.bold.cyan('└──────────────────────────────────────────────────┘');
      const body = chalk.dim(parsed);
      return [header, title, footer, body].join('\n');
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    const header = chalk.bold.cyan('┌──────────────── DevAgent 执行计划 ────────────────┐');
    const title = chalk.bold.cyan('│  DevAgent Execution Plan (unstructured)          │');
    const footer = chalk.bold.cyan('└──────────────────────────────────────────────────┘');
    const body = chalk.dim(formatPlanDebug(parsed));
    return [header, title, footer, body].join('\n');
  }

  const action = parsed.action || 'unknown';
  const isRunCommand = action === 'run_command';
  const isEditCode = action === 'edit_code' || !action;

  const header = chalk.bold.cyan('┌──────────────── DevAgent 执行计划 ────────────────┐');
  const title = chalk.bold.cyan('│  DevAgent Execution Plan                          │');
  const footer = chalk.bold.cyan('└──────────────────────────────────────────────────┘');

  const lines = [];
  lines.push(header);
  lines.push(title);
  lines.push(footer);
  lines.push('');

  if (isRunCommand && typeof parsed.command === 'string') {
    lines.push(`${chalk.bold.white('动作:')} ${chalk.bold.blue('run_command')}`);
    lines.push(`${chalk.bold.white('命令:')} ${chalk.cyan(parsed.command)}`);
    if (typeof parsed.thought === 'string' && parsed.thought.trim()) {
      lines.push(`${chalk.bold.white('理由:')} ${chalk.dim(parsed.thought.trim())}`);
    }
  } else if (
    isEditCode &&
    typeof parsed.file === 'string' &&
    typeof parsed.target_function === 'string'
  ) {
    lines.push(`${chalk.bold.white('动作:')} ${chalk.bold.magenta('edit_code')}`);
    lines.push(`${chalk.bold.white('文件:')} ${chalk.cyan(parsed.file)}`);
    lines.push(
      `${chalk.bold.white('函数:')} ${chalk.yellow(parsed.target_function)}`,
    );
    if (typeof parsed.thought === 'string' && parsed.thought.trim()) {
      lines.push(`${chalk.bold.white('理由:')} ${chalk.dim(parsed.thought.trim())}`);
    }
    if (typeof parsed.new_code === 'string') {
      const preview = parsed.new_code.split('\n').slice(0, 3).join('\n');
      lines.push('');
      lines.push(chalk.bold.white('代码预览:'));
      lines.push(chalk.gray(preview));
      const moreLines = parsed.new_code.split('\n').length - 3;
      if (moreLines > 0) {
        lines.push(chalk.dim(`… 还有 ${moreLines} 行`));
      }
    }
  } else {
    lines.push(
      chalk.yellow(
        '⚠️ 未能识别标准计划结构，以下为原始内容（已格式化）：',
      ),
    );
    lines.push('');
    lines.push(chalk.dim(formatPlanDebug(parsed)));
  }

  return lines.join('\n');
}

const INITIAL_STATE = {
  context: null,
  errorLog: null,
  retryCount: 0,
  status: 'running',
  plan: null,
};

async function supervisor(state) {
  if (state.status === 'success') {
    return state;
  }

  if (state.retryCount >= 3) {
    state.status = 'rollback';
    return state;
  }

  const blacklist = await getBlacklist();

  const sys = [
    '你是一台**无情的 DevAgent Supervisor**，根据错误日志和项目上下文，为下游执行器规划下一步「行动方案」。',
    '现在你拥有两种武器，可以在每一轮只选择其中一种：',
    '',
    '【武器 1：edit_code（改代码）】',
    '- 使用场景：当你判断错误主要来源于代码逻辑 / 类型问题 / 函数实现错误时。',
    '- 你的任务是：决定要改写哪个文件中的哪一个函数，并给出该函数**完整且已经修复后的代码块**。',
    '',
    '【武器 2：run_command（执行终端命令）】',
    '- 使用场景：当你判断错误主要来源于缺少 npm 依赖、需要创建文件夹、缺少构建产物、依赖未安装、需要查看系统环境（例如 node 版本 / npm 版本）等「环境 / DevOps」问题时。',
    '- 你的任务是：给出一条需要在终端中执行的命令（例如 "npm install lodash"、"mkdir -p sandbox"、"node -v" 等）。',
    '',
    '【手术铁律（仅对 edit_code 生效）】',
    '- 除非报错明确指出测试文件语法错误，否则你【绝对优先】修改源业务代码文件（例如 "sandbox/mathUtils.js"、"src/core/xxx.js"），而不是去修改测试文件（例如 "test.js"、"src/test.js"）。',
    '- 你提供的 target_function 必须是该文件中真实存在的、标准的函数声明名称（例如 "add"、"multiply"、"handleError"、"createServer"）。绝对不要臆造测试块名称（例如 "test_add"、"should_add"、"add_should_return_sum" 等）。',
    '【导出守则】如果你修改的函数在原文件中带有 export 或 export const 关键字，你输出的 new_code 必须原封不动地带上这些导出声明，绝不能丢失！',
    '【路径守则】你返回的 file 路径绝对不能以 / 开头，必须是纯粹的相对路径（例如 "sandbox/mathUtils.js"）。',
    '',
    '【输出格式的强制要求（双模指令）】',
    '- 你**只能**输出一个 JSON 对象，绝不能输出多段或数组，也不能在前后添加多余解释文字。',
    '- 该 JSON 对象必须包含一个字段 action，且只能是 "edit_code" 或 "run_command" 之一。',
    '',
    '当你选择武器 1（改代码）时，输出格式必须**严格**为：',
    '{',
    '  "action": "edit_code",',
    '  "thought": "string，简要说明你根据错误日志的分析与决策（不超过 3 句）",',
    '  "file": "string，相对文件路径，例如 \\"sandbox/mathUtils.js\\" 或 \\"src/core/xxx.js\\"",',
    '  "target_function": "string，需要修改的函数名称，例如 \\"add\\"、\\"handleError\\"",',
    '  "new_code": "string，修复后的该函数完整代码块（不要带 markdown 标记，且绝对不要包含整个文件的其他代码）"',
    '}',
    '',
    '当你选择武器 2（执行终端命令）时，输出格式必须**严格**为：',
    '{',
    '  "action": "run_command",',
    '  "thought": "string，简要说明你为什么需要执行这条命令（不超过 3 句）",',
    '  "command": "string，需要在终端执行的完整命令，例如 \\"npm install lodash\\"、\\"mkdir -p sandbox\\""',
    '}',
    '',
    '【绝对禁止的行为】',
    '- 不允许输出除 action、thought、file、target_function、new_code、command 之外的任何字段。',
    '- 尤其**禁止**出现以下字段（或其英文 / 变体）：steps、step、actions、description、desc、analysis、plan、tool、tools、tool_calls、id、name、role、content、code 等一切无关字段。',
    '- 不允许输出 Markdown 代码块标记，例如 ```、```json、```js 等。',
    '- 不允许在 JSON 前后添加任何解释性文本、自然语言描述、前缀、后缀、标签等。',
    '',
    '【再提醒一次】',
    '- 你是一个**冷酷的 Supervisor 大脑**，只输出一个纯粹的 JSON 对象。',
    '- 该对象必须包含 action 字段，并根据你选择的武器严格符合上述结构。',
    '- 如果你输出了多余字段、Markdown 包裹、输出了整个文件的代码，或任意非 JSON 垃圾内容，将会被视为**严重错误**。',
    '',
    '现在，请根据给定的错误日志、项目上下文和黑名单，严格按上述要求输出 JSON 对象。',
  ].join('\n');

  const usrParts = [
    '当前错误日志：',
    state.errorLog || '(无错误日志)',
    '\n项目上下文：',
    state.context || '(无上下文)',
    '\n历史黑名单（最近问题）：',
    JSON.stringify(blacklist, null, 2),
  ];

  const usr = usrParts.join('\n');

  const llmResult = await askAI(sys, usr, 'qwen');

  let plan = llmResult;

  if (typeof plan === 'string') {
    const trimmed = plan.trim();
    try {
      plan = JSON.parse(trimmed);
    } catch (error) {
      console.warn('⚠️ [Supervisor] 无法解析 LLM 返回的 JSON，原始内容如下：');
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
  if (typeof plan === 'string') {
    try {
      plan = JSON.parse(plan.trim());
    } catch (error) {
      console.warn('\x1b[33m%s\x1b[0m', '⚠️ [Executor] state.plan 是字符串且无法解析为 JSON，跳过物理覆写。');
      console.warn(plan);
      state.retryCount += 1;
      return state;
    }
  }

  let file;
  let targetFunction;
  let newCode;
  let action;
  let command;

  if (plan && typeof plan === 'object') {
    const extractPlan = (value) => {
      if (
        value &&
        typeof value === 'object' &&
        typeof value.action === 'string'
      ) {
        return value;
      }
      return null;
    };

    let extracted = extractPlan(plan);

    if (!extracted) {
      // 兼容某些模型可能包了一层的情况，例如 { result: { file, target_function, new_code, thought } }
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
      if (action === 'run_command') {
        if (typeof extracted.command === 'string') {
          command = extracted.command;
        }
      } else if (action === 'edit_code' || !action) {
        if (
          typeof extracted.file === 'string' &&
          typeof extracted.target_function === 'string' &&
          typeof extracted.new_code === 'string'
        ) {
          file = extracted.file;
          targetFunction = extracted.target_function;
          newCode = extracted.new_code;
          if (!action) {
            action = 'edit_code';
          }
        }
      }
    }
  }

  if (!action) {
    console.warn('\x1b[33m%s\x1b[0m', '⚠️ [Executor] 计划中缺少 action 字段，无法路由执行。');
    console.warn('当前 plan 内容为:\n', formatPlanDebug(plan));
    state.retryCount += 1;
    return state;
  }

  if (action === 'run_command') {
    if (!command) {
      console.warn('\x1b[33m%s\x1b[0m', '⚠️ [Executor] run_command 计划缺少 command 字段，跳过执行。');
      console.warn('当前 plan 内容为:', plan);
      state.retryCount += 1;
      return state;
    }

    const allowed = await askCommandPermission(command);

    if (!allowed) {
      console.log('\x1b[33m%s\x1b[0m', '⚠️ [Executor] 人类已拦截该命令的执行。');
      state.errorLog = '人类拒绝了该命令的执行，请尝试其他方案';
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

      state.errorLog = '';
      state.status = 'success';
      return state;
    } catch (error) {
      const stderr = error.stderr || error.message || '';
      if (error.stdout) {
        process.stdout.write(error.stdout);
      }
      if (error.stderr) {
        process.stderr.write(error.stderr);
      }

      state.errorLog = stderr;
      state.retryCount += 1;
      return state;
    }
  }

  // 默认或 action === 'edit_code' 走原有代码修复分支
  if (!file || !targetFunction || !newCode) {
    console.warn('\x1b[33m%s\x1b[0m', '⚠️ [Executor] 计划中缺少 file、target_function 或 new_code 字段，跳过物理覆写。');
    console.warn('当前 plan 内容为:\n', formatPlanDebug(plan));
  } else {
    try {
      const cwd = process.cwd();
      const normalizedFile = file.startsWith('/') ? file.slice(1) : file;
      const directPath = path.resolve(cwd, normalizedFile);
      const srcFallbackPath = path.resolve(cwd, 'src', normalizedFile);

      let targetPath = directPath;

      try {
        await access(directPath);
      } catch {
        // 如果当前工作目录下不存在该文件，但 src 下存在同名文件，则优先覆写 src 下的文件
        try {
          await access(srcFallbackPath);
          targetPath = srcFallbackPath;
          console.log('\x1b[36m%s\x1b[0m', `ℹ️ [Executor] 未找到 ${file}，改为覆写 src/${file}`);
        } catch {
          // 两个路径都不存在，则按原始计划在 directPath 创建/覆写
          console.log('\x1b[36m%s\x1b[0m', `ℹ️ [Executor] 文件不存在，将在工作目录创建/覆写: ${directPath}`);
        }
      }

      await replaceFunction(targetPath, targetFunction, newCode);
      console.log(
        '\x1b[32m%s\x1b[0m',
        `✅ [Executor] AST 手术成功！精准替换了 ${file} 中的 ${targetFunction} 函数。`,
      );

      try {
        await execAsync(`node ${file}`);
        state.errorLog = '';
        state.status = 'success';
        console.log('\x1b[32m%s\x1b[0m', '✅ [Validator] 验证通过！Bug 已修复！');
      } catch (error) {
        const errorText = error.stderr || error.message;
        state.errorLog = errorText;
        console.warn('\x1b[33m%s\x1b[0m', '⚠️ [Validator] 修复无效，捕获到新报错...');
      }
    } catch (error) {
      console.error('\x1b[31m%s\x1b[0m', '❌ [Executor] 写入文件失败：', error);
    }
  }

  if (state.status !== 'success') {
    state.retryCount += 1;
  }
  return state;
}

const workflow = {
  compile() {
    return {
      async invoke(initialState) {
        const state = { ...INITIAL_STATE, ...initialState };

        while (state.status === 'running') {
          await supervisor(state);
          if (state.status === 'rollback') {
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

