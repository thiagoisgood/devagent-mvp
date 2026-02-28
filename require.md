<!--
 * @Author: Thiago
 * @Date: 2026-02-28 17:10:48
 * @LastEditors: Thiago
 * @LastEditTime: 2026-02-28 17:10:51
 * @FilePath: /devagent-mvp/require.md
 * @Description:
-->

# 🚀 DevAgent: 企业级全生命周期自主研发工作流智能体架构蓝图

## 📑 1. 产品定位与核心理念

DevAgent 是一个基于命令行的**全自动研发工作流管家 (Autonomous SWE Agent)**。
它颠覆了传统开发中“人工串联各个孤立工具”的模式，采用 **“带状态回滚的监督者-执行者架构 (Supervisor-Actor Architecture with Deterministic Rollbacks)”**，充当项目中的虚拟研发总监 (Engineering Manager) 和 DevOps 专家。

**核心目标**：覆盖从需求拆解、辅助编码审查、自动化测试、安全部署到平滑升级的**软件全生命周期 (SDLC)**，让人类开发者专注业务逻辑创造，将所有繁琐的流程流转交给 AI 闭环处理。

---

## 🏗️ 2. 系统整体架构 (四大核心层)

### 🌐 2.1 交互与感知层 (Interaction & Perception Layer)

- **全生命周期 CLI 入口**：支持多场景指令（如 `devagent plan "新需求"`, `devagent review`, `devagent deploy`）。
- **IDE 终端完美闭环**：终端输出可点击文件路径（如 `src/app.js:45`），与本地编辑器无缝联动。
- **双模大脑智能路由**：底层基于网络环境动态分发请求至 **Google Gemini**（海外链路，擅长长文本架构推演）或 **通义千问 Qwen**（国内链路，低延迟执行）。
- **全域上下文探测**：不仅拦截报错日志，还能读取 Git 提交树、CI/CD 状态配置文件（如 `.github/workflows`）、云服务器状态等。

### 🤖 2.2 多智能体协同引擎 (Multi-Agent Core)

系统内部由五个专属 Agent 组成跨职能虚拟团队：

1. **👑 监督者/观察者 (The Supervisor)**：全场调度核心。把控开发规范，主持复盘会议，在关键阶段（如合入主分支、发布生产环境）挂起流程请求人类授权。
2. **🧠 架构与规划者 (The Architect Planner)**：在**开发前**，将人类的一句话需求拆解为技术任务清单 (Task Breakdown)，规划文件目录结构，并为人类使用的 IDE 补全工具（如 Copilot）生成高质量的全局 Context 提示词。
3. **🛠️ 执行者 (The Executor)**：负责具体的自动化修改。运用 AST (抽象语法树) 确保全局参数修改、接口重构的 100% 精确，绝不使用危险的正则替换。
4. **🧪 测试与审查者 (The Tester / Critic)**：不仅在报错时介入，还在**代码提交前**，根据代码变更（Git Diff）自动生成单元测试（TDD 模式），并执行全量回归测试。
5. **🚀 部署与运维专家 (The DevOps Agent)**：负责检查环境变量、打包镜像、执行数据库迁移脚本 (Migrations)，并监控部署后的存活状态。

### 🛡️ 2.3 安全与防御网关 (Security & Defense Gateway)

采用“纵深防御”策略，不仅防删库，更防“生产事故”。

- **第一层：确定性铁幕 (Hard Rules)**：拦截 `rm -rf /` 等系统级毁灭指令；拦截无备份的数据库 `DROP/TRUNCATE` 操作。
- **第二层：语义级审计员 (LLM Auditor)**：拦截逻辑缺陷（如死锁风险、并发事务未加锁）；**拦截危险部署**（如：发现在周五晚高峰尝试发布涉及核心交易链路的大版本，立刻阻断并报警）。

### 🧠 2.4 记忆与状态管理机制 (State & Memory Management)

- **阶段性快照 (Checkpoints)**：每个 SDLC 阶段（开发完成、测试通过、部署前）自动打 Tag 快照。
- **回滚与认知重置**：AI 尝试修复或部署失败超阈值时，自动 `git reset` 或触发 CI 回滚，清空污染上下文。
- **跨周期黑名单池**：记录历史踩坑记录（如“组件 A 与 依赖 B 存在内存泄漏冲突”），在未来的升级和开发中永久规避。

---

## 🔄 3. 全生命周期标准工作流 (The SDLC Workflow)

