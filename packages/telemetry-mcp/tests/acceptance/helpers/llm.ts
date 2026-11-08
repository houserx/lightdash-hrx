/**
 * Scripted fake LLM for acceptance tests. It implements the package's `LlmClient` interface
 * (Anthropic Messages API shape, see PROGRESS.md "Public API"):
 *
 *   createMessage(params: { model, max_tokens, system?, messages, tools?, tool_choice?, ... })
 *     => Promise<{ content: ContentBlock[]; usage: { input_tokens; output_tokens }; stop_reason? }>
 *
 * Each call consumes the next scripted step. A step is a response or a function of the request.
 * PROTECTED: do not edit.
 */

export type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export interface LlmResponse {
    id?: string;
    type?: 'message';
    role?: 'assistant';
    model?: string;
    content: ContentBlock[];
    stop_reason?: string;
    usage: { input_tokens: number; output_tokens: number };
}

export type LlmRequest = Record<string, unknown> & { messages: unknown[]; model: string };

export type Step = LlmResponse | ((req: LlmRequest) => LlmResponse);

let toolCounter = 0;

export function toolUse(name: string, input: Record<string, unknown>): LlmResponse {
    toolCounter += 1;
    return {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use', id: `toolu_test_${toolCounter}`, name, input }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
    };
}

export function textReply(text: string): LlmResponse {
    return {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
    };
}

export class ScriptedLlm {
    readonly requests: LlmRequest[] = [];
    private steps: Step[];

    constructor(steps: Step[] = []) {
        this.steps = [...steps];
    }

    push(...steps: Step[]): void {
        this.steps.push(...steps);
    }

    async createMessage(params: LlmRequest): Promise<LlmResponse> {
        // Deep-copy so later in-place edits by the caller don't rewrite history.
        const snapshot = JSON.parse(JSON.stringify(params)) as LlmRequest;
        this.requests.push(snapshot);
        const step = this.steps.shift();
        if (!step) throw new Error('fake llm: script exhausted');
        return typeof step === 'function' ? step(snapshot) : step;
    }
}

/** All text the model was shown in a request: system prompt, messages and tool results, as one string. */
export function requestText(req: LlmRequest): string {
    return JSON.stringify({ system: req.system ?? null, messages: req.messages });
}
