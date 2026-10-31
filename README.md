---
description: "Delegating CLI LLM adapter that answers each model call by running the CodeBuddy CLI, which carries its own sign-in and agent loop."
---

# `dsh-codebuddy-llm`

English | [中文](README.zh.md)

> **Unofficial plugin.** Not affiliated with, sponsored, or endorsed by CodeBuddy or DeepSeek. It drives a CLI you installed and signed in yourself, so its use, the quota it consumes, and compliance with that CLI's terms are your responsibility. Read the [disclaimer](#disclaimer) before deploying it.

## Summary

One [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin with a Host adapter (`index.js`) and browser renderer (`client.js`). It registers one LLM route, `codebuddy-cli`, whose answers come from a CodeBuddy CLI child process instead of a provider endpoint. The harness can call it like another model provider and receives answer text plus records of the CLI's thinking and tool calls. The CLI carries its own authentication and agent loop; no API key or provider endpoint is needed.

This package is a standalone extraction of `@deepseek-ai/dsh-llm-cli` from the harness repository. It modifies nothing about CodeBuddy: it only invokes the CLI you already have installed and signed in.

The model stream uses native `text-delta` chunks. Stateless calls also use native `reasoning-delta` chunks. Persistent sessions record each completed thinking segment as `plugin:codebuddy/thought` at its actual position among CLI tool calls, avoiding a single reasoning block anchored before every tool. CLI-owned tools produce `plugin:codebuddy/tool-call` records with stable `callId`, `toolName`, `status`, and bounded input/output. The client projects CLI calls through Harness's native Tool tree, including Bash, Read, Write, Edit, Grep, Glob, and Web views; unknown tools use its generic row. Execution steps remain available. These records are display-only; the Harness did not execute the CLI's tools.

The bundled client also shows the CLI's model catalog in the Models settings page and provides search and refresh controls. This fills the `llm-cli` provider-card extension on Harness versions whose built-in editor does not yet recognize CLI providers.

## Disclaimer

This is an unofficial, third-party plugin. Its author is the only party behind it.

- **Use at your own risk.** The software is provided "AS IS", without warranty of any kind, as stated in [LICENSE](LICENSE). The author is not liable for lost or leaked data, unexpected cost, quota exhaustion, account restriction or suspension, policy violation, or any other damage arising from its use.
- **You own the terms you accepted.** This plugin calls a CLI you installed and signed in to. Whether automated or non-interactive invocation is permitted, what a personal seat may be used for versus a commercial or enterprise one, and whether a team or product deployment is allowed are all decided by the CodeBuddy licence and your account agreement — not by this plugin. Read them before rolling it out beyond your own machine.
- **Nothing here modifies CodeBuddy.** The plugin only spawns the executable and reads its stdout; it does not patch, decompile, instrument, proxy, or redistribute it. Its reliance on CLI flags and on two private `_meta` keys is best-effort and can break at any CLI release.
- **Your conversation leaves the harness.** Text you send becomes the CLI's prompt and reaches whatever provider that CLI is configured with. Harness-side routing, sandboxing, and privacy expectations do not extend to that path.
- **Your account pays.** Every model call spends the quota of the CLI account signed in on this machine. Harness features that call the model on their own — session titles, compaction, subagents — multiply the number of calls.
- **The default grants OS access.** `permissionMode: bypassPermissions` lets the CLI's own tools act with the permissions of the process that started it, without asking. Narrow it before pointing this plugin at code you do not trust.
- **No support commitment.** There is no guarantee of an answer, of a fix, or of compatibility with any future harness or CLI version.

## Requirements

- DeepSeek Harness `>=0.2.1-rc.3 <0.3.0` (declared via `engines.dsh`).
- Node.js `>=24.9`
- The `codebuddy` CLI on `PATH`, signed in (or point `command` at its absolute path)

## Tips

- **Prove the CLI first, without the harness.** `codebuddy --print --output-format stream-json "hello"` should print one JSON line per event. A plugin that registers but answers nothing usually means the CLI is not signed in, not on the `PATH` of the process that launched the harness, or does not support the flags in `args`.
- **Prefer an absolute `command`** when the harness runs from a GUI, a daemon, or a service manager: those often inherit a smaller `PATH` than your shell. A missing CLI is reported rather than hidden — the Models page refuses with `CodeBuddy CLI is unavailable: codebuddy is not on this process's PATH (N directories searched)`, and the same text is logged at load.
- **Narrow the default permission mode** for repositories you did not write. `default`, `acceptEdits`, or `plan` keeps the CLI's tools from acting on their own; `bypassPermissions` does not.
- **Try `transport: acp`** when the CLI supports `--acp`: one child per route instead of one per call, and a conversation resumes its CLI-side session. Both transports expose thinking and tool progress.
- **Keep the entry id `llm-cli`.** That id is the settings namespace, so the documented `llm-cli:` section and any existing profile settings keep working after install.
- **Approximate a bare model call** with `tools: ''` (no built-in tools) and a `maxTurns` of `1`; leave both out to give the CLI its own loop.
- **Watch the quota, not just the bill.** A single harness turn can issue several model calls on its own (session title, compaction, subagent work), each one spending your CLI account's quota.

## Install

As an installable bundle (recommended):

```sh
dsh plugin --profile work add dsh-codebuddy-llm
```

The package declares `dsh.bundle.patch`, so its patch layer inserts the `llm-cli` route and selects it as the default for new Agents. To make the CLI the only model source, disable the HTTP provider rows in your own profile `cordis.patch.yml`:

```yaml
- id: llm-deepseek
  disabled: true
```

Or mount it by hand, without the bundle layer:

```yaml
- id: llm-cli
  name: 'dsh-codebuddy-llm'
  config:
    command: codebuddy
    args: ['--print', '--output-format', 'stream-json', '--include-partial-messages']
    transport: print
```

A missing `config` section still registers a serving route with the defaults below.

## Configuration

Every field is optional and volatile: a settings edit reaches the next request without re-registering the route.

| Field | Default | Meaning |
|---|---|---|
| `command` | `codebuddy` | Executable to spawn; `PATH` lookup applies. |
| `args` | `['--print', '--output-format', 'stream-json', '--include-partial-messages']` | Arguments of the `print` transport. An empty entry is refused, because the prompt is appended as the trailing positional argument. |
| `acpArgs` | `['--acp']` | Arguments that start the CLI as a long-lived ACP agent. |
| `transport` | `print` | `print` starts one child per call and reads its `stream-json`; `acp` keeps one child per route and prompts a session on it. |
| `permissionMode` | `bypassPermissions` | The CLI's own tool-approval policy. See the warning below. |
| `models` | `[]` | Advisory catalog for deployments that cannot interrogate the CLI. Each entry is `{ id, name?, contextWindow? }`. |
| `cwd` | process directory | Pins the child's workspace. A persistent session uses its recorded workspace instead. |
| `env` | `{}` | Extra environment entries, layered over the subprocess seam's scrubbed base. |
| `sessionIdArg` | `--session-id` | Argument carrying the persistent session id; an empty string makes every call stateless. |
| `tools` | CLI default | Tool set the CLI restricts itself to; an empty string disables every built-in tool. |
| `maxTurns` | `999` | Cap on the CLI's own agentic turns inside one call. |
| `effort` | CLI default | Reasoning level forwarded to the CLI. |
| `turnTimeoutMs` | `86400000` | Ceiling for one delegated turn (24 h). A turn is the CLI's whole agent loop, so the bound only ends a run that never converges; `0` removes the timer entirely. |
| `disposeGraceMs` | `3000` | Grace period for child process-tree termination. |
| `modelDiscoveryArgs` | `['--help']` | Command whose output lists the CLI's model ids for a `print` route. |
| `modelDiscoveryTimeoutMs` | `15000` | Deadline for that listing command. |

Timeouts on CLI tools such as `TaskOutput` end only that tool wait, not the parent turn. Only `turnTimeoutMs` ends the entire CLI call; it applies to both `print` and `acp` transports.

Model ids come from the CLI itself: an `acp` route asks the handshake (which also reports each model's input capacity), a `print` route parses the listing command. A configured catalog is merged behind the discovered entries.

> **Warning — permissions.** `permissionMode` governs the CLI's own tools, and the harness permission presets, the filesystem sandbox, and the shell sandbox do not mediate them. The default `bypassPermissions` therefore grants the child the OS access of the process that launched the harness. Set it explicitly to `default`, `acceptEdits`, or `plan` whenever the conversation may touch code or machines you do not trust.

> **Warning — data and cost.** Everything you send is forwarded to the CLI and on to its provider, and every call spends that account's quota. Both happen outside the harness's own accounting and privacy boundary.

## Compliance and data flow

- **Nothing about CodeBuddy is modified, patched, decompiled, or redistributed.** The plugin only spawns the executable with its documented flags and reads its stdout.
- **No credential handling.** The child keeps its own sign-in state; this package reads no key, token, or config file of the CLI.
- **Data leaves the harness through your own CLI session.** Conversation text you send becomes the child's prompt and reaches whatever provider that CLI is configured with. The harness session records the answer, reported thinking, and summaries of the CLI's tool activity.
- **Each model call consumes your CLI account's own quota.** Harness features that call the model on their own (session titles, compaction, subagents) multiply invocations.
- **Not affiliated with or endorsed by CodeBuddy.** The name is used only to describe the CLI this adapter drives.
- Two CodeBuddy-private `_meta` keys (`codebuddy.ai/parentToolCallId`, `codebuddy.ai/errorMessage`) are read best-effort; when absent the ACP transport degrades instead of failing.

## Known limitations

- Thinking and tool activity are reported only when the CLI emits those events. Tool activity is display-only: the harness does not execute or approve the CLI's tool calls. Tool input and output are capped at 65,536 characters each in the Session log.
- The plugin's `client.js` projects tool records into Harness's native tool views; the Harness version must support `dsh.client` package extensions to load it.
- `permissionMode` governs the CLI's tools, and harness permission presets, the filesystem sandbox, and the shell sandbox do not mediate them. The default `bypassPermissions` therefore grants the child the desktop process's OS access — narrow it when that is not intended.
- Only CodeBuddy-shaped output is understood: both the `stream-json` vocabulary and the positional-prompt invocation are CodeBuddy's.
- A missing or unreachable executable is reported as a refusal naming the configured command, instead of an empty catalog; the route still mounts, and still serves a `models` list you configured yourself. Its row is also relabelled `CodeBuddy CLI（未安装 CLI / CLI not installed）`, so the installation step is visible without opening a log. Model calls then fail the same way, so fix the `command` before relying on the route.
- A listing command that exits non-zero, times out, or prints a help text without the model line is reported the same way: discovery never turns an unreadable CLI into a silently empty catalog.
- Compaction and a model switch need a context capacity: the CLI must report one, or the catalog entry must declare `contextWindow`.

## Provenance

The Host adapter was extracted and extended from `packages/llm/llm-cli` of DeepSeek Harness `0.2.1-rc.3`; this plugin supplies the browser renderer. No Harness repository changes are required.

## License

MIT. See [LICENSE](LICENSE).