DevAgent 将研发流程划分为五个标准化阶段：

### 阶段一：开发与规划 (Plan & Develop)

1. **需求消化**：开发者输入 `devagent plan "增加企业微信扫码登录功能"`。
2. **架构拆解**：Architect Agent 梳理现有 Auth 模块，生成任务清单，并初始化必要的文件结构 (Scaffolding)。
3. **协同编码**：人类开发者使用外部 AI 编程工具完成业务逻辑编写。
4. **规范卡点**：执行 `devagent review`，系统根据公司配置的 `.eslintrc` 和规范白皮书进行代码质量与安全审查。

### 阶段二：测试与验证 (Test & Verify)

1. **动态用例生成**：Tester Agent 扫描最近的 Git Diff，自动为新写的“企微登录”接口生成覆盖边界条件的 Jest/Pytest 测试用例。
2. **闭环博弈**：如果测试未通过，Executor Agent 与 Tester Agent 在沙盒中自动进行“修改->测试”的多次博弈，直到 100% 绿灯（期间如果陷入死循环，由 Supervisor 触发回滚并呼叫人类）。

### 阶段三：安全部署 (Deploy & Release)

1. **环境预检**：DevOps Agent 检查 `.env` 文件是否齐全、云端端口是否被占用、数据库迁移脚本（SQL）是否有高危操作。
2. **触发流水线**：接管本地 Docker Build 或调用 Jenkins/GitLab CI API 执行打包发布。
3. **人类最终授权**：在流量切换到新版本前，Supervisor 弹出交接报告，人类点击 [Confirm] 放行。

### 阶段四：监控与运维 (Ops & Diagnose)

1. **探针巡检**：Tool-Maker Agent 动态生成脚本，监控生产环境日志流和 CPU/Memory 水位。
2. **智能诊断**：当捕获到系统异常退出码或高频 Error 时，触发我们在“排错架构”中设计的**滑动窗口截获**与**根因分析机制**。

### 阶段五：重构与平滑升级 (Upgrade & Refactor)

1. **依赖升级评估**：当团队需要将 React 17 升级到 18，或 Python 3.9 升级到 3.11 时，输入 `devagent upgrade`。
2. **AST 全局替换**：Executor Agent 利用 AST 树，安全、精准地替换所有被废弃的 API 调用，并自动解决包版本冲突 (Dependency Resolution)。
3. **回归验证**：调用全量自动化测试保障升级平滑过渡，无缝进入下一个生命周期。

---

## 🧰 4. 开源技术栈映射与落地实现 (Open-source Toolchain Mapping)

为了实现快速落地 (MVP)，系统各层将深度集成成熟的开源生态，拒绝重复造轮子：

### 4.1 交互与感知层落地

- **UI 交互**：使用 `Inquirer.js` 构建精美的终端选择菜单，结合 `Ora` 实现优雅的加载动画。
- **上下文抓取**：基于 `simple-git` 封装代码 Diff 读取；使用 `tree-cli` 生成精简版项目目录树。

### 4.2 多智能体编排引擎落地

- **状态机与 Agent 编排**：**核心采用 `LangGraph`**（或 `CrewAI`）。利用其图结构完美实现 Agent 间的流转、状态持久化、以及触发阈值后的中断与回滚机制。
- **精确重构工具 (执行者)**：集成 **`ast-grep`**。AI 仅需输出结构化替换规则模式，由 `ast-grep` 底层基于 `tree-sitter` 执行安全的、跨语言的全文 AST 替换，彻底消除正则表达式带来的误伤。

### 4.3 安全网关落地

- **确定性铁幕**：集成 **`Semgrep`**。预置高危操作拦截规则，每次执行者生成修改后先通过本地 Semgrep 静态扫描，秒级熔断危险代码。
- **安全执行沙盒**：基于 `Docker Engine API` (`dockerode`)，在隔离的轻量级容器（如 Alpine Linux）中运行探针脚本与临时测试，防止破坏宿主机环境。

### 4.4 状态回滚与持久化落地

- **物理级快照回滚**：直接复用本地的 **`Git`** 系统。修改前触发隐式 Commit/Stash，熔断时通过 `git reset --hard` 极速恢复“案发现场”。
- **全局黑名单数据库**：使用轻量级的本地 JSON 数据库（如 **`Lowdb` / `SQLite`**）存储于 `.devagent/state.db`，用于持久化记录跨周期的失败教训和黑名单，实现系统的认知成长。
