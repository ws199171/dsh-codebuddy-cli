---
description: "委托式 CLI LLM 适配器：每次模型调用都交给 CodeBuddy CLI 子进程完成，CLI 自带登录态与智能体循环。"
---

# `dsh-codebuddy-llm`

[English](README.md) | 中文

> **非官方插件。** 与 CodeBuddy、DeepSeek 均无隶属、无赞助、无背书关系。它驱动的是你自己安装并登录的 CLI，因此使用方式、所消耗的配额以及是否遵守该 CLI 的条款，都由你自行负责。部署前请阅读[免责声明](#免责声明)。

## 概览

一个**单文件**（`index.js`，自包含 ESM 产物）的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。它注册一条 LLM 路由 `codebuddy-cli`，回答来自 CodeBuddy CLI 子进程而不是提供方端点：CLI 自带认证、自带智能体循环和自己的工具集，因此 harness 只转发对话文本、取回最终答案——不需要 API key、不需要端点，也不会有 harness 的工具词汇上线。

本包是 harness 仓库中 `@deepseek-ai/dsh-llm-cli` 的独立抽取版本。它不修改 CodeBuddy 的任何部分：只调用你已安装并已登录的 CLI。

## 免责声明

这是一个非官方的第三方插件，除作者之外没有任何一方为它背书。

- **风险自负。** 本软件按 [LICENSE](LICENSE) 中的约定「按原样」提供，不附带任何形式的担保。因使用本插件导致的数据丢失或泄露、意外费用、配额耗尽、账号被限制或封禁、违反政策，以及其他任何损失，作者不承担责任。
- **你接受的那份条款由你自己负责。** 本插件调用的是你安装并登录的 CLI。是否允许自动化/非交互式调用、个人席位与企业或商业席位分别可用于什么、能否用于团队或产品级部署，这些都由 CodeBuddy 的许可协议和你账号的约定决定，而不是由本插件决定。在超出自己一台机器的范围前请先确认。
- **本包不修改 CodeBuddy。** 插件只启动可执行文件并读取其 stdout，不打补丁、不反编译、不做插桩、不代理、不再分发。它对 CLI 参数以及两个私有 `_meta` 键的依赖属于尽力而为，任何一次 CLI 发版都可能失效。
- **你的对话会离开 harness。** 你发送的文本会成为 CLI 的提示词，并到达该 CLI 所配置的提供方；harness 侧的路由、沙箱与隐私预期并不延伸到这条链路上。
- **费用由你的账号承担。** 每次模型调用都消耗本机已登录 CLI 账号的配额；harness 中会自行调用模型的功能（会话标题、上下文压缩、子智能体）会放大调用次数。
- **默认配置会授予 OS 权限。** `permissionMode: bypassPermissions` 让 CLI 自己的工具以启动它的那个进程的权限行事，且不再询问。在把插件指向你并不信任的代码之前，请先调窄该设置。
- **没有支持承诺。** 作者不保证一定回应问题、一定修复缺陷，也不保证兼容未来的 harness 或 CLI 版本。

## 运行要求

- DeepSeek Harness `^0.2.1-rc.3`（以 `engines.dsh` 声明，宿主版本不符时插件拒绝装载）
- Node.js `>=24.9`
- `PATH` 上有 `codebuddy` 命令并已登录（或用 `command` 指向绝对路径）

## 使用提示

- **先用 CLI 自证，再装插件。** 直接跑 `codebuddy --print --output-format stream-json "hello"`，应能看到一行一个事件的 JSON。若插件挂上了却答不出内容，通常意味着 CLI 未登录、不在启动 harness 那个进程的 `PATH` 上，或不支持 `args` 里的参数。
- **`command` 尽量写绝对路径。** 从 GUI、守护进程或服务管理器启动 harness 时，继承到的 `PATH` 往往比你的 shell 小。CLI 缺失不会被静默吞掉：Models 页会以 `CodeBuddy CLI is unavailable: codebuddy is not on this process's PATH (N directories searched)` 拒绝，装载时也会打印同样的内容。
- **对不是自己写的仓库，先调窄权限。** `default`、`acceptEdits` 或 `plan` 会阻止 CLI 的工具自行行动；`bypassPermissions` 不会。
- **CLI 支持 `--acp` 时优先试 `transport: acp`。** 每条路由只起一个子进程而非每次调用一个，CLI 的思考过程会作为独立块返回，对话也能续用 CLI 侧会话；不支持 ACP 的 CLI 仍用 `print`。
- **保留 entry id `llm-cli`。** 这个 id 就是设置命名空间，改掉它会让文档里的 `llm-cli:` 配置段和已有 profile 设置失效。
- **想要接近「裸模型调用」**：设 `tools: ''`（禁用全部内置工具）并把 `maxTurns` 设为 `1`；两者都留空则交给 CLI 自己的循环。
- **盯配额，而不只是账单。** 一个 harness 回合可能自行发起多次模型调用（会话标题、上下文压缩、子智能体），每次都花掉你 CLI 账号的配额。

## 安装

作为可安装 bundle（推荐）：

```sh
dsh plugin --profile work add dsh-codebuddy-llm
```

本包声明了 `dsh.bundle.patch`，其补丁层会插入 `llm-cli` 这一行。若要让 CLI 成为唯一的模型来源，在你自己的 profile `cordis.patch.yml` 里关闭 HTTP 提供方行：

```yaml
- id: llm-deepseek
  disabled: true

- id: agent-default-model
  config:
    provider: codebuddy-cli
    model: default
```

或绕过 bundle 层，手工挂载：

```yaml
- id: llm-cli
  name: 'dsh-codebuddy-llm'
  config:
    command: codebuddy
    args: ['--print', '--output-format', 'stream-json', '--include-partial-messages']
    transport: print
```

即使 `config` 整段缺失，插件仍会以默认值注册一条可服务的路由。

## 配置

所有字段都可选且为 volatile：改设置在下一次请求即生效，无需重新注册路由。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `command` | `codebuddy` | 要启动的可执行文件，走 `PATH` 查找。 |
| `args` | `['--print', '--output-format', 'stream-json', '--include-partial-messages']` | `print` 传输的参数。空字符串条目会被拒绝，因为提示词是作为最后一个位置参数追加的。 |
| `acpArgs` | `['--acp']` | 以长驻 ACP 智能体方式启动 CLI 的参数。 |
| `transport` | `print` | `print` 每次调用起一个子进程并读取 `stream-json`；`acp` 每条路由只起一个子进程并在其上开会话。 |
| `permissionMode` | `bypassPermissions` | CLI 自己的工具审批策略，见下方警告。 |
| `models` | `[]` | 给无法询问 CLI 的部署用的建议目录，条目为 `{ id, name?, contextWindow? }`。 |
| `cwd` | 进程目录 | 固定子进程工作区；持久会话会改用会话记录的工作区。 |
| `env` | `{}` | 追加的环境变量，叠加在 subprocess 接缝清洗后的基础环境之上。 |
| `sessionIdArg` | `--session-id` | 承载持久会话 id 的参数；设为空字符串则每次调用无状态。 |
| `tools` | CLI 默认 | 限定 CLI 可用的工具集；空字符串禁用全部内置工具。 |
| `maxTurns` | CLI 默认 | 单次调用内 CLI 自己的智能体轮数上限。 |
| `effort` | CLI 默认 | 转发给 CLI 的推理强度。 |
| `turnTimeoutMs` | `600000` | 单次委托回合的时长上限；`0` 表示不限制。 |
| `disposeGraceMs` | `3000` | 结束子进程树的宽限期。 |
| `modelDiscoveryArgs` | `['--help']` | `print` 路由用来解析模型 id 的列表命令。 |
| `modelDiscoveryTimeoutMs` | `15000` | 上述列表命令的超时。 |

模型 id 来自 CLI 本身：`acp` 路由问握手（同时带回每个模型的上下文容量），`print` 路由解析列表命令。配置的目录会排在发现到的条目之后。

> **警告 — 权限。** `permissionMode` 管的是 CLI 自己的工具；harness 的权限预设、文件系统沙箱和 shell 沙箱都不介入。因此默认的 `bypassPermissions` 等于把启动 harness 那个进程的 OS 权限交给子进程。只要对话可能触碰到你不信任的代码或机器，就显式改成 `default`、`acceptEdits` 或 `plan`。

> **警告 — 数据与费用。** 你发送的内容都会转发给 CLI 并进一步到达其提供方，每次调用也会消耗该账号的配额；两者都发生在 harness 自身的计量与隐私边界之外。

## 合规与数据流向

- **不修改、不打补丁、不反编译、不再分发 CodeBuddy 的任何部分。** 插件只用其公开参数启动可执行文件并读取 stdout。
- **不处理任何凭据。** 登录态保留在子进程里；本包不读取 CLI 的 key、token 或配置文件。
- **数据通过你自己的 CLI 会话离开 harness。** 你发出的对话文本成为子进程的提示词，并到达该 CLI 所配置的提供方。harness 会话日志记录的是答案，而不是 CLI 在自己循环里做了什么。
- **每次模型调用消耗你自己 CLI 账号的配额。** harness 中自行调用模型的功能（会话标题、上下文压缩、子智能体）会放大调用次数。
- **与 CodeBuddy 官方无隶属、无背书关系。** 该名称仅用于描述本适配器所驱动的 CLI。
- 读取两个 CodeBuddy 私有的 `_meta` 键（`codebuddy.ai/parentToolCallId`、`codebuddy.ai/errorMessage`）属于尽力而为：字段缺失时 ACP 传输降级处理，而不是报错。

## 已知限制

- 只有最终答案越过边界：CLI 内部的工具步骤对 harness 会话日志不可见。
- `permissionMode` 管的是 CLI 的工具；harness 的权限预设、文件系统沙箱和 shell 沙箱都不介入。因此默认的 `bypassPermissions` 等于把桌面进程的 OS 权限交给子进程——不希望如此时请调窄。
- 只理解 CodeBuddy 形状的输出：`stream-json` 词汇和位置参数式调用都是 CodeBuddy 的约定。
- 可执行文件缺失或不可执行时，会以拒绝的形式报出所配置的命令，而不是返回空目录；路由仍会挂载，你自己在 `models` 里配置的列表也照常可用。此时模型调用同样会失败，请先修好 `command` 再依赖该路由。
- 压缩与模型切换需要上下文容量：要么 CLI 报出该值，要么目录条目声明 `contextWindow`。

## 来源

由 DeepSeek Harness 仓库 `0.2.1-rc.3` 版本的 `packages/llm/llm-cli` 生成。`index.js` 是 harness 的构建产物，并把 `@deepseek-ai/dsh-timeout` 常量内联；它保留两个运行时导入：`@deepseek-ai/dsh-llm`（由运行中的 harness 提供，作为 peer）与 `@deepseek-ai/schemastery`。

## 许可证

MIT，见 [LICENSE](LICENSE)。
