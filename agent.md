# Zaly Multi-Agent Coding Runtime 改造目标

## 1. 文档定位

本文档是本仓库二次开发的长期目标、架构边界和实施顺序。

后续改造采用“小步讨论、小步实现、小步验证”的方式推进。每个阶段开始前先确认设计，完成后运行测试并更新本文档中的进度，不把规划中的能力描述为已经实现。

## 2. 项目定位

本项目基于 `folke/zaly` 二次开发。

Zaly 已经提供较完整的 Coding Agent 基础能力：

- Agent Loop 与流式模型调用；
- 多模型 Provider 与认证；
- Tool Runtime 与 Permission；
- JSONL Session、Context、Compaction 和 Masking；
- Background Tool Task；
- Subagent 与 Swarm 基础结构；
- Plugin、Skill 和 TUI。

本项目不重复实现这些能力，而是在现有基础上，将 Zaly 从支持 Subagent 的终端 Coding Agent 增强为：

> 支持安全并行、作用域隔离、持久化运行、结构化取消和代码交付验证的 Multi-Agent Coding Runtime。

产品形态与 Pi、OpenCode 等终端 Coding Agent 属于同一类别，但本项目的核心个人贡献集中在 Multi-Agent 执行层，而不是重新实现模型接入、基础工具或终端界面。

## 3. 核心问题

本次改造重点解决：

1. 多个可写 Agent 共享同一工作目录，可能互相覆盖代码或污染 Git 状态；
2. Child Agent 直接继承 Parent 的权限对象，缺乏独立且只能收缩的权限边界；
3. 当前 `Swarm`、`Tasks` 和 `Subagent` 尚未形成统一、清晰的执行模型；
4. 当前后台任务主要存在于进程内，缺少持久化 Run 状态和崩溃恢复语义；
5. Agent、Run、Tool Task、Process 和 Workspace 缺少统一的 ownership 与取消链；
6. 隔离 Workspace 中产生的代码缺少标准 Artifact、验证和受控合并流程；
7. 用户暂时无法直观查看多 Agent 任务进度、产物、冲突和恢复选项。

## 4. 核心概念

### 4.1 Session

长期会话身份和对话历史，负责 Conversation、Resume、Compaction 和用户交互状态。

Session 不等于 Run，也不等于当前进程中的 Agent 实例。

### 4.2 Project Task

用户希望完成的一项工作，例如分析认证模块、修改登录逻辑或补充测试。

Project Task 描述“做什么”，可以包含依赖关系，但本身不执行工具。

### 4.3 Tool Task

当前代码中的 `Tasks` 实际负责长时间运行的 Tool 调用、`Streamable`、poll、heartbeat 和 abort。

它与 Project Task 是不同概念。改造时应将现有 `Tasks` 逐步明确为 `ToolTaskRegistry`，避免与任务看板混用。

### 4.4 Run

Project Task 的一次具体执行实例。一次失败后的重试会产生新的 Run。

Run 负责：

- 生命周期与状态持久化；
- Task、AgentActivation 和 Workspace 的绑定；
- cancellation、result 和 error；
- Artifact 与验证结果；
- 崩溃后的 interrupted 检测和恢复入口。

### 4.5 AgentDefinition 与 AgentActivation

`AgentDefinition` 表示可复用的角色定义，例如 researcher、coder 或 reviewer，包括提示词、模型和权限要求。

`AgentActivation` 表示一次 Run 中实际存在的 Agent 实例。默认关系为：

```text
Run 1 ── 1 AgentActivation
```

同一个逻辑角色可以参与多个 Run，但不同 Run 默认不复用带有会话状态和 Workspace 状态的 Agent 实例。

### 4.6 AgentScope

AgentScope 是一次 AgentActivation 的运行边界，至少包含：

```text
Capability Boundary
+ Permission Boundary
+ Workspace Boundary
+ Resource Ownership
+ Lifecycle Boundary
```

Tool 通过 `ToolContext.scope` 获取当前边界，不依赖模型显式传入 `sessionId`、`agentId` 或 `workspacePath`。

### 4.7 Workspace

