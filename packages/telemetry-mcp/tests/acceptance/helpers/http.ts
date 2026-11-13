/** Raw HTTP helpers for auth tests. PROTECTED: do not edit. */

export const INITIALIZE_BODY = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'acceptance-test', version: '0.0.0' },
    },
};

/** POSTs an MCP initialize request to `mcpUrl`, optionally with a bearer token. */
export async function postInitialize(mcpUrl: string, token?: string): Promise<Response> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
    };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    return fetch(mcpUrl, { method: 'POST', headers, body: JSON.stringify(INITIALIZE_BODY) });
}
