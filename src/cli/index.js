#!/usr/bin/env node
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { createCheckpoint, rollback } from '../security/gitRollback.js';
import { appGraph } from '../core/graph.js';
import { getStagedDiff, getProjectTree } from '../core/contextFetcher.js';
import { addBlacklist } from '../core/memory.js';
import { askModelChoice, showSpinner } from './ui.js';

const execAsync = promisify(exec);

async function main() {
  const model = await askModelChoice();
  console.log(`已选择模型: ${model}`);

  const { taskMode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'taskMode',
      message: '请选择当前的任务模式：',
      choices: [
        {
          name: '✨ 需求开发 (Feature)',
          value: 'feature',
        },
        {
          name: '🐛 自动修复报错 (BugFix)',
          value: 'fix',
        },
      ],
      default: 'feature',
    },
  ]);

  let userRequirement = null;

  if (taskMode === 'feature') {
    const { requirement } = await inquirer.prompt([
      {
        type: 'input',
        name: 'requirement',
        message: '请输入您的自然语言需求描述：',
      },
    ]);
    userRequirement = (requirement && requirement.trim()) || '';
  }

  const { verifyCommand: verifyCommandRaw } = await inquirer.prompt([
    {
      type: 'input',
      name: 'verifyCommand',
      message: '请输入用于验证结果的终端命令（如 node test.js 或 npm test）：',
    },
  ]);

  const verifyCommand = (verifyCommandRaw && verifyCommandRaw.trim()) || '';

  if (!verifyCommand) {
    console.log(
      chalk.yellow(
        '⚠️ [CLI] 未提供验证命令，本次不会执行 DevAgent 大闭环流程。',
      ),
    );
    return;
  }

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

  let checkpointCreated = false;
  async function ensureCheckpoint() {
    if (!checkpointCreated) {
      await createCheckpoint();
      checkpointCreated = true;
    }
  }

  let lastRealErrorLog = '';
  let lastFinalState = null;

  if (taskMode === 'feature') {
    console.log(
      chalk.cyan('🚀 阶段一：正在根据需求生成初始代码...'),
    );

    await ensureCheckpoint();

    const initialState = {
      context,
      errorLog: null,
      retryCount: 0,
      status: 'running',
      plan: null,
      mode: 'feature',
      requirement: userRequirement || '',
      monitorCommand: verifyCommand,
    };

    lastFinalState = await appGraph.invoke(initialState);
    lastRealErrorLog =
      (typeof lastFinalState.errorLog === 'string' &&
        lastFinalState.errorLog) ||
      '';

    if (
      typeof lastFinalState.errorLog === 'string' &&
      lastFinalState.errorLog.includes('[致命拦截]')
    ) {
      const panelWidth = 60;
      const title = ' SECURITY FIREWALL BLOCKED ';
      const paddedTitle = title.padEnd(panelWidth, ' ');
      const border = ''.padEnd(panelWidth, ' ');

      console.log(chalk.bgRed.white.bold(border));
      console.log(chalk.bgRed.white.bold(paddedTitle));
      console.log(chalk.bgRed.white.bold(border));
      console.log(
        chalk.bgRed.white.bold(
          ' 你的操作已被 DevAgent 安全铁幕强制拦截，请立即更换安全策略。 ',
        ),
      );
      console.log(chalk.bgRed.white.bold(border));
      console.log('');
    }

    if (lastFinalState.status === 'rollback') {
      const retriesUsed = lastFinalState.retryCount ?? 0;

      console.log(
        chalk.bgRed.black.bold(
          ' ROLLBACK INITIATED '.padEnd(60, ' '),
        ),
      );
      console.log(
        chalk.redBright(
          '发生问题，DevAgent 正在将您的工作区恢复到安全状态。',
        ),
      );
      console.log('');
      console.log(
        `${chalk.bold.white('状态:')} ${chalk.red.bold('✖ 已回滚')}`,
      );
      console.log(
        `${chalk.bold.white('重试次数:')} ${chalk.red(
          `${retriesUsed} 次（已达到上限）`,
        )}`,
      );
      console.log(
        `${chalk.bold.white('原因:')} ${chalk.red(
          lastFinalState.errorLog ||
            lastRealErrorLog ||
            'LangGraph 触发回滚，但未提供错误日志。',
        )}`,
      );
      console.log('');
      console.log(chalk.bold.white('后续建议:'));
      console.log(
        `  ${chalk.yellow('▸')} 检查上方错误信息，修复代码或配置问题。`,
      );
      console.log(
        `  ${chalk.yellow('▸')} 确认工作区状态正常后，可再次运行 DevAgent。`,
      );
      console.log(
        chalk.bgRed.black.bold(''.padEnd(60, ' ')),
      );

      await rollback();
      await addBlacklist(
        lastFinalState.errorLog ||
          lastRealErrorLog ||
          'LangGraph 触发回滚，但未提供错误日志。',
        'LangGraph 重试次数达到上限，触发自动回滚。',
      );

      return;
    }
  }

  let isResolved = false;
  let loopCount = 0;

  while (!isResolved && loopCount < 3) {
    console.log(
      chalk.cyan(
        `🏃‍♂️ 阶段二：正在执行验证命令: ${chalk.bold(verifyCommand)}`,
      ),
    );

    try {
      await execAsync(verifyCommand);
      console.log(chalk.green('✅ 完美通过验证！大闭环结束！'));
      isResolved = true;
      break;
    } catch (error) {
      const realErrorLog =
        error.stderr || error.message || String(error);
      lastRealErrorLog = realErrorLog;

      console.log(
        chalk.yellow(
          '⚠️ 检查到报错，正在唤醒 DevAgent 进行修改与升级...',
        ),
      );

      await ensureCheckpoint();

      const fixState = {
        context,
        errorLog: realErrorLog,
        retryCount: loopCount,
        status: 'running',
        plan: null,
        mode: 'fix',
        requirement: null,
        monitorCommand: verifyCommand,
      };

      const finalState = await appGraph.invoke(fixState);
      lastFinalState = finalState;

      if (
        typeof finalState.errorLog === 'string' &&
        finalState.errorLog.includes('[致命拦截]')
      ) {
        const panelWidth = 60;
        const title = ' SECURITY FIREWALL BLOCKED ';
        const paddedTitle = title.padEnd(panelWidth, ' ');
        const border = ''.padEnd(panelWidth, ' ');

        console.log(chalk.bgRed.white.bold(border));
        console.log(chalk.bgRed.white.bold(paddedTitle));
        console.log(chalk.bgRed.white.bold(border));
        console.log(
          chalk.bgRed.white.bold(
            ' 你的操作已被 DevAgent 安全铁幕强制拦截，请立即更换安全策略。 ',
          ),
        );
        console.log(chalk.bgRed.white.bold(border));
        console.log('');
      }

      if (finalState.status === 'rollback') {
        const retriesUsed = finalState.retryCount ?? loopCount;

        console.log(
          chalk.bgRed.black.bold(
            ' ROLLBACK INITIATED '.padEnd(60, ' '),
          ),
        );
        console.log(
          chalk.redBright(
            '发生问题，DevAgent 正在将您的工作区恢复到安全状态。',
          ),
        );
        console.log('');
        console.log(
          `${chalk.bold.white('状态:')} ${chalk.red.bold('✖ 已回滚')}`,
        );
        console.log(
          `${chalk.bold.white('重试次数:')} ${chalk.red(
            `${retriesUsed} 次（已达到上限）`,
          )}`,
        );
        console.log(
          `${chalk.bold.white('原因:')} ${chalk.red(
            finalState.errorLog ||
              realErrorLog ||
              'LangGraph 触发回滚，但未提供错误日志。',
          )}`,
        );
        console.log('');
        console.log(chalk.bold.white('后续建议:'));
        console.log(
          `  ${chalk.yellow('▸')} 检查上方错误信息，修复代码或配置问题。`,
        );
        console.log(
          `  ${chalk.yellow('▸')} 确认工作区状态正常后，可再次运行 DevAgent。`,
        );
        console.log(
          chalk.bgRed.black.bold(''.padEnd(60, ' ')),
        );

        await rollback();
        await addBlacklist(
          finalState.errorLog ||
            realErrorLog ||
            'LangGraph 触发回滚，但未提供错误日志。',
          'LangGraph 重试次数达到上限，触发自动回滚。',
        );

        return;
      }

      loopCount += 1;
    }
  }

  if (!isResolved && loopCount >= 3) {
    const retriesUsed =
      (lastFinalState && lastFinalState.retryCount) ?? loopCount;

    console.log(
      chalk.bgRed.black.bold(
        ' ROLLBACK INITIATED '.padEnd(60, ' '),
      ),
    );
    console.log(
      chalk.redBright(
        '多轮尝试后仍未通过验证，DevAgent 正在将您的工作区恢复到安全状态。',
      ),
    );
    console.log('');
    console.log(
      `${chalk.bold.white('状态:')} ${chalk.red.bold('✖ 已回滚')}`,
    );
    console.log(
      `${chalk.bold.white('重试次数:')} ${chalk.red(
        `${retriesUsed} 次`,
      )}`,
    );
    console.log(
      `${chalk.bold.white('原因:')} ${chalk.red(
        (lastFinalState && lastFinalState.errorLog) ||
          lastRealErrorLog ||
          'CLI 验证循环达到重试上限，触发自动回滚。',
      )}`,
    );
    console.log('');
    console.log(chalk.bold.white('后续建议:'));
    console.log(
      `  ${chalk.yellow('▸')} 检查上方错误信息，修复代码或配置问题。`,
    );
    console.log(
      `  ${chalk.yellow('▸')} 确认工作区状态正常后，可再次运行 DevAgent。`,
    );
    console.log(
      chalk.bgRed.black.bold(''.padEnd(60, ' ')),
    );

    await rollback();
    await addBlacklist(
      (lastFinalState && lastFinalState.errorLog) ||
        lastRealErrorLog ||
        'CLI 验证循环达到重试上限，触发自动回滚。',
      'CLI 验证循环达到重试上限，触发自动回滚。',
    );
    return;
  }
}

main().catch((error) => {
  console.error('CLI 运行失败:', error);
  process.exitCode = 1;
});

