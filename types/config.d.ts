/**
 * Plugin configuration and the one resolve step from raw config to validated
 * executable facts.
 *
 * Every field is `Volatile`, so a Models-page edit reaches the next request
 * through the loader's volatile update without restarting anything. The resolve
 * step re-judges every default and bound because programmatic construction and
 * a settings snapshot both bypass Schemastery normalization.
 *
 * @module dsh-codebuddy-llm/config
 */
import type { Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { CliCatalogModel, CliConnectionOptions, CliTransport, CodeBuddyEffort, CodeBuddyPermissionMode } from './adapter.js';
/** The default CLI executable; a bare name resolves on PATH. */
export declare const DEFAULT_COMMAND = "codebuddy";
/**
 * Base arguments producing stream-json on stdout with a trailing positional
 * prompt. Partial messages are requested too: without them the CLI reports a
 * message only once it is complete, so a caller waits out the child's whole
 * agent loop — tool rounds included — before the first character arrives.
 */
export declare const DEFAULT_ARGS: readonly string[];
/** The argument that carries the persistent session id. */
export declare const DEFAULT_SESSION_ID_ARG = "--session-id";
/** Permission mode that makes a delegated, non-interactive CLI run usable by default. */
export declare const DEFAULT_PERMISSION_MODE: CodeBuddyPermissionMode;
/** Default graceful-termination window for a CLI child. */
export declare const DEFAULT_DISPOSE_GRACE_MS = 3000;
/** Arguments that start the CLI as a long-lived ACP agent on stdio. */
export declare const DEFAULT_ACP_ARGS: readonly string[];
/** Arguments that print the CLI's supported model ids without starting an agent session. */
export declare const DEFAULT_MODEL_DISCOVERY_ARGS: readonly string[];
/** Default ceiling for one model-discovery child. */
export declare const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 15000;
/**
 * Default ceiling for one delegated `acp` turn. A turn is the CLI's whole agent
 * loop, not one model round, so the bound is generous; it exists to end a run
 * that never converges rather than to pace an ordinary one.
 */
export declare const DEFAULT_TURN_TIMEOUT_MS = 600000;
/**
 * Plugin config, validated by the same-named schemastery schema and doubling as
 * the `llm-cli` user-settings section shape. Every field is optional in yml: a
 * missing command falls back to `codebuddy`, and an empty section still
 * registers the route with the defaults.
 */
export interface Config {
    /** CLI executable; a bare name resolves on PATH. */
    command: Volatile<string>;
    /** Arguments producing stream-json on stdout; the prompt is appended last. */
    args: Volatile<string[]>;
    /** Arguments that start the CLI as a long-lived ACP agent; used by the `acp` transport. */
    acpArgs: Volatile<string[]>;
    /** Arguments that print the CLI's supported model ids without starting an agent session. */
    modelDiscoveryArgs: Volatile<string[]>;
    /** Hard ceiling in milliseconds for one model-discovery child. */
    modelDiscoveryTimeoutMs: Volatile<number>;
    /**
     * Ceiling in milliseconds for one delegated `acp` turn, or `0` for none. The
     * CLI runs its whole agent loop inside one call, so an unbounded turn is a
     * run that can hold the conversation open for as long as it keeps working.
     */
    turnTimeoutMs: Volatile<number>;
    /** Advisory model ids offered beside the discovered ones. */
    models: Volatile<CliCatalogModel[]>;
    /** Child working directory; when absent, a persistent session's workspace wins. */
    cwd: Volatile<string | undefined>;
    /** Explicit environment entries layered over the subprocess seam's base. */
    env: Volatile<Record<string, string>>;
    /** Argument carrying the persistent session id; an empty value disables CLI-side sessions. */
    sessionIdArg: Volatile<string>;
    /**
     * How a call reaches the CLI: `print` starts a child per call, `acp` keeps
     * one child per route and prompts a session on it.
     */
    transport: Volatile<CliTransport>;
    /** The CLI's own tool-approval policy for the delegated run. */
    permissionMode: Volatile<CodeBuddyPermissionMode>;
    /**
     * Tool set the delegated run restricts itself to. An empty value disables
     * every built-in tool, which reduces the CLI to a model call; absent leaves
     * the CLI's own default set.
     */
    tools: Volatile<string | undefined>;
    /**
     * Cap on the CLI's own agentic turns. Absent leaves the CLI's own default,
     * which is what lets it run a whole tool loop inside one call.
     */
    maxTurns: Volatile<number | undefined>;
    /** Reasoning effort the CLI forwards to the model; absent leaves its own default. */
    effort: Volatile<CodeBuddyEffort | undefined>;
    /** Grace in milliseconds for child process-tree termination. */
    disposeGraceMs: Volatile<number>;
}
/**
 * Plain config accepted by the resolver: one detached value per option. Derived
 * from {@link Config} so the two cannot drift; each value is a frozen snapshot
 * of a volatile reference, read-only in practice.
 */
export type Options = {
    [K in keyof Config]?: Config[K] extends Volatile<infer T> ? Exclude<T, undefined> : never;
};
/**
 * Read the current value behind every reference of a parsed {@link Config}.
 * Every schema field is volatile, so each entry is a reference by construction.
 * @param config - parsed plugin config.
 * @returns one detached value per option.
 */
export declare function plainOptions(config: Config): Options;
/** Fields shared by the plugin entry config and the `llm-cli` settings section. */
export declare const cliConfigFields: {
    command: z<string, string, "volatile-defined">;
    args: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    acpArgs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelDiscoveryArgs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelDiscoveryTimeoutMs: z<number, number, "volatile-defined">;
    turnTimeoutMs: z<number, number, "volatile-defined">;
    models: z<NoInfer<CliCatalogModel[]>, NoInfer<CliCatalogModel[]>, "volatile-defined">;
    cwd: z<string, string, "volatile">;
    env: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    sessionIdArg: z<string, string, "volatile-defined">;
    transport: z<"print" | "acp", "print" | "acp", "volatile-defined">;
    permissionMode: z<"acceptEdits" | "bypassPermissions" | "default" | "plan" | "dontAsk" | "auto", "acceptEdits" | "bypassPermissions" | "default" | "plan" | "dontAsk" | "auto", "volatile-defined">;
    tools: z<string, string, "volatile">;
    maxTurns: z<number, number, "volatile">;
    effort: z<"minimal" | "low" | "medium" | "high" | "xhigh" | "max", "minimal" | "low" | "medium" | "high" | "xhigh" | "max", "volatile">;
    disposeGraceMs: z<number, number, "volatile-defined">;
};
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    command: z<string, string, "volatile-defined">;
    args: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    acpArgs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelDiscoveryArgs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelDiscoveryTimeoutMs: z<number, number, "volatile-defined">;
    turnTimeoutMs: z<number, number, "volatile-defined">;
    models: z<NoInfer<CliCatalogModel[]>, NoInfer<CliCatalogModel[]>, "volatile-defined">;
    cwd: z<string, string, "volatile">;
    env: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    sessionIdArg: z<string, string, "volatile-defined">;
    transport: z<"print" | "acp", "print" | "acp", "volatile-defined">;
    permissionMode: z<"acceptEdits" | "bypassPermissions" | "default" | "plan" | "dontAsk" | "auto", "acceptEdits" | "bypassPermissions" | "default" | "plan" | "dontAsk" | "auto", "volatile-defined">;
    tools: z<string, string, "volatile">;
    maxTurns: z<number, number, "volatile">;
    effort: z<"minimal" | "low" | "medium" | "high" | "xhigh" | "max", "minimal" | "low" | "medium" | "high" | "xhigh" | "max", "volatile">;
    disposeGraceMs: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    command: z<string, string, "volatile-defined">;
    args: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    acpArgs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelDiscoveryArgs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelDiscoveryTimeoutMs: z<number, number, "volatile-defined">;
    turnTimeoutMs: z<number, number, "volatile-defined">;
    models: z<NoInfer<CliCatalogModel[]>, NoInfer<CliCatalogModel[]>, "volatile-defined">;
    cwd: z<string, string, "volatile">;
    env: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    sessionIdArg: z<string, string, "volatile-defined">;
    transport: z<"print" | "acp", "print" | "acp", "volatile-defined">;
    permissionMode: z<"acceptEdits" | "bypassPermissions" | "default" | "plan" | "dontAsk" | "auto", "acceptEdits" | "bypassPermissions" | "default" | "plan" | "dontAsk" | "auto", "volatile-defined">;
    tools: z<string, string, "volatile">;
    maxTurns: z<number, number, "volatile">;
    effort: z<"minimal" | "low" | "medium" | "high" | "xhigh" | "max", "minimal" | "low" | "medium" | "high" | "xhigh" | "max", "volatile">;
    disposeGraceMs: z<number, number, "volatile-defined">;
}>>, "plain">;
/** Validated executable facts for one operation, as the adapter reads them. */
export type ResolvedCliOptions = CliConnectionOptions;
/**
 * Merge what the CLI last advertised with the ids the deployment declared. The
 * advertised order leads — it is the CLI's own listing, which is what a picker
 * should show — and a declared entry keeps the fields it declares there, so a
 * curated label is not replaced by the bare id, while everything it leaves out
 * still comes from the CLI. Declared ids the CLI did not report follow, so an
 * advisory id stays selectable.
 * @param configured - catalog entries the deployment declared.
 * @param discovered - entries the last probe of the CLI reported.
 * @returns one entry per id, advertised order first.
 */
export declare function mergeCatalog(configured: readonly CliCatalogModel[], discovered: readonly CliCatalogModel[]): CliCatalogModel[];
/**
 * The one explicit resolve step from raw config to validated executable facts.
 * @param config - raw plugin config or a resolved settings snapshot.
 * @param defaultCwd - fallback working directory for the CLI child.
 * @returns validated executable facts for the adapter.
 */
export declare function resolveAdapterOptions(config: Options, defaultCwd: string): ResolvedCliOptions;
//# sourceMappingURL=config.d.ts.map