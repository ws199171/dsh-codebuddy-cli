/**
 * `llm-cli`: a provider route answered by a CLI child instead of a provider HTTP
 * endpoint.
 *
 * The route exists so a deployment can run the harness with no API key at all:
 * the configured CLI (CodeBuddy by default) carries its own authentication and
 * runs its own agentic loop with its own tools. The harness forwards
 * conversation text and receives answer, reasoning, and tool activity, so a
 * model swap is a configuration change rather than a harness change.
 *
 * The plugin depends on exactly two seams — `llm` (the adapter registry) and
 * `subprocess` (child lifecycle) — and reaches the session store, when a
 * deployment has one, through an untyped service lookup. Nothing here requires
 * `dsh-session`, a remote surface, or a client package, so mounting it changes
 * no shared package.
 *
 * ```yaml
 * - id: llm-cli
 *   name: 'dsh-codebuddy-llm'
 *   config:
 *     command: codebuddy
 *     args: ['--print', '--output-format', 'stream-json', '--include-partial-messages']
 *     permissionMode: bypassPermissions
 * ```
 *
 * @module dsh-codebuddy-llm
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
export { CliAdapter, CLI_TRANSPORTS, CODEBUDDY_EFFORT_LEVELS, CODEBUDDY_PERMISSION_MODES, DEFAULT_TRANSPORT, } from './adapter.js';
export type { CliAdapterOptions, CliCatalogModel, CliConnectionOptions, CliTransport, CodeBuddyEffort, CodeBuddyPermissionMode, } from './adapter.js';
export { AcpTransport } from './acp.js';
export type { AcpCatalogModel, AcpPermissionOption, AcpPromptOutcome, AcpTransportOptions, AcpTurnEvent } from './acp.js';
export { Config, DEFAULT_ARGS, DEFAULT_COMMAND, DEFAULT_DISPOSE_GRACE_MS, DEFAULT_MODEL_DISCOVERY_ARGS, DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS, DEFAULT_PERMISSION_MODE, DEFAULT_SESSION_ID_ARG, plainOptions, resolveAdapterOptions, } from './config.js';
export type { Options, ResolvedCliOptions } from './config.js';
export { discoverCliModels, parseCodeBuddyModels } from './discovery.js';
export * from './translate.js';
export * from './wire.js';
export declare const name = "llm-cli";
export declare const inject: string[];
/** Register the CLI route, its settings section, and its model discovery. */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map
