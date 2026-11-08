/**
 * The LLM client interface the ported portal services call (PROGRESS.md "Public API": `Deps.llm`).
 *
 * It is the subset of the Anthropic Messages API the portal used through `@anthropic-ai/sdk`
 * (`client.messages.create(params)`), flattened to one method so tests can inject a scripted fake and the
 * server can supply a `fetch`-based client. `@anthropic-ai/sdk` is not a dependency of this package.
 */

export interface LlmTextBlock {
    type: 'text';
    text: string;
}

export interface LlmToolUseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export type LlmContentBlock = LlmTextBlock | LlmToolUseBlock;

export interface LlmToolResultBlock {
    type: 'tool_result';
    tool_use_id: string;
    content: string | LlmTextBlock[];
    is_error?: boolean;
}

export type LlmMessageContent = string | (LlmContentBlock | LlmToolResultBlock)[];

export interface LlmMessage {
    role: 'user' | 'assistant';
    content: LlmMessageContent;
}

export interface LlmTool {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

export type LlmToolChoice =
    | { type: 'auto' }
    | { type: 'any' }
    | { type: 'none' }
    | { type: 'tool'; name: string };

/** A system prompt block; `cache_control` marks the end of a cacheable prompt prefix (the data assistant's). */
export interface LlmSystemBlock {
    type: 'text';
    text: string;
    cache_control?: { type: 'ephemeral' };
}

export interface LlmRequest {
    model: string;
    max_tokens: number;
    system?: string | LlmSystemBlock[];
    messages: LlmMessage[];
    tools?: LlmTool[];
    tool_choice?: LlmToolChoice;
    temperature?: number;
    /** Extended thinking setting, passed through as given (the data assistant sends `{ type: 'between_tools' }`). */
    thinking?: { type: string };
}

/** Per-call transport options (the portal passed these as the SDK's request options). */
export interface LlmCallOptions {
    /** Give up after this long. */
    timeoutMs?: number;
    /** Aborted when the caller goes away. */
    signal?: AbortSignal;
}

export interface LlmUsage {
    input_tokens: number;
    output_tokens: number;
}

export interface LlmResponse {
    id?: string;
    type?: 'message';
    role?: 'assistant';
    model?: string;
    content: LlmContentBlock[];
    stop_reason?: string | null;
    usage: LlmUsage;
}

export interface LlmClient {
    createMessage(params: LlmRequest, options?: LlmCallOptions): Promise<LlmResponse>;
}

/** The text of a response: every text block, newline-joined and trimmed (the portal's extraction). */
export function responseText(response: Pick<LlmResponse, 'content'>): string {
    return response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n')
        .trim();
}
