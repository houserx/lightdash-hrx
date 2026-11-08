/**
 * `list_sources` (CONTRACTS §7): the Telemetry Sources this server can query.
 *
 * The engine exposes no "list sources" call, so the Telemetry Sources come from `MCP_SOURCES`, which mirrors the
 * non-secret part of the engine config (Contract assumption 5). It reads configuration only and never contacts
 * the engine. The Ops Marts from the engine catalog are added by `mcp-tool-list-sources`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config, SourceConfig } from '../config.js';

export const LIST_SOURCES_TOOL = 'list_sources';

export interface ListSourcesResult {
    sources: SourceConfig[];
}

export function listSources(config: Pick<Config, 'sources'>): ListSourcesResult {
    return {
        sources: config.sources.map(({ name, kind, default: isDefault, restricted }) => ({
            name,
            kind,
            default: isDefault,
            restricted,
        })),
    };
}

export function registerListSources(server: McpServer, config: Config): void {
    server.registerTool(
        LIST_SOURCES_TOOL,
        {
            title: 'List Telemetry Sources',
            description:
                'Lists every Telemetry Source this server can query, with its kind (for example prometheus, loki, ' +
                'cloudwatch, cloudwatch_logs, tempo or platform_postgres), whether it is the default for its kind, and whether ' +
                'it holds Restricted Telemetry. Use a source name from here as the optional source argument of ' +
                'the query tools.',
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        () => {
            const result = listSources(config);
            return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                structuredContent: { ...result },
            };
        },
    );
}
