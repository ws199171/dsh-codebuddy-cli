/**
 * Host-side CLI model discovery. It runs the configured CLI's own listing
 * command (default `--help`) through the shared subprocess seam and parses the
 * model ids the CLI reports, so the standard Models page can offer the CLI's
 * real catalog without this package owning a remote surface of its own.
 *
 * Every child here goes through the seam, so discovery inherits process-tree
 * termination and environment scrubbing instead of managing a child itself.
 *
 * @module dsh-codebuddy-llm/discovery
 */
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type { CliCatalogModel } from './adapter.js';
/** The ACP connection a route that speaks ACP can be interrogated over. */
export interface CliAcpDiscovery {
    /** Executable and arguments that start the CLI as a long-lived ACP agent. */
    argv: readonly string[];
    /** Environment entries layered over the seam's base. */
    env: Record<string, string>;
    /** Grace in milliseconds for terminating the probe's process tree. */
    graceMs: number;
}
/** One discovery run's inputs, already validated by the resolver. */
export interface CliDiscoveryRequest {
    /** Executable and arguments producing the model listing on stdout. */
    argv: readonly string[];
    /** Working directory for the discovery child. */
    cwd: string;
    /** Hard ceiling in milliseconds for the listing child. */
    timeoutMs: number;
    /** The route's advisory catalog, offered after the discovered ids. */
    configured: readonly CliCatalogModel[];
    /** The subprocess seam's spawn operation. */
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle;
    /**
     * The ACP connection to interrogate instead of the listing command, when the
     * route reaches the CLI over ACP: that handshake carries the capacity of each
     * advertised model, which a listing of ids cannot.
     */
    acp?: CliAcpDiscovery | undefined;
    /** Caller cancellation, honored beside the timeout. */
    signal?: AbortSignal | undefined;
}
/**
 * Parse the model ids a CodeBuddy-style CLI lists for its `--model` option.
 * @param help - the CLI's own help output.
 * @returns the unique ids in the CLI's reported order, without display names.
 */
export declare function parseCodeBuddyModels(help: string): LlmDiscoveredModel[];
/**
 * Discover the models the configured CLI advertises.
 * @param request - the listing invocation, its bounds, and the route's own catalog.
 * @returns the discovered models first, then configured ids the CLI did not report.
 */
export declare function discoverCliModels(request: CliDiscoveryRequest): Promise<readonly LlmDiscoveredModel[]>;
//# sourceMappingURL=discovery.d.ts.map