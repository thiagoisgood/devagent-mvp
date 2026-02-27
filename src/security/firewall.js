import path from 'path';

export class SecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecurityError';
  }
}

function normalizeCommand(raw) {
  if (!raw || typeof raw !== 'string') {
    return '';
  }
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function validateCommand(command) {
  const normalized = normalizeCommand(command);

  if (!normalized) {
    return;
  }

  const deadlyPatterns = [
    /rm\s+-rf\b/,
    /\brm\s+-fr\b/,
    /\b(drop|truncate)\s+/,
    /\bmkfs\b/,
    /chmod\s+777\b/,
    /\bshutdown\b/,
  ];

  const isDeadly = deadlyPatterns.some((regex) => regex.test(normalized));

  if (isDeadly) {
    throw new SecurityError(
      '检测到极度危险的系统命令，已被安全铁幕无情拦截。',
    );
  }
}

function normalizePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return '';
  }

  const resolved = path.resolve(process.cwd(), filePath);
  return path.normalize(resolved);
}

export function validateFileAccess(filePath) {
  const normalizedPath = normalizePath(filePath);

  if (!normalizedPath) {
    return;
  }

  const lower = normalizedPath.toLowerCase();

  const isGitInternal =
    lower.includes(`${path.sep}.git${path.sep}`) || lower.endsWith(`${path.sep}.git`);

  const isEnvFile = lower.endsWith('.env');
  const isPemKey = lower.endsWith('.pem') || lower.endsWith('.key');

  if (isGitInternal || isEnvFile || isPemKey) {
    throw new SecurityError(
      '检测到对核心基础设施或密钥文件的写入尝试，已被安全铁幕无情拦截。',
    );
  }
}