Run 使用的文件系统工作区：

- 只读 Run 可以共享父 Workspace；
- 可写 Run 默认使用独立 Git Worktree；
- 非 Git 目录、dirty working tree、untracked 文件和嵌套仓库必须有明确策略；
- Worktree 在 Artifact 安全落盘前不得自动删除。

### 4.8 Artifact

Run 的标准化交付结果。代码类 Artifact 最小包含：

```ts
interface CodeArtifact {
  runId: string
  baseCommit: string
  headCommit?: string
  patch: string
  filesChanged: string[]
  validation?: ValidationSummary
}
```

Artifact 经过冲突检查和验证后，才能进入用户或 Parent Agent 审查以及受控合并。

## 5. 目标架构

```text
Main Session
    │
Main Agent
    │
RunCoordinator
    │
Project Task Graph
    │
Run ── RunStore
    │
AgentActivation
    │
AgentScope
    ├── Derived Permission
    ├── Workspace
    ├── ResourceBag
    └── AbortSignal
    │
Tool Runtime
    │
ToolTaskRegistry
    │
Process / File IO / External Resource
    │
Artifact
    │
Validation
    │
User or Parent Review
    │
Controlled Merge
```

## 6. 必须保持的不变量

### 6.1 权限单调收缩

```text
Child Authority <= Parent Authority
```

权限派生不能只对规则数组做简单集合交集。当前权限包含有序规则、路径模式以及 `allow / ask / deny` 语义，因此应提供类似下面的受控派生接口：

```ts
parentPermissions.derive({
  tools,
  workspace,
  rules,
})
```

必须保证：

- Parent 的 `deny` 不能被 Child 覆盖；
- Parent 的 `ask` 不能在 Child 中升级为无条件 `allow`；
- Child 不能修改 Parent 的 PermissionManager；
- Tool 可见性与 Tool 实际执行权限同时受约束；
- Workspace 路径必须经过可信边界校验。

### 6.2 Workspace 隔离

可写并行 Run 默认使用不同 Worktree。一个 Run 失败、取消或产生部分修改时，不能污染其他 Run 和 Parent Workspace。

Worktree 只隔离文件和 Git 状态，不自动隔离端口、数据库、缓存和其他外部资源；这些资源需要通过 Scope、环境变量或测试配置另行隔离。

### 6.3 明确的资源所有权

谁创建资源，谁负责释放。只有被当前 Scope 独占创建的资源才能归入其 ResourceBag，不能错误关闭由 Session、Parent 或其他 Run 共享的资源。

### 6.4 不静默重放副作用

进程崩溃后，原先处于 `running` 的 Run 应识别为 `interrupted`。系统不得自动假设失败，也不得静默重新执行可能已经产生外部副作用的工具调用。

### 6.5 显式代码交付

Child Agent 的工作目录不能直接视为最终结果。代码必须转化为 Artifact，并经过检查、验证和确认后才能合并。

## 7. 稳妥实施顺序

### Stage 0：基础契约和兼容接入

目标：在修改主链路前消除概念冲突，并建立不破坏旧调用方式的 Scope 接入点。

- [x] 定义 Project Task、Tool Task、Run 和 AgentActivation；
- [x] 定义 Run 状态机和合法状态转换；
- [x] 定义 AgentScope、WorkspaceRef、CodeArtifact 和 ResourceBag 的最小接口；
- [x] 将可选 `scope` 接入 AgentOptions 和 ToolContext；未传入时自动建立兼容旧行为的 shared/write Scope；
- [x] 定义 V1 Workspace 与 Artifact 的生命周期；
- [x] 明确 Git dirty state、非 Git Workspace 和失败保留策略；
- [x] 为关键设计决策记录简短 ADR。

验收：核心类型和状态图经过讨论确认；类型检查、Scope 单测和现有 Agent/Subagent/Swarm 回归测试通过，不改变现有单 Agent 行为。

### Stage 1：安全隔离闭环

目标：多个可写 Agent 可以安全并行修改同一 Git Repository，并可靠交付各自 Diff。

