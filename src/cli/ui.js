import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';

let activeSpinners = [];

export async function askModelChoice() {
  const answer = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: '选择要使用的大模型：',
      choices: [
        { name: 'Qwen (通义千问)', value: 'qwen' },
      ],
      default: 'qwen',
    },
  ]);

  return answer.model;
}

export function showSpinner(text) {
  const spinner = ora(text).start();
  activeSpinners.push(spinner);
  return spinner;
}

function stopAllSpinners() {
  for (const spinner of activeSpinners) {
    if (spinner.isSpinning) {
      spinner.stop();
    }
  }
  activeSpinners = [];
}

export async function askCommandPermission(command) {
  stopAllSpinners();

  const message = chalk.yellow('[Security]') +
    ' AI 申请执行终端命令: ' +
    chalk.cyan(command) +
    '，是否允许？';

  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message,
      default: true,
    },
  ]);

  return confirmed;
}

