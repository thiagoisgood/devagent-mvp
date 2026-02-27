import { askAI } from './llm.js';
import { getBlacklist } from './memory.js';
import { access } from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { replaceFunction } from './astEditor.js';

const execAsync = promisify(exec);

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
    '你是一台**无情的代码修复机器**，只负责根据错误日志和项目上下文直接给出下一步「代码手术」方案。',
    '你的唯一任务是：决定要改写哪个文件中的哪一个函数，并给出该函数**完整且已经修复后的代码块**。',
    '',
    '【输出格式的强制要求】',
    '- 你**只能**输出一个 JSON 对象，且**必须且只允许**包含以下四个字段：',
    '  - thought: string，用于简短说明你根据错误日志做出的思考与决策过程（不超过 3 句）。',
    '  - file: string，需要修改的相对文件路径，例如 "src/test.js" 或 "test.js"。',
    '  - target_function: string，需要修改的函数名称（必须极其准确，例如 "handleError" 或 "createServer"）。',
    '  - new_code: string，修复后的该函数完整代码块（不要带 markdown 标记，且**绝对不要**包含整个文件的其他代码）。',
    '',
    '【绝对禁止的行为】',
    '- 不允许输出除 thought、file、target_function、new_code 之外的任何字段。',
    '- 尤其**禁止**出现以下字段（或其英文 / 变体）：steps、step、action、actions、description、desc、analysis、plan、tool、tools、tool_calls、id、name、role、content、code 等一切无关字段。',
    '- 不允许输出 Markdown 代码块标记，例如 ```、```json、```js 等。',
    '- 不允许在 JSON 前后添加任何解释性文本、自然语言描述、前缀、后缀、标签等。',
    '',
    '【再提醒一次】',
    '- 你是一个**冷酷的代码修复执行大脑**，只输出一个纯粹的 JSON 对象，且键名严格为 thought、file、target_function、new_code。',
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
  console.log('🧭 [Executor] 本轮执行计划:');
  console.log(state.plan);

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

  if (plan && typeof plan === 'object') {
    const extractPlan = (value) => {
      if (
        value &&
        typeof value === 'object' &&
        typeof value.file === 'string' &&
        typeof value.target_function === 'string' &&
        typeof value.new_code === 'string'
      ) {
        return {
          file: value.file,
          targetFunction: value.target_function,
          newCode: value.new_code,
        };
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
      ({ file, targetFunction, newCode } = extracted);
    }
  }

  if (!file || !targetFunction || !newCode) {
    console.warn('\x1b[33m%s\x1b[0m', '⚠️ [Executor] 计划中缺少 file、target_function 或 new_code 字段，跳过物理覆写。');
    console.warn('当前 plan 内容为:', plan);
  } else {
    try {
      const cwd = process.cwd();
      const directPath = path.resolve(cwd, file);
      const srcFallbackPath = path.resolve(cwd, 'src', file);

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

  state.retryCount += 1;
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

