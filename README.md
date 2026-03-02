# 🚀 DevAgent (MVP)

> **"不相信任何一行由 AI 自动生成的代码，直到它在赛博监狱里证明了自己。"**
>
> 你的下一代全自动本地代码架构师。基于图状态机编排的 AI 结对编程引擎，具备 TDD 测试驱动、语义级代码手术、全仓 RAG 感知与极强防御纵深。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Required-blue)]()
[![Status](https://img.shields.io/badge/Status-MVP_Stable-success)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)]()

[English Documentation](./README_EN.md) | **中文文档**

---

## 💡 重新定义 AI 编程 (The Vision)

目前的 AI 辅助编程大多停留在「代码补全 (Copilot)」或「单文件对话 (Chat)」。

**DevAgent 的目标是接管软件工程的全局生命周期 (SDLC)。** 它采用独特的 **带状态回滚的监督者-执行者架构 (Supervisor-Actor Architecture with Deterministic Rollbacks)**。

你只需输入一句自然语言需求，DevAgent 将自动组建跨职能虚拟团队，完成：**需求拆解 → 全仓检索 → 代码编写 → 安全审计 → TDD 自动测试 → 报错推理与自我修复** 的完整闭环。它不仅会写代码，更懂得在搞砸时自动执行物理回滚。

---

## ✨ 核心架构与特性 (The 4 Pillars)

### 1. 🧠 多智能体协同状态机 (Multi-Agent State Machine)

底层告别死板的线性脚本，采用高度定制化的图状态机，包含多个独立运作的 Agent 节点：

- **👑 Supervisor (监督者/主程)**：全场调度核心，负责理解上下文、规划任务流、分发动作。
- **🛠️ Executor (执行者)**：极其精准的代码刀客，负责执行具体的重构或文件读写，支持级联目录自动生成。
- **🧪 Tester (QA 测试专员)**：基于新业务代码，动态生成 Jest/Node 原生等 TDD 测试用例。
- **🛡️ Auditor (安全审计员)**：在代码落盘前的最后一环，执行极其严苛的语义级安全审查。

### 2. 🔪 语义级微创手术刀 (Semantic Patch Engine)

放弃脆弱且边缘情况繁多的 AST 静态解析。DevAgent 进化出基于 LLM 直觉的 **Search and Replace Block** 引擎。无论代码是何种语言，AI 都能精准定位错误片段并进行微创替换，告别全量重写代码的愚蠢。

### 3. 👁️ 全仓雷达与跨周期记忆 (Agentic Search & Memory)

- **IDE 级全仓漫游**：大模型可自主调用 `list_dir`、`search_code`、`read_file` 等动作，打破单文件盲区。
- **外网知识库直连**：原生集成 RAG 与外网爬取能力。遇到未知的第三方库？AI 会自动查阅最新官方文档后再写代码。
- **长周期记忆库 (SQLite Memory)**：记录每次项目踩坑的「黑名单」，在未来的开发中永久规避，防止陷入「分析瘫痪（Analysis Paralysis）」。

### 4. 🛡️ 零信任防御与物理沙盒 (Zero-Trust DevSecOps)

把物理机权限交给 AI 是极其危险的。我们构筑了独创的 **四层防御纵深**：

1. **硬规则铁幕 (Hard Rules)**：底层正则秒杀系统级毁灭指令。
2. **LLM 语义审计 (Semantic Auditor)**：拦截恶意逻辑注入与高危进程逃逸调用。
3. **Docker 物理沙盒 (Cyber Prison)**：所有测试代码被关入限制 CPU (1.0) 和内存 (512m) 的 node:24-alpine 容器中执行，配合 10 秒防挂死引信，防死循环炸机。
4. **Git 物理级时光机 (Deterministic Rollback)**：执行任何任务前隐式打快照。一旦触发安全熔断或多次修复失败（Reward Hacking），瞬间执行 `git reset --hard`，确保项目绝对纯洁。

---

## 🔄 核心工作流演示 (How it works)

```text
Human "帮我写一个并发限制器，并补齐边界单测"
 │
 ▼
Snapshot 隐式 Git 快照打底
 │
 ▼
Supervisor 调用 search_code / read_file 分析现有 Utils 目录
 │
 ▼
Executor 动用 Patch Engine 编写 ConcurrentLimiter.js
 │
 ▼
Auditor 🚨 审查代码，确认无恶意系统调用，绿灯放行落盘
 │
 ▼
Tester 根据代码生成单测，启动 Docker 隔离沙盒执行验证
 │
 ├──▶ ❌ 测试失败/超时：截取 Stdout 报错日志 ──▶ Supervisor 开启认知推理，自我修正 (Loop)
 │
 ▼
Success ✅ 100% 测试覆盖通过，大闭环结束！
```

---

## 📦 极速安装与使用 (Getting Started)

### 环境依赖

1. **Node.js**：≥ v22.0.0（必须开启 ES Module 支持）
2. **Docker Desktop**：运行状态（提供隔离沙盒）
3. **Git**：目标业务项目必须已初始化 Git 仓库（`git init`）

### 安装指引

```bash
# 1. 克隆本项目
git clone https://github.com/your-username/devagent-mvp.git
cd devagent-mvp

# 2. 安装依赖并编译原生模块（如 SQLite）
npm install
npm rebuild

# 3. 注入全局命令（拔剑出鞘）
npm link
```

### 实战用法

在任何 **已经初始化过 Git 的业务空项目** 中，配置大模型 API Key，然后召唤智能体：

```bash
export DASHSCOPE_API_KEY="你的通义千问API_KEY"

# 启动交互式主程序
devagent
```

**实战 Prompt 示例：**

*「帮我搭建一个基础的 Express Web 服务。要求：1. 入口文件在 src/app.js。2. 包含一个 '/api/health' 的 GET 接口，返回包含 uptime 和 status 的 JSON。3. 帮我写一个严谨的单测来测试这个健康检查接口。」*

---

## 🗺️ 演进路线图 (Roadmap)

DevAgent 目前处于功能极其强悍的 MVP 阶段。在通往真正的企业级 DevOps 平台之路上，我们正在积极推进：

- [x] **Docker 安全沙盒隔离 (Sandboxing)**：将所有的测试验证放入临时 Docker 容器中执行。
- [x] **跨周期持久化记忆 (Memory DB)**：引入 SQLite，实现状态跨越与防多动症约束。
- [ ] **DevOps 部署专家 Agent**：赋予 AI 读取 .env、检查云端端口占用、甚至接入 CI/CD 流水线的能力。
- [ ] **全局 AST 重构引擎 (Upgrade & Refactor)**：集成 ast-grep，通过一行命令让 AI 自动完成框架级安全重构。

---

## 🤝 参与共建 (Contributing)

AGI 改变软件工程的浪潮才刚刚开始。欢迎提交 Issue 探讨更疯狂的 Agent 架构，或者提交 PR 为 DevAgent 的武器库添加更多的 Tools（如数据库只读权限、云端排错探针等）。

---

## 📄 免责声明与协议

**MIT License**。大模型的智能涌现往往伴随着不可预知的捷径思维。尽管我们做到了最极致的沙盒隔离与 Git 回滚，但 **请勿在未提交未备份的珍贵生产环境代码中直接运行未知指令**。

---

*Built with passion, coffee, and hardcore debugging by jingbo@山与景 & AI Architect.*
