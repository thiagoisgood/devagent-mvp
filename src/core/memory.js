import { promises as fs } from 'fs';
import path from 'path';

const stateFilePath = path.resolve(process.cwd(), '.devagent_state.json');

async function readState() {
  try {
    const content = await fs.readFile(stateFilePath, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    console.error('读取黑名单失败:', error.message);
    return [];
  }
}

async function writeState(list) {
  await fs.writeFile(stateFilePath, JSON.stringify(list, null, 2), 'utf8');
}

export async function getBlacklist() {
  return readState();
}

export async function addBlacklist(errorLog, reason) {
  const list = await readState();
  list.push({
    errorLog,
    reason,
    timestamp: new Date().toISOString(),
  });
  await writeState(list);
}

