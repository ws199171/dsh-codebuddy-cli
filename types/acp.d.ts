/**
 * ACP transport: one long-lived CLI child that carries every delegated run of a
 * route, driven over the Agent Client Protocol (NDJSON on stdin and stdout).
 *
 * The print transport starts a child per model call, so every call pays the
 * CLI's cold start and the answer can only be read from that one run. This
 * transport starts the child once, handshakes, and maps each model call to a
 * `session/prompt` on the session its conversation owns; the answer arrives as
 * `session/update` notifications, which is also where the CLI's own thinking
 * becomes visible instead of staying inside the child.
 *
 * The child is addressed by JSON-RPC framing: requests carry an id this module
 * correlates, notifications carry a session id it routes, and a request the CLI
 * raises for itself — a tool permission — is answered by the configured policy
 * rather than left hanging, because an unanswered request stalls the turn.
 *
 * @module dsh-codebuddy-llm/acp
 */
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
/** One incremental piece of a delegated answer. */
export type AcpTurnEvent = {
    kind: 'text';
    text: string;
} | {
    kind: 'thought';
    text: string;
} | {
    kind: 'activity';
    record: {
        callId: string;
        toolName: string;
        status: 'running' | 'ok' | 'failed';
        input?: string;
        output?: string;
    };
};
/**
 * How one delegated turn ended, as the CLI itself reported it. A turn the CLI
 * refused or cancelled still answers `session/prompt`; only this outcome tells
 * the caller that the empty answer is a failure rather than a short reply.
 */
export interface AcpPromptOutcome {
    /** The ACP stop reason the CLI reported for the turn. */
    readonly stopReason: string;
    /** The CLI's own failure detail reported beside the reason, when it gave one. */
    readonly detail?: string;
}
/**
 * The CLI session one conversation is bound to, and whether this child opened it
 * fresh. A lease is what tells the caller whether the CLI already holds the
 * conversation: a fresh session holds none, so the call has to carry the history.
 */
export interface AcpSessionLease {
    /** Session id the CLI itself assigned. */
    sessionId: string;
    /** Whether this child created the session (as opposed to adopting an existing one). */
    created: boolean;
}
/** One model the CLI advertises when it opens a session. */
export interface AcpCatalogModel {
    /** Model id the CLI accepts for `--model`. */
    readonly id: string;
    /** Display name the CLI reports, when it reports one. */
    readonly name?: string;
    /** Input capacity the CLI discloses for this id, when it discloses one. */
    readonly contextWindow?: number;
}
/** One permission option the CLI offers for a tool call it wants to run. */
export interface AcpPermissionOption {
    /** Identifier the answer selects. */
    id: string;
    /** Protocol-level kind, which is what a policy answers in terms of. */
    kind: string;
}
/** What the transport needs to run one route's child. */
export interface AcpTransportOptions {
    /** The subprocess seam's spawn operation. */
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle;
    /** Executable and ACP arguments; a prompt never rides argv here. */
    argv: readonly string[];
    /** Working directory the child itself starts in. */
    cwd: string;
    /** Environment entries layered over the seam's base. */
    env: Record<string, string>;
    /** Grace in milliseconds for child process-tree termination. */
    graceMs: number;
    /**
     * Answer one permission request: the option id to select, or undefined to
     * refuse. Absent refuses every request, which is what a deployment that
     * expects no tool activity wants.
     */
    selectPermission?: (options: readonly AcpPermissionOption[]) => string | undefined;
    /**
     * Ceiling in milliseconds for one prompted turn, or absent for none. The CLI
     * runs its whole agent loop inside one prompt, so this is the only bound the
     * client can put on a run that never converges: on expiry the turn is
     * cancelled and the caller is told it outlived its deadline.
     */
    turnTimeoutMs?: number;
}
/** A delegated turn that outlived the connection's deadline. */
export declare class AcpTurnTimeoutError extends Error {
    /** @param timeoutMs - the deadline the turn exceeded. */
    constructor(timeoutMs: number);
}
/**
 * One route's long-lived ACP connection.
 *
 * A transport is started lazily on first use and lives until {@link dispose};
 * sessions are created per harness conversation and reused across its calls,
 * so a second call to the same conversation pays neither a cold start nor a
 * handshake.
 */
export declare class AcpTransport {
    private readonly options;
    private child;
    private starting;
    private buffer;
    private nextId;
    private disposed;
    private readonly pending;
    private readonly turns;
    private readonly toolNames;
    private readonly sessions;
    constructor(options: AcpTransportOptions);
    /**
     * The ACP session one conversation is bound to, opened on first use.
     *
     * A conversation this child already serves keeps its session. Otherwise the
     * caller's `adopt` id — the session a previous child created for the same
     * conversation — is loaded through `session/load`, which is what keeps the
     * CLI's own history across a restarted harness or a replaced child. A failed
     * load (the CLI forgot it, or does not support loading) falls back to a fresh
     * session, and the returned lease says so, which is the caller's signal that
     * this call must carry the conversation itself.
     *
     * @param key - the harness conversation this session belongs to.
     * @param cwd - workspace the session runs in.
     * @param adopt - CLI session id a previous child created for this conversation.
     * @returns the session id and whether this child created it.
     */
    openSession(key: string, cwd: string, adopt?: string): Promise<AcpSessionLease>;
    /**
     * Read the model catalog this CLI advertises, by opening the session whose
     * answer carries it. The connection is the caller's to dispose afterwards: a
     * discovery probe wants the catalog and nothing of the session's history.
     * @param cwd - workspace the probe session runs in.
     * @returns one entry per advertised model, with the capacity it discloses.
     */
    describeModels(cwd: string): Promise<readonly AcpCatalogModel[]>;
    /**
     * Ask the child to resume a session a previous child created.
     * @param cwd - workspace the session runs in.
     * @param sessionId - CLI session id to load.
     * @returns whether the child resumed it; a refusal is not this call's failure.
     */
    private loadSession;
    /**
     * Run one model call as a prompt on the session that owns the conversation.
     * @param sessionId - the ACP session from {@link openSession}.
     * @param text - the prompt text this call carries.
     * @param signal - caller cancellation, forwarded as `session/cancel`.
     * @returns the answer's incremental events, and how the CLI ended the turn
     *   once they are drained — `cancelled` and `refusal` are outcomes, not errors.
     */
    prompt(sessionId: string, text: string, signal?: AbortSignal): AsyncGenerator<AcpTurnEvent, AcpPromptOutcome>;
    /**
     * End the connection and the child behind it.
     * @returns once the child's process tree is gone.
     */
    dispose(): Promise<void>;
    /** Start the child and handshake once; a second caller joins the first attempt. */
    private ensureStarted;
    private start;
    /** Route one parsed line: a response, a turn update, or a request to answer. */
    private handleLine;
    /** Answer one request the CLI raised, so the turn it belongs to can continue. */
    private answerRequest;
    /** Send one request and await its response. */
    private request;
    /** Send one notification, which expects no answer. */
    private notify;
    private write;
    /** Fail every waiter: the child is gone, so no request can be answered. */
    private failAll;
}
//# sourceMappingURL=acp.d.ts.map
