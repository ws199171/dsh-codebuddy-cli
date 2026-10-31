/**
 * `CliAdapter`: the delegating LLM adapter that answers one model call by
 * running one CLI child process and translating its stream-json output into
 * harness `StreamChunk`s. The configured CLI (CodeBuddy by default) carries its
 * own authentication and runs its own agentic loop with its own tools, so the
 * harness forwards conversation text and receives answer, reasoning, and tool
 * activity: no API key or harness-side tool loop is needed.
 *
 * The adapter is transport-only. Executable facts arrive through a thunk
 * resolved once per operation, and the registering plugin owns validation,
 * defaults, and configuration — so a settings change reaches the next call
 * without re-registering this route.
 *
 * @module dsh-codebuddy-llm/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
/** One optional model entry the CLI route advertises. */
export interface CliCatalogModel {
    /** Model id accepted by {@link GenerateOptions.model} for this route. */
    id: string;
    /** Selector label; defaults to {@link id}. */
    name?: string;
    /**
     * Input capacity this id accepts, when the deployment knows it. Compaction and
     * switching need it, and a route that owns no endpoint cannot derive it; the
     * ACP handshake supplies the CLI's own figure where it reports one.
     */
    contextWindow?: number;
}
/** The CLI permission modes its non-interactive print command accepts. */
export declare const CODEBUDDY_PERMISSION_MODES: readonly ["acceptEdits", "bypassPermissions", "default", "plan", "dontAsk", "auto"];
/** The delegated CLI's policy for approving tools inside its own agent loop. */
export type CodeBuddyPermissionMode = typeof CODEBUDDY_PERMISSION_MODES[number];
/** The reasoning effort levels the CLI's own flag accepts. */
export declare const CODEBUDDY_EFFORT_LEVELS: readonly ["minimal", "low", "medium", "high", "xhigh", "max"];
/** Reasoning effort the delegated CLI forwards to the model. */
export type CodeBuddyEffort = typeof CODEBUDDY_EFFORT_LEVELS[number];
/** The ways this route can reach the CLI. */
export declare const CLI_TRANSPORTS: readonly ["print", "acp"];
/**
 * How one call reaches the CLI: `print` starts a child per call and reads its
 * stream-json, `acp` keeps one child per route and prompts a session on it.
 * `print` is the default because it needs nothing of the CLI but its own
 * non-interactive mode.
 */
export type CliTransport = typeof CLI_TRANSPORTS[number];
/** Transport a deployment gets without asking for one. */
export declare const DEFAULT_TRANSPORT: CliTransport;
/**
 * Validated executable facts for one operation. The plugin's resolve step
 * produces this shape; the adapter trusts it and re-reads it per operation.
 */
