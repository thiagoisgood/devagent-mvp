#!/usr/bin/env node

import { createRequire } from "node:module";
import chalk from "chalk";
import inquirer from "inquirer";
import { createCheckpoint, rollback } from "../security/gitRollback.js";
import { runInSandbox } from "../security/sandbox.js";
import { appGraph } from "../core/graph.js";
import { getStagedDiff, getProjectTree } from "../core/contextFetcher.js";
import { addBlacklist } from "../core/memory.js";
import { askModelChoice, showSpinner } from "./ui.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  console.log("v" + (pkg.version || "0.0.0"));
  process.exit(0);
}
// 仅在不带任何参数时进入主程序；带其它参数则提示用法并退出
if (args.length > 0) {
  console.error("Usage: devagent");
  console.error("       devagent --version | -v");
  process.exit(1);
}

const VERIFY_TIMEOUT_MS = 10000;

/** 判断是否为超时/终止类错误（用于保留案发现场 stdout/stderr，交给 AI 推断） */
function isVerifyTimeoutOrKilled(error) {
  if (!error || typeof error !== "object") return false;
  if (error.killed === true) return true;
  if (error.signal === "SIGTERM" || error.signal === "SIGKILL") return true;
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return true;
  if (String(error.code || "").toLowerCase().includes("timeout")) return true;
  return false;
}

/** 拼装启发式错误日志：超时/终止时保留案发现场，不写死结论，交给大模型推断 */
function buildVerifyErrorLog(error) {
  const stdoutLog = error.stdout ? `\n[STDOUT 输出]:\n${error.stdout}` : "";
  const stderrLog = error.stderr ? `\n[STDERR 输出]:\n${error.stderr}` : "";
  if (isVerifyTimeoutOrKilled(error)) {
    return `\n🚨 [致命超时]: 命令执行超过 10 秒被系统强杀！这可能是因为：1) 死循环。2) 测试了交互式 CLI 文件。3) 首次运行正在下载 Docker 镜像。请分析以上日志进行修复或重试！${stdoutLog || "\n[STDOUT]: (无)"}${stderrLog || "\n[STDERR]: (无)"}`;
  }
  return `Command failed: ${error.message || ""}${stdoutLog}${stderrLog}`;
}

