import { askAI } from './llm.js';
import { getBlacklist } from './memory.js';

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
    '你是 DevAgent 的监督者，负责根据错误日志和项目上下文生成下一步执行计划。',
    '输出必须是一个 JSON 对象，字段可以根据需要自行设计，但要自洽。',
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

  // 注意：这里直接赋值，不进行 trim 或 JSON.parse
  state.plan = llmResult;

  return state;
}

async function executor(state) {
  // 这里暂时只模拟执行计划
  console.log('🧭 [Executor] 本轮执行计划:');
  console.log(state.plan);

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

