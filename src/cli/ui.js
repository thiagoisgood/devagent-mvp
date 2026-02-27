import inquirer from 'inquirer';
import ora from 'ora';

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
  return ora(text).start();
}