- [x] 实现最小 `AgentScope`；
- [ ] 将 AgentScope 与权限派生、Workspace 分配和 Child 创建策略完整绑定；
- [ ] 为 `PermissionManager` 增加只收缩的派生能力；
- [x] 将 `scope` 注入 `ToolContext`；
- [x] 实现仅接受 clean Git repository 的 V1 `WorkspaceManager`；
- [x] 实现从 isolated Worktree 采集最小 `CodeArtifact`（尚未接入 Run 完成和持久化）；
- [x] 为 `subagent(workspace: "worktree")` 分配独立 Worktree，并在完成时返回 Artifact 摘要；
- [x] 未显式请求 Worktree 的 Child 保持 shared Workspace 的兼容行为；
- [x] 将 Artifact 注册到 Parent Agent 的进程内 registry，供后续 inspect / RunStore 接入；
- [ ] 将 Workspace 策略扩展到 Swarm / RunCoordinator，并实现真正 read-only Tool 权限；
- [ ] 覆盖权限升级、路径逃逸、并行写入、失败隔离和清理测试。

验收：两个 Child 可以同时修改代码，Git 状态互不影响，Parent 能分别获得两份基于明确 `baseCommit` 的 Diff。

### Stage 2：统一执行模型

目标：形成 Project Task → Run → AgentActivation 的可持久化执行链路。

- [ ] 将现有 `Tasks` 的职责明确为 `ToolTaskRegistry`；
- [ ] 实现 Project Task Graph 和依赖唤醒；
- [ ] 实现 `RunCoordinator`；
- [ ] 将 Swarm Agent identity/communication 与 Run 绑定；
- [ ] 实现 `RunStore`；
- [ ] 持久化状态转换、错误、取消原因和 Workspace/Artifact 引用；
- [ ] 启动时识别 orphaned `running` Run 并标记为 `interrupted`；
- [ ] 提供 inspect、resume、cancel 的基础入口。

验收：同一 Task 可以产生多个 Run；依赖任务能正确阻塞和唤醒；进程重启后能发现 interrupted Run，并保留 Session、Workspace 和 Artifact。

说明：本阶段首先实现的是 Durable Run State 和 crash recovery。只有引入独立 worker/daemon、lease 和 heartbeat 后，才能称为进程退出后仍持续执行的 Durable Execution。

### Stage 3：安全交付和生命周期闭环

目标：Run 从启动、执行、取消到代码合并都具有可验证的生命周期。

- [ ] 将 Run cancellation 传播到 Child Run、Agent、Tool Task 和 Process；
- [x] 实现最小且幂等的 `ResourceBag.dispose()`；
- [ ] 将 ResourceBag 接入完整 Parent/Child Run 资源树；
- [ ] 实现 Artifact base commit 与冲突检查；
- [ ] 在临时验证 Workspace 中运行 test、lint 和 typecheck；
- [ ] 保存结构化 Validation Result；
- [ ] 默认要求用户或 Parent Agent 审查；
- [ ] 实现受控 merge、失败回滚和现场保留策略。

验收：取消 Parent Run 能终止其子树中的运行资源；只有通过约定验证的 Artifact 才能进入合并流程；冲突和验证失败不会污染 Parent Workspace。

### Stage 4：后台化、可观测和产品封装

目标：让 Runtime 可以被普通用户稳定理解和使用。

- [ ] 根据需求引入 worker/daemon、activation lease 和 heartbeat；
- [ ] 增加最小 Runtime Event Journal；
- [ ] 建立 `session_id → task_id → run_id → agent_id → tool_call_id` 追踪关系；
- [ ] 在 TUI 展示任务树、Agent 状态、Diff、验证结果和冲突；
- [ ] 提供暂停、取消、重试、恢复、接受和拒绝入口；
- [ ] 完善错误信息、配置迁移、安装升级和跨平台验证；
- [ ] 根据真实需求再考虑 HTTP API、IDE 或 Web 客户端。

验收：用户可以从一个复杂需求开始，观察多个 Agent 并行执行，查看和验证各自 Artifact，在异常后恢复或取消，并明确决定哪些修改进入当前工作区。

