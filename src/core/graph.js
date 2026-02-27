import { askAI } from './llm.js';
import { getBlacklist } from './memory.js';
import { writeFile } from 'fs/promises';

const INITIAL_STATE = {
  context: null,
  errorLog: null,
  retryCount: 0,
  status: 'running',
  plan: null,
};

async function supervisor(state) {
  if (state.retryCount >= 3) {
    state.status = 'rollback';
    return state;
  }

  const blacklist = await getBlacklist();

  const sys = [
    '你是一台**无情的代码修复机器**，只负责根据错误日志和项目上下文直接给出下一步「代码覆写」方案。',
    '你的唯一任务是：决定要改写哪个文件，并给出该文件**完整且已经修复后的代码**。',
    '',
    '【输出格式的强制要求】',
    '- 你**只能**输出一个 JSON 对象，且**必须且只允许**包含以下三个字段：',
    '  - thought: string，用于简短说明你根据错误日志做出的思考与决策过程（不超过 3 句）。',
    '  - file: string，需要修改的相对文件路径，例如 "src/test.js" 或 "test.js"。',
    '  - code: string，修改后的该文件【完整】代码内容（不是片段，而是整个文件）。',
    '',
    '【绝对禁止的行为】',
    '- 不允许输出除 thought、file、code 之外的任何字段。',
    '- 尤其**禁止**出现以下字段（或其英文 / 变体）：steps、step、action、actions、description、desc、analysis、plan、tool、tools、tool_calls、id、name、role、content 等一切无关字段。',
    '- 不允许输出 Markdown 代码块标记，例如 ```、```json、```js 等。',
    '- 不允许在 JSON 前后添加任何解释性文本、自然语言描述、前缀、后缀、标签等。',
    '',
    '【再提醒一次】',
    '- 你是一个**冷酷的代码修复执行大脑**，只输出一个纯粹的 JSON 对象，且键名严格为 thought、file、code。',
    '- 如果你输出了多余字段、Markdown 包裹、或任意非 JSON 垃圾内容，将会被视为**严重错误**。',
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

  const { file, code } = state.plan || {};

  if (!file || !code) {
    console.warn('\x1b[33m%s\x1b[0m', '⚠️ [Executor] 计划中缺少 file 或 code 字段，跳过物理覆写。');
  } else {
    try {
      await writeFile(file, code, 'utf8');
      console.log('\x1b[32m%s\x1b[0m', `✅ [Executor] 已成功覆写文件: ${file}`);
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

