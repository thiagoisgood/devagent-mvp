#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCheckpoint, rollback } from '../security/gitRollback.js';
import { appGraph } from '../core/graph.js';
import { getStagedDiff, getProjectTree } from '../core/contextFetcher.js';
import { addBlacklist } from '../core/memory.js';
import { askModelChoice, showSpinner } from './ui.js';

function runTests() {
  return new Promise((resolve) => {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const testPath = path.resolve(__dirname, '..', 'test.js');

      const child = spawn(process.execPath, [testPath], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        const errorLog = [
          'Test runner failed to start.',
          `Error: ${error.message}`,
        ].join('\n');
        resolve({ errorLog, hasError: true });
      });

      child.on('close', (code) => {
        const hasError = code !== 0 || Boolean(stderr.trim());
        const summaryLines = [
          `Test exit code: ${code}`,
          stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
          stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
        ].filter(Boolean);

        const errorLog = summaryLines.join('\n') || '(无错误日志)';
        resolve({ errorLog, hasError });
      });
    } catch (error) {
      const errorLog = [
        'Unexpected error while preparing test runner.',
        `Error: ${error.message}`,
      ].join('\n');
      resolve({ errorLog, hasError: true });
    }
  });
}

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

  const { errorLog: testErrorLog } = await runTests();

  await createCheckpoint();

  const finalState = await appGraph.invoke({
    context,
    errorLog: testErrorLog,
    retryCount: 0,
    status: 'running',
    plan: null,
  });

  if (finalState.status === 'rollback') {
    console.log('⚠️ 检测到需要回滚，开始执行物理回滚...');
    await rollback();
    await addBlacklist(
      finalState.errorLog || testErrorLog || 'LangGraph 触发回滚，但未提供错误日志。',
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

