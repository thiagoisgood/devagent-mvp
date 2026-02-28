# 🚀 DevAgent (MVP)
> **An Enterprise-Grade Autonomous SWE Agent.**
> 你的下一代全自动本地代码架构师。基于图状态机编排的 AI 结对编程引擎，具备 TDD 测试驱动、语义级代码手术、全仓 RAG 感知与极强防御纵深。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/Status-MVP-orange.svg)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)]()

[English Documentation](./README_EN.md) | **中文文档**

---

## 💡 重新定义 AI 编程 (The Vision)

目前的 AI 辅助编程大多停留在“代码补全 (Copilot)”或“单文件对话 (Chat)”。
**DevAgent 的目标是接管软件工程的全局生命周期 (SDLC)。** 它采用独特的 **带状态回滚的监督者-执行者架构 (Supervisor-Actor Architecture with Deterministic Rollbacks)**。你只需输入一句自然语言需求，DevAgent 将自动组建跨职能虚拟团队，完成：`需求拆解` -> `全仓检索` -> `代码编写` -> `安全审计` -> `TDD 自动测试` -> `报错推理与自我修复` 的完整闭环。它不仅会写代码，更懂得在搞砸时自动执行物理回滚。

## ✨ 核心架构与特性 (The 4 Pillars)

### 1. 🧠 多智能体协同状态机 (Multi-Agent State Machine)
底层告别死板的线性脚本，采用 LangGraph 理念构建的图状态机，包含多个独立运作的 Agent 节点：
- **👑 Supervisor (监督者/主程)**：全场调度核心，负责理解上下文、规划任务流、分发动作。
- **🛠️ Executor (执行者)**：极其精准的代码刀客，负责执行具体的重构或文件读写。
- **🧪 Tester (QA 测试专员)**：基于新业务代码，动态生成 Jest/Node原生 等 TDD 测试用例，并在隔离沙盒中运行。
- **🛡️ Auditor (安全审计员)**：在代码落盘前的最后一环，执行极其严苛的语义级安全审查。

### 2. 🔪 语义级微创手术刀 (Semantic Patch Engine)
放弃脆弱且边缘情况繁多的 AST (抽象语法树) 静态解析。DevAgent 进化出基于 LLM 直觉的 **Search and Replace Block** 引擎。无论代码是何种语言、包含何种神仙语法，AI 都能精准定位错误片段并进行微创替换，绝不破坏现有文件结构。

### 3. 👁️ 全仓雷达与外网神经 (Agentic Search & Web Surfing)
- **IDE 级全仓漫游**：打破单文件上下文盲区。大模型可自主调用 `list_dir`, `search_code`, `read_file` 等动作，像人类一样在项目中“翻箱倒柜”寻找函数定义。
- **外网知识库直连**：原生集成 `Jina Reader`。遇到未知的第三方库？AI 会自动调用 `browse_web` 联网爬取最新的官方文档（Markdown 格式），转化为自身认知后再写代码。

### 4. 🛡️ 零信任防御与物理沙盒 (Zero-Trust DevSecOps)
把物理机权限交给 AI 是极其危险的。我们构筑了独创的**四层防御纵深**：
1. **硬规则铁幕 (Hard Rules)**：底层正则秒杀 `rm -rf`, `DROP TABLE` 等系统级毁灭指令。
2. **LLM 语义审计 (Semantic Auditor)**：拦截恶意逻辑注入（如窃取 `~/.ssh` 私钥、静默执行恶意 Shell 脚本）。
3. **10秒防挂死引信 (Fail-Fast Timeout)**：在执行沙盒测试时，若检测到死循环或交互式 CLI 阻塞，10秒内瞬间强杀进程，并截取案发现场（Stdout）逼迫 AI 重新推理。
4. **Git 物理级时光机 (Deterministic Rollback)**：执行任何任务前隐式打快照。一旦触发安全熔断或多次修复失败，瞬间执行 `git reset --hard`，绝不留下代码垃圾。

---

## 🔄 核心工作流演示 (How it works)

```text
[Human] "帮我写一个并发限制器，并补齐边界单测"
   │
   ▼
[Snapshot] 隐式 Git 快照打底 
   │
   ▼
[Supervisor] 调用 search_code / read_file 分析现有 Utils 目录
   │
   ▼
[Executor] 动用 Patch Engine 编写 ConcurrentLimiter.js
   │
   ▼
[Auditor] 🚨 审查代码，确认无恶意系统调用，绿灯放行落盘
   │
   ▼
[Tester] 根据代码生成 ConcurrentLimiter.test.js，启动隔离沙盒执行测试
   │
   ├──▶ ❌ 测试失败/超时：截取 Stdout 报错日志 ──▶ [Supervisor] 开启认知推理，自我修正 (Loop)
   │
   ▼
[Success] ✅ 100% 测试覆盖通过，大闭环结束！