## 8. 第一条端到端产品路径

第一版优先打通以下闭环：

```text
用户输入复杂需求
→ Main Agent 拆分 Project Task
→ RunCoordinator 创建多个 Run
→ writable Agent 获得独立 Scope 和 Worktree
→ 多个 Agent 并行执行
→ 每个 Run 生成 Artifact 与测试结果
→ 系统检查 base commit 和冲突
→ 用户逐项审查
→ 受控合并
→ 全过程可取消、可恢复、可追踪
```

建议用以下场景作为持续验收 Demo：

```text
“重构认证模块，同时补充测试并审查安全问题。”

Task A：分析认证架构，read-only Workspace
Task B：修改认证代码，isolated Worktree
Task C：补充测试，isolated Worktree
Task D：审查安全问题，read-only Workspace 或基于候选 Artifact 验证
```

## 9. 兼容性要求

所有改造必须满足：

1. 原单 Agent 模式继续正常运行；
2. 原 read-only Subagent 行为尽量保持兼容；
3. 原 JSONL Session 可以继续读取；
4. Plugin API 优先通过增加可选字段演进，避免不必要破坏；
5. Permission 默认行为保持兼容；
6. 不强制所有 Agent 创建 Worktree；
7. 不改变 Provider abstraction；
8. 不重写现有 TUI、Context Compaction 和模型内容转换；
9. 每个阶段都必须有针对新增不变量的自动化测试；
10. 未完成的能力在 README、演示和面试表述中必须明确标记为规划或进行中。

## 10. 非目标

当前路线不优先处理：

- 增加更多 LLM Provider；
- 增加 Web Search、Memory 或更多 Skills；
- 重写 TUI；
- 复制 OpenCode 的全部桌面端、IDE 和插件生态；
- 在执行内核稳定前建设大型 Web 管理平台；
- 在 RunStore 语义稳定前引入完整事件溯源架构。

## 11. 重点源码入口

开始修改前优先阅读：

1. `packages/agent/src/agent.ts`：Agent 生命周期、`child()`、ToolContext 和取消；
2. `packages/agent/src/ctx.ts`：AgentContext 与 Permission、Swarm 的装配；
3. `packages/agent/src/tools/subagent.ts`：一次性 Subagent 执行；
4. `packages/agent/src/swarm.ts` 与 `packages/agent/src/tools/swarm.ts`：Agent 拓扑、通信和长期运行；
5. `packages/agent/src/tasks.ts`：现有后台 Tool Task；
6. `packages/agent/src/permissions/`：有序权限规则和 Workspace 判断；
7. `packages/agent/src/tools/bash.ts` 与 `packages/shared/src/process/`：进程及 AbortSignal；
8. `packages/agent/src/session/`：Session 与 JSONL 持久化；
9. `packages/cli/src/app/` 与 `packages/cli/src/widgets/`：后续产品交互入口。

## 12. 当前进度

- [x] 完成现有仓库结构与关键模块的初步梳理；
- [x] 完成总体改造方向评审；
- [x] 将实施顺序收敛为 Stage 0 → Stage 4；
- [x] 开始 Stage 0：完成 Runtime 基础类型、Run 状态机和兼容型 AgentScope 接入；
- [x] 实现最小 ResourceBag，并将 Scope 注入 Agent 驱动的 ToolContext；
- [ ] 完成 Workspace/Artifact 生命周期策略和关键 ADR；
- [x] 开始代码实现。

## 13. 项目完成后的推荐表述

只有在 Stage 1 至 Stage 3 的端到端闭环通过验收后，才使用以下表述：

> 本项目基于 Zaly 构建 Multi-Agent Coding Runtime，在原有 Coding Agent Loop、Tool Runtime 和 Session 基础上，实现 Agent 权限作用域、Git Worktree 并行隔离、Task/Run/Agent 分层、持久化运行状态、结构化取消，以及代码 Artifact 的验证与受控合并。

在此之前，应根据实际完成阶段使用“设计中”“核心原型”或“主要执行内核已完成”等准确描述。
