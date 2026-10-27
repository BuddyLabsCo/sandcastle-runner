[English](README.md) | 简体中文

# Sandcastle Runner

Sandcastle Runner 是一个本地 CLI，用代码管理交付 GitHub ticket 的例行步骤。它会选择符合条件的 ticket、准备隔离的 worktree、验证并推送 commit、发布 pull request、等待 CI，并协调合并与 ticket 关闭。

这样可以让 AI Agent 专注于编写、审查和修复代码，同时减少工作流协调带来的不必要 token 消耗。当任务需要代码改动或审查时，Runner 通过 Sandcastle 调用 Agent。

Runner 可在 Windows、macOS 和 Linux 上运行，支持 `codex`、`claude-code`、`pi` 和 `codebuddy`。Agent 通过 Sandcastle 在本地运行。

工作流细节见 [Project 指南](projects/README.zh-CN.md)。

## 前置要求

在运行 Runner 的主机上安装：

- Node.js 22.18.0 或更新版本，包括其自带的 npm。
- Git，`git` 位于 `PATH` 上；Runner 需要 worktree 支持。
- GitHub CLI（`gh`），`gh` 位于 `PATH` 上。
- 为每个已配置的 Agent 安装并完成认证的编码 Agent CLI，可直接从 `PATH` 运行。
- 原生 Agent 权限设置允许所需操作，无需交互式 CLI 批准提示。
- 位于绝对路径的 GitHub 仓库检出。

为每个选定的 Agent 准备其自身的登录、skills、MCP servers 和原生配置。Runner 不会安装或规范化这些内容。

在启动 Runner 之前完成认证和权限设置。Operator Pause 会在 Agent Attempt 停止后接受恢复指令。超时暂停会保持原始调用存活。对话文本无法应答原生批准请求，也无法授予被拒绝的权限。

请将 Runner 检出目录、项目检出目录、worktree、状态、日志、临时文件和 Agent 会话状态放在不含中文字符的路径上。

## 安装

Runner 是仅通过检出使用的 CLI，不发布到包注册表：

```sh
git clone https://github.com/xiakeng/sandcastle-runner.git
cd sandcastle-runner
npm ci
```

## Windows 设置

安装 Node.js、Git、`gh` 以及每个选定的 Agent CLI。安装后重新打开 PowerShell，使 `PATH` 变更生效，然后验证：

```powershell
node --version       # v22.18.0 或更新版本
npm --version
git --version
gh --version
codex --version      # 替换为你配置的 Agent CLI
```

Sandcastle 的默认会话查找会从启动 Runner 的进程读取 `HOME`。Windows 可能只提供 `USERPROFILE`，因此请在用户级别配置一次 `HOME`：

```powershell
[Environment]::SetEnvironmentVariable('HOME', $env:USERPROFILE, 'User')
$env:HOME = [Environment]::GetEnvironmentVariable('HOME', 'User')
node -p "process.env.HOME"
```

对于非标准存储位置，请改为设置显式的原生 `options.sessionStorage` 查找根目录：

```yaml
options:
  sessionStorage:
    hostSessionsDir: 'C:\work\agent-sessions\sessions'
```

Codex 和 Pi 使用 `hostSessionsDir`；Claude Code 使用 `hostProjectsDir`。这些选项决定会话的查找位置，不会迁移 Agent 存储。

设置 `config.yaml` 中由 `tracker.tokenEnv` 和 `codeHost.tokenEnv` 指定的凭据变量；模板使用 `GH_TOKEN`。与 `HOME` 一样，请在用户级别配置一次：

```powershell
[Environment]::SetEnvironmentVariable('GH_TOKEN', 'your-github-token', 'User')
$env:GH_TOKEN = [Environment]::GetEnvironmentVariable('GH_TOKEN', 'User')
node -p "Boolean(process.env.GH_TOKEN)"
```

## macOS 与 Linux 设置

安装 Node.js、Git、`gh` 以及每个选定的 Agent CLI，然后在将运行 Runner 的 shell 中验证以下命令：

```sh
node --version       # v22.18.0 或更新版本
npm --version
git --version
gh --version
codex --version      # 替换为你配置的 Agent CLI
export GH_TOKEN='your-github-token'
```

视情况使用 shell 配置文件或其他本地密钥机制。切勿提交 token。

## 配置

在 `projects/` 下创建项目目录：

```text
projects/<project-key>/
  config.yaml
  prompts/
    implement.md
    review.md
    documentation.md
  logs/
```

从 `projects/sandcastle-runner/config.yaml` 开始，配置仓库、绝对检出路径、Target Branch、凭据变量名、超时、工作流开关和 Agent 配置。

[示例配置](projects/sandcastle-runner/config.yaml)在 YAML 注释中说明了每个字段。将仓库特定的说明写入 Project prompts；Runner 负责提供任务上下文和输出要求。

## 运行

```sh
npm exec -- sandcastle-runner run --project <project-key> --parent <issue-number>
npm exec -- sandcastle-runner run --project <project-key> --issue <issue-number>
npm exec -- sandcastle-runner run --project <project-key> --issue
npm exec -- sandcastle-runner run --project <project-key> --document
```

不带编号的 `--issue` 使用 Project 配置的 `issueList`。`--document` 运行独立的 Documentation Maintenance。

独立运行会在其 pull request 达到 CI-ready 后请求合并。对带值的 `--issue` 使用 `--no-auto-merge`，可在验证和清理后让 pull request 保持打开。

Operator Pause 会在整个 Run 中拦截新的 Agent 步骤和交付推进。已启动的调用会继续收集输出；Runner 会保留这些结果和日志，直到所有待处理的暂停都得到解决。提示一次只显示一个，每个响应仅适用于其显示的调用。Enter、恢复指令和跳过保留各自在特定上下文中的含义。`q` 或 EOF 会取消 Run 并处置其拥有的进程。其他 Run 继续独立运行。

Runner 会打印每个 Delivery Ticket 和 Maintenance Ticket 的结果、剩余未发现 ticket 的原因、保留的 worktree 以及 Audit Log 路径。`succeeded` 和 `no_work` 以成功状态退出；`incomplete`、`cancelled` 和 `failed` 则不会。

## 验证与开发

```sh
npm test                 # 完整测试套件
npm run typecheck        # TypeScript 诊断
npm run check            # 格式化、lint 和类型检查
npm run verify           # 测试以及所有检查
npm run format           # 格式化源文件
```

测试套件使用脚本化适配器和无害的本地进程。它不会调用已认证的 Agent，也不会改动远端 GitHub 仓库。

## 致谢

感谢 [Sandcastle](https://github.com/mattpocock/sandcastle) 及其贡献者提供 Runner 所依赖的 Agent 编排库。Runner 使用 Sandcastle 的原生 Agent 工厂运行编码 Agent。