async function main() {
  const model = await askModelChoice();
  console.log(`已选择模型: ${model}`);

  const { taskMode } = await inquirer.prompt([
    {
      type: "list",
      name: "taskMode",
      message: "Please select the current task mode:",
      choices: [
        {
          name: "✨ 需求开发 (Feature)",
          value: "feature",
        },
        {
          name: "🐛 自动修复报错 (BugFix)",
          value: "fix",
        },
      ],
      default: "feature",
    },
  ]);

  let userRequirement = null;

  if (taskMode === "feature") {
    const { requirement } = await inquirer.prompt([
      {
        type: "input",
        name: "requirement",
        message: "请输入您的自然语言需求描述：",
      },
    ]);
    userRequirement = (requirement && requirement.trim()) || "";
  }

  const verifyCommandMessage =
    taskMode === "feature"
      ? "请输入验证命令（直接回车将默认使用 node --test 执行 AI 生成的测试用例）："
      : "请输入用于验证结果的终端命令（如 node test.js 或 npm test）：";

  const { verifyCommand: verifyCommandRaw } = await inquirer.prompt([
    {
      type: "input",
      name: "verifyCommand",
      message: verifyCommandMessage,
    },
  ]);

  let verifyCommand = (verifyCommandRaw && verifyCommandRaw.trim()) || "";
  if (taskMode === "feature" && !verifyCommand) {
    verifyCommand = "node --test";
  }

  if (!verifyCommand) {
    console.log(
      chalk.yellow(
        "⚠️ [CLI] 未提供验证命令，本次不会执行 DevAgent 大闭环流程。",
      ),
    );
    return;
  }

  const spinner = showSpinner("收集项目上下文中...");

  const [tree, diff] = await Promise.all([
    getProjectTree(process.cwd()),
    getStagedDiff(),
  ]);

  spinner.succeed("项目上下文收集完成。");

  const context = [
    "=== 项目结构 ===",
    tree,
    "",
    "=== 暂存区变更 ===",
    diff,
  ].join("\n");

  let checkpointCreated = false;
  async function ensureCheckpoint() {
    if (!checkpointCreated) {
      await createCheckpoint();
      checkpointCreated = true;
    }
  }

  let lastRealErrorLog = "";
  let lastFinalState = null;

  if (taskMode === "feature") {
    console.log(chalk.cyan("🚀 阶段一：正在根据需求生成初始代码..."));

    await ensureCheckpoint();

    const initialState = {
      context,
      errorLog: null,
      retryCount: 0,
      status: "running",
      plan: null,
      mode: "feature",
      requirement: userRequirement || "",
      monitorCommand: verifyCommand,
    };

    lastFinalState = await appGraph.invoke(initialState);
    lastRealErrorLog =
      (typeof lastFinalState.errorLog === "string" &&
        lastFinalState.errorLog) ||
      "";

    // 主动交卷：仅当专属状态 interaction_completed 时短路，不误杀正常“写完代码跑测试”的 success 流程
    if (lastFinalState.status === "interaction_completed") {
      console.log(
        chalk.green(
          "✅ 流程结束：AI 已完成交互任务，无需更改代码，跳过后续测试验证。",
        ),
      );
      process.exit(0);
    }

    // 安全熔断：Feature 阶段若遇防火墙或语义审计拦截，立即回滚并退出，不进入后续重试
    const featureSecurityIntercept =
      typeof lastFinalState.errorLog === "string" &&
      (lastFinalState.errorLog.includes("[致命拦截]") ||
        lastFinalState.errorLog.includes("[语义审计拦截]"));
    if (featureSecurityIntercept) {
      console.log(
        chalk.bgRed.white.bold(
          "\n🚨 检测到高危安全拦截！DevAgent 已触发快速熔断机制，终止所有重试！\n",
        ),
      );
      await rollback();
      return;
    }

    // 靶向测试隔离：若存在本次生成的测试路径且验证命令为默认 node --test，则锁定为单文件执行，避免全局扫描污染
    if (lastFinalState.testTarget && verifyCommand === "node --test") {
      verifyCommand = `node --test ${lastFinalState.testTarget}`;
      console.log(
        chalk.blue(
          `🎯 [隔离执行] 已将测试范围锁定为单一文件: ${lastFinalState.testTarget}`,
        ),
      );
    }

    if (lastFinalState.status === "rollback") {
      const retriesUsed = lastFinalState.retryCount ?? 0;

      console.log(
        chalk.bgRed.black.bold(" ROLLBACK INITIATED ".padEnd(60, " ")),
      );
      console.log(
        chalk.redBright("发生问题，DevAgent 正在将您的工作区恢复到安全状态。"),
      );
      console.log("");
      console.log(`${chalk.bold.white("状态:")} ${chalk.red.bold("✖ 已回滚")}`);
      console.log(
        `${chalk.bold.white("重试次数:")} ${chalk.red(
          `${retriesUsed} 次（已达到上限）`,
        )}`,
      );
      console.log(
        `${chalk.bold.white("原因:")} ${chalk.red(
          lastFinalState.errorLog ||
            lastRealErrorLog ||
            "LangGraph 触发回滚，但未提供错误日志。",
        )}`,
      );
      console.log("");
      console.log(chalk.bold.white("后续建议:"));
      console.log(
        `  ${chalk.yellow("▸")} 检查上方错误信息，修复代码或配置问题。`,
      );
      console.log(
        `  ${chalk.yellow("▸")} 确认工作区状态正常后，可再次运行 DevAgent。`,
      );
      console.log(chalk.bgRed.black.bold("".padEnd(60, " ")));

      await rollback();
      await addBlacklist(
        lastFinalState.errorLog ||
          lastRealErrorLog ||
          "LangGraph 触发回滚，但未提供错误日志。",
        "LangGraph 重试次数达到上限，触发自动回滚。",
      );

      return;
    }
  }

  let isResolved = false;
  let loopCount = 0;
  /** 安全熔断：检测到 [致命拦截] 或 [语义审计拦截] 时置为 true，跳出大循环并快速失败 */
  let securityFuseTriggered = false;

  while (!isResolved && loopCount < 3) {
    console.log(
      chalk.cyan(`🏃‍♂️ 阶段二：正在执行验证命令: ${chalk.bold(verifyCommand)}`),
    );
    console.log(
      chalk.blue("🐳 [Sandbox] 已将测试命令关入 Docker 隔离沙盒中执行..."),
    );

    try {
      const { stdout, stderr } = await runInSandbox(
        verifyCommand,
        VERIFY_TIMEOUT_MS,
      );
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      console.log(chalk.green("✅ 完美通过验证！大闭环结束！"));
      isResolved = true;
      break;
    } catch (error) {
      const realErrorLog = buildVerifyErrorLog(error);
      lastRealErrorLog = realErrorLog;

      console.log(
        chalk.yellow("⚠️ 检查到报错，正在唤醒 DevAgent 进行修改与升级..."),
      );

      await ensureCheckpoint();

      const fixState = {
        context,
        errorLog: realErrorLog,
        retryCount: loopCount,
        status: "running",
        plan: null,
        mode: "fix",
        requirement: null,
        monitorCommand: verifyCommand,
      };

      const finalState = await appGraph.invoke(fixState);
      lastFinalState = finalState;

      // 主动交卷：仅当专属状态 interaction_completed 时短路，不误杀正常“写完代码跑测试”的 success 流程
      if (finalState.status === "interaction_completed") {
        console.log(
          chalk.green(
            "✅ 流程结束：AI 已完成交互任务，无需更改代码，跳过后续测试验证。",
          ),
        );
        process.exit(0);
      }

      // 安全熔断：仅当非安全拦截时才消耗重试机会；拦截时快速失败并跳出大循环
      const isSecurityIntercept =
        typeof finalState.errorLog === "string" &&
        (finalState.errorLog.includes("[致命拦截]") ||
          finalState.errorLog.includes("[语义审计拦截]"));
      if (isSecurityIntercept) {
        console.log(
          chalk.bgRed.white.bold(
            "\n🚨 检测到高危安全拦截！DevAgent 已触发快速熔断机制，终止所有重试！\n",
          ),
        );
        await rollback();
        securityFuseTriggered = true;
        break;
      }

      if (finalState.status === "rollback") {
        const retriesUsed = finalState.retryCount ?? loopCount;

        console.log(
          chalk.bgRed.black.bold(" ROLLBACK INITIATED ".padEnd(60, " ")),
        );
        console.log(
          chalk.redBright(
            "发生问题，DevAgent 正在将您的工作区恢复到安全状态。",
          ),
        );
        console.log("");
        console.log(
          `${chalk.bold.white("状态:")} ${chalk.red.bold("✖ 已回滚")}`,
        );
        console.log(
          `${chalk.bold.white("重试次数:")} ${chalk.red(
            `${retriesUsed} 次（已达到上限）`,
          )}`,
        );
        console.log(
          `${chalk.bold.white("原因:")} ${chalk.red(
            finalState.errorLog ||
              realErrorLog ||
              "LangGraph 触发回滚，但未提供错误日志。",
          )}`,
        );
        console.log("");
        console.log(chalk.bold.white("后续建议:"));
        console.log(
          `  ${chalk.yellow("▸")} 检查上方错误信息，修复代码或配置问题。`,
        );
        console.log(
          `  ${chalk.yellow("▸")} 确认工作区状态正常后，可再次运行 DevAgent。`,
        );
        console.log(chalk.bgRed.black.bold("".padEnd(60, " ")));

        await rollback();
        await addBlacklist(
          finalState.errorLog ||
            realErrorLog ||
            "LangGraph 触发回滚，但未提供错误日志。",
          "LangGraph 重试次数达到上限，触发自动回滚。",
        );

        return;
      }

      loopCount += 1;
    }
  }

  if (securityFuseTriggered) {
    process.exit(1);
  }

  if (!isResolved && loopCount >= 3) {
    const retriesUsed =
      (lastFinalState && lastFinalState.retryCount) ?? loopCount;

    console.log(chalk.bgRed.black.bold(" ROLLBACK INITIATED ".padEnd(60, " ")));
    console.log(
      chalk.redBright(
        "多轮尝试后仍未通过验证，DevAgent 正在将您的工作区恢复到安全状态。",
      ),
    );
    console.log("");
    console.log(`${chalk.bold.white("状态:")} ${chalk.red.bold("✖ 已回滚")}`);
    console.log(
      `${chalk.bold.white("重试次数:")} ${chalk.red(`${retriesUsed} 次`)}`,
    );
    console.log(
      `${chalk.bold.white("原因:")} ${chalk.red(
        (lastFinalState && lastFinalState.errorLog) ||
          lastRealErrorLog ||
          "CLI 验证循环达到重试上限，触发自动回滚。",
      )}`,
    );
    console.log("");
    console.log(chalk.bold.white("后续建议:"));
    console.log(
      `  ${chalk.yellow("▸")} 检查上方错误信息，修复代码或配置问题。`,
    );
    console.log(
      `  ${chalk.yellow("▸")} 确认工作区状态正常后，可再次运行 DevAgent。`,
    );
    console.log(chalk.bgRed.black.bold("".padEnd(60, " ")));

    await rollback();
    await addBlacklist(
      (lastFinalState && lastFinalState.errorLog) ||
        lastRealErrorLog ||
        "CLI 验证循环达到重试上限，触发自动回滚。",
      "CLI 验证循环达到重试上限，触发自动回滚。",
    );
    return;
  }
}

main().catch((error) => {
  console.error("CLI 运行失败:", error);
  process.exitCode = 1;
});
