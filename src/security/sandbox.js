/*
 * @Author: Thiago
 * @Date: 2026-02-28 18:52:44
 * @LastEditors: Thiago
 * @LastEditTime: 2026-02-28 21:27:52
 * @FilePath: /devagent-mvp/src/security/sandbox.js
 * @Description:
 */
/**
 * Docker 安全沙盒执行器：所有验证命令在资源受限的容器内执行，避免在宿主机直接跑不可信命令。
 * @module security/sandbox
 */

import { exec } from "child_process";
import { promisify } from "util";
import chalk from "chalk";

const execAsync = promisify(exec);

const DOCKER_IMAGE = "node:22-alpine";
const MEMORY_LIMIT = "512m";
const CPU_LIMIT = "1.0";

/**
 * 在 Docker 隔离沙盒中执行命令。先校验宿主机 Docker 可用，再以严苛资源限制运行。
 * @param {string} command - 要在容器内执行的 shell 命令（如 node --test、npm test）
 * @param {number} [timeoutMs=10000] - 超时毫秒数
 * @returns {Promise<{ stdout: string, stderr: string }>} 命令的标准输出与标准错误
 * @throws 若未检测到 Docker 或命令执行失败（含 stdout/stderr 挂载到 error 上供上游推断）
 */
export async function runInSandbox(command, timeoutMs = 10000) {
  // 先确认宿主机已开启 Docker，避免后续拼接命令无意义执行
  try {
    await execAsync("docker --version", { timeout: 5000 });
  } catch (_) {
    const msg =
      "🚨 致命错误：未检测到 Docker 环境，沙盒隔离引擎启动失败，请先启动 Docker Desktop！";
    const err = new Error(msg);
    err.code = "DOCKER_NOT_AVAILABLE";
    throw err;
  }

  // 首次运行拉取镜像可能较久，提前提醒避免用户误判为死循环或 CLI 卡死
  console.log(
    chalk.blue(
      "🐳 [Sandbox] 如果是首次运行，Docker 可能会因为下载 node:18-alpine 镜像而花费较长时间，此时可能会触发超时。",
    ),
  );

  const cwd = process.cwd();
  // 单引号包裹并转义内部单引号，避免 sh -c 注入与解析错误
  const safeCommand = "'" + String(command).replace(/'/g, "'\\''") + "'";
  const dockerCmd = [
    "docker",
    "run",
    "--rm",
    "-v",
    `"${cwd}:/app"`,
    "-w",
    "/app",
    `--memory=${MEMORY_LIMIT}`,
    `--cpus=${CPU_LIMIT}`,
    DOCKER_IMAGE,
    "sh",
    "-c",
    safeCommand,
  ].join(" ");

  try {
    const result = await execAsync(dockerCmd, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    // Node exec 在非零退出时会在 error 上挂载 stdout/stderr，CLI 的 buildVerifyErrorLog 依赖此格式，直接 rethrow 即可
    throw error;
  }
}
