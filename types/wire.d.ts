/**
 * Line-protocol parsing for a CLI child's stream-json output. CodeBuddy-style
 * CLIs emit one JSON object per line; this parser owns line framing, the event
 * vocabulary it understands, and the text-delta computation.
 *
 * Two line families carry answer text, and a run may produce either or both:
 * `stream_event` frames wrap the model request's own SSE events when the child
 * is asked for partial messages, so text arrives while it is still being
 * generated; and the completed `assistant` frame repeats the whole message once
 * the message ends. Both are measured against the text already observed *for
 * the message in progress*, which is why `message_start` is reported rather
 * than ignored — it is the only boundary a caller has for resetting that
 * measurement. A frame adding nothing beyond the text already seen is ignored,
 * so a run reading both families emits each character once.
 *
 * Partial thinking and tool-use frames are reported separately from answer
 * text. Unknown events are ignored: the event vocabulary is merge-extensible
 * and this adapter only consumes what it maps.
 *
 * @module dsh-codebuddy-llm/wire
 */
import type { LlmFailure, TokenUsage } from '@deepseek-ai/dsh-llm';
/** One emitted text delta, from a partial message or from a completed one. */
export interface CliTextDelta {
    /** Newly observed text since the previous frame of the message in progress. */
    text: string;
}
/** Terminal outcome of one CLI run, as reported by its result event. */
export type CliTerminal = {
    kind: 'stop';
    sessionId?: string;
    usage?: TokenUsage;
} | {
    kind: 'max-turns';
} | {
    kind: 'error';
    failure: LlmFailure;
};
/** What one parsed line contributes to the adapter. */
export type CliLineEvent = {
    kind: 'message-start';
} | {
    kind: 'text';
    delta: CliTextDelta;
} | {
    kind: 'thought';
    delta: CliTextDelta;
} | {
    kind: 'assistant';
    delta?: CliTextDelta;
    thought?: CliTextDelta;
    tools: { callId: string; toolName: string; input?: string }[];
} | {
    kind: 'tool-start';
    index: number;
    callId: string;
    name: string;
} | {
    kind: 'tool-input';
    index: number;
    partial: string;
} | {
    kind: 'tool-input-end';
    index: number;
} | {
    kind: 'tool-result';
    callId: string;
    text: string;
    failed: boolean;
} | {
    kind: 'tool-results';
    results: { callId: string; text: string; failed: boolean }[];
} | {
    kind: 'terminal';
    terminal: CliTerminal;
} | {
    kind: 'ignored';
};
/**
 * Parse one line of CLI stream-json output.
 * @param line - one raw stdout line (already stripped of its newline).
 * @param lastText - the text observed so far for the message in progress; a delta is measured against it.
 * @returns the event this line contributes, or undefined when the line is blank.
 */
export declare function parseCliLine(line: string, lastText: string, lastThought?: string): CliLineEvent | undefined;
//# sourceMappingURL=wire.d.ts.map
