#!/usr/bin/env node
import { createCheckpoint, rollback } from '../security/gitRollback.js';
import { appGraph } from '../core/graph.js';
import { getStagedDiff, getProjectTree } from '../core/contextFetcher.js';
import { addBlacklist } from '../core/memory.js';
import { askModelChoice, showSpinner } from './ui.js';

async function main() {
  const model = await askModelChoice();
  console.log(`已选择模型: ${model}`);

  const spinner = showSpinner('收集项目上下文中...');

  const [tree, diff] = await Promise.all([
    getProjectTree(process.cwd()),
    getStagedDiff(),
  ]);

  spinner.succeed('项目上下文收集完成。');

  const context = [
    '=== 项目结构 ===',
    tree,
    '',
    '=== 暂存区变更 ===',
    diff,
  ].join('\n');

  const mockError = 'MockError: DevAgent MVP 启动时的示例错误日志，用于驱动 LangGraph 流程。';

  await createCheckpoint();

  const finalState = await appGraph.invoke({
    context,
    errorLog: mockError,
    retryCount: 0,
    status: 'running',
    plan: null,
  });

  if (finalState.status === 'rollback') {
    console.log('⚠️ 检测到需要回滚，开始执行物理回滚...');
    await rollback();
    await addBlacklist(
      finalState.errorLog || mockError,
      'LangGraph 重试次数达到上限，触发自动回滚。',
    );
    console.log('✅ 已记录到黑名单，并完成回滚。');
  } else {
    console.log('✅ 流程结束，未触发回滚。');
  }
}

main().catch((error) => {
  console.error('CLI 运行失败:', error);
  process.exitCode = 1;
});