export interface CliConnectionOptions {
    /** Executable and base arguments; `argv[0]` is the program. */
    argv: readonly string[];
    /** Configured working directory, or the process fallback for the CLI child. */
    cwd: string;
    /** Whether a persistent session's own workspace replaces {@link cwd} when one is available. */
    useSessionCwd: boolean;
    /** Explicit environment entries layered over the subprocess seam's base. */
    env: Record<string, string>;
    /** Argument carrying the persistent session id, or undefined for stateless runs. */
    sessionIdArg?: string;
    /** How a call reaches the CLI; see {@link CliTransport}. */
    transport: CliTransport;
    /** The CLI's permission policy for tools its own loop executes. */
    permissionMode: CodeBuddyPermissionMode;
    /** Tool set the CLI restricts itself to; an empty value disables every built-in tool. Absent leaves its own default. */
    tools?: string;
    /** Cap on the CLI's own agentic turns; absent leaves its own default. */
    maxTurns?: number;
    /** Reasoning effort the CLI forwards to the model; absent leaves its own default. */
    effort?: CodeBuddyEffort;
    /** Grace in milliseconds for child process-tree termination. */
    disposeGraceMs: number;
    /**
     * Ceiling in milliseconds for one delegated CLI turn, or `0` for none. The
     * CLI runs a whole agent loop inside one call, so without a ceiling a run that
     * never converges holds the turn open for as long as the CLI keeps working.
     */
    turnTimeoutMs: number;
    /** Executable and arguments that start the CLI as a long-lived ACP agent. */
    acpArgv: readonly string[];
    /** Executable and arguments that print the CLI's supported model ids. */
    discoveryArgv: readonly string[];
    /** Hard ceiling in milliseconds for one model-discovery child. */
    discoveryTimeoutMs: number;
    /** Advisory models exposed to discovery consumers. */
    models: readonly CliCatalogModel[];
}
/** Constructor options for {@link CliAdapter}. */
export interface CliAdapterOptions {
    /** Current validated executable facts; read once per operation. */
    options: () => CliConnectionOptions;
    /** The subprocess seam's spawn operation. */
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle;
    /** Resolve the workspace selected for a persistent harness session. */
    resolveSessionCwd?: (sessionId: NonNullable<GenerateOptions['sessionId']>) => string | undefined;
    /** Observe CLI-owned tool activity using the owning harness conversation id. */
    onToolActivity?: (sessionId: NonNullable<GenerateOptions['sessionId']>, record: { callId: string; toolName: string; status: 'running' | 'ok' | 'failed'; input?: string; output?: string }) => void;
    onThoughtActivity?: (sessionId: NonNullable<GenerateOptions['sessionId']>, text: string) => void;
}
/**
 * Delegating CLI adapter: one provider route whose model ids name the CLI's own
 * model selection. Its default transport spawns a child per call, hands it the
 * prompt as its final positional argument, and consumes stream-json on stdout;
 * the ACP transport keeps one child per route and prompts a session on it, so
 * the CLI's cold start is paid once per route instead of once per call.
 */
export declare class CliAdapter extends LlmAdapter {
    private readonly options;
    private readonly spawn;
    private readonly resolveSessionCwd;
    private readonly onToolActivity;
    private readonly onThoughtActivity;
    /**
     * The long-lived ACP connection of each workspace, replaced when what starts
     * its child changes. The CLI takes its workspace from the directory the child
     * starts in rather than from `session/new`, so a workspace needs its own child.
     */
    private readonly acp;
    /**
     * CLI sessions this route opened, by harness conversation. Held here rather
     * than in the transport because a replaced child must be able to resume them:
     * the id names a session in the CLI's own store, not in one child.
     */
    private readonly acpSessions;
    /** Numbers the throwaway sessions a stateless call gets. */
    private statelessCalls;
    constructor(options: CliAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * Answer one call through the route's long-lived ACP child. The session owns
     * the conversation, so only this call's text is sent — which is also why the
     * transport pays the CLI's cold start once per route instead of once per call.
     * @param facts - resolved executable facts for this operation.
     * @param options - the model call being answered.
     * @param prompt - the text this call carries.
     * @param recap - the conversation before this call's newest human text, sent
     *   instead of `prompt` when the CLI session is new and holds no history.
     * @param cwd - workspace the conversation's session runs in.
     * @param signal - caller cancellation, forwarded as a session cancel.
     * @returns the call's chunks, ending with its terminal.
     */
    private streamAcp;
    /**
     * Release the route's long-lived children, if any were ever started. The
     * plugin calls this from the effect that registered the route, so unloading
     * the route unloads its children rather than leaving them to outlive the
     * composition.
     * @returns once every child's process tree is gone.
     */
    dispose(): Promise<void>;
    /**
     * The ACP connection one workspace runs on, started on first use and replaced
     * when the facts that started it change. The model and the workspace ride the
     * process: the CLI takes both as launch facts, so one child serves one model
     * in one workspace.
     * @param facts - resolved executable facts for this operation.
     * @param model - model id this call selected.
     * @param cwd - workspace the conversation's session runs in.
     * @returns the connection to prompt on.
     */
    private acpTransport;
}
//# sourceMappingURL=adapter.d.ts.map
