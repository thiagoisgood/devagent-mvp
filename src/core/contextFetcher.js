import { promises as fs } from 'fs';
import path from 'path';
import simpleGit from 'simple-git';

const git = simpleGit();
const MAX_LENGTH = 8000;

function truncate(text) {
  if (!text) {
    return '';
  }
  if (text.length <= MAX_LENGTH) {
    return text;
  }
  return text.slice(0, MAX_LENGTH) + '\n...[已截断]';
}

export async function getStagedDiff() {
  try {
    const diff = await git.diff(['--cached']);
    return truncate(diff || '（当前没有暂存的变更）');
  } catch (error) {
    console.error('获取暂存区 diff 失败:', error.message);
    return '无法获取 Git 暂存区 diff，可能尚未初始化 Git 仓库。';
  }
}

async function walkDirectory(dir, prefix = '') {
  let lines = [];
  let entries;

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    console.error('读取目录失败:', dir, error.message);
    return [];
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.join(prefix, entry.name);

    if (entry.isDirectory()) {
      lines.push(`${relativePath}/`);
      const childLines = await walkDirectory(fullPath, relativePath);
      lines = lines.concat(childLines);
    } else {
      lines.push(relativePath);
    }

    const current = lines.join('\n');
    if (current.length > MAX_LENGTH) {
      return lines;
    }
  }

  return lines;
}

export async function getProjectTree(dir) {
  const lines = await walkDirectory(dir);
  const tree = lines.join('\n');
  return truncate(tree);
}

