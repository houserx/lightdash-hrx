/**
 * `list_sources` (CONTRACTS §7): the Telemetry Sources this server can query, and the Ops Marts the engine exposes.
 *
 * The engine exposes no "list sources" call, so the Telemetry Sources come from `MCP_SOURCES`, which mirrors the
 * non-secret part of the engine config (Contract assumption 5). The Ops Marts come from the engine catalog: the
 * `ops_marts` catalog of `information_schema.tables` (§1.1 "Catalog"; never `pg_catalog`), listed as
 * `ops_marts.<schema>.<table>`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config, SourceConfig } from '../config.js';
import { EngineError, type EngineClient } from '../engine/client.js';
import { engineErrorText } from '../engine/errors.js';

export const LIST_SOURCES_TOOL = 'list_sources';

/** The engine catalog that holds the allowlisted BigQuery Ops Marts (CONTRACTS §1.1). */
export const OPS_MARTS_CATALOG = 'ops_marts';

/** The catalog's own `information_schema` views are listed per catalog too; they are not Ops Marts. */
const CATALOG_SCHEMA = 'information_schema';

export const OPS_MARTS_SQL =
    'SELECT table_catalog, table_schema, table_name FROM information_schema.tables ' +
    `WHERE table_catalog = $1 AND table_schema <> '${CATALOG_SCHEMA}' ORDER BY table_schema, table_name`;

export interface ListSourcesResult {
    sources: SourceConfig[];
    /** `ops_marts.<schema>.<table>`, sorted. */
    opsMarts: string[];
}

export function configuredSources(config: Pick<Config, 'sources'>): SourceConfig[] {
    return config.sources.map(({ name, kind, default: isDefault, restricted }) => ({
        name,
        kind,
        default: isDefault,
        restricted,
    }));
}

export async function listOpsMarts(engine: EngineClient): Promise<string[]> {
    const { rows } = await engine.query(OPS_MARTS_SQL, [OPS_MARTS_CATALOG]);
    const marts = new Set<string>();
    for (const row of rows) {
        const { table_catalog: catalog, table_schema: schema, table_name: table } = row;
        if (catalog !== OPS_MARTS_CATALOG || typeof schema !== 'string' || typeof table !== 'string') continue;
        if (schema === CATALOG_SCHEMA) continue;
        marts.add(`${catalog}.${schema}.${table}`);
    }
    return [...marts].sort();
}

export async function listSources(config: Pick<Config, 'sources'>, engine: EngineClient): Promise<ListSourcesResult> {
    return { sources: configuredSources(config), opsMarts: await listOpsMarts(engine) };
}

export function registerListSources(server: McpServer, config: Config, engine: EngineClient): void {
    server.registerTool(
        LIST_SOURCES_TOOL,
        {
            title: 'List Telemetry Sources',
            description:
                'Lists every Telemetry Source this server can query, with its kind (for example prometheus, loki, ' +
                'cloudwatch, cloudwatch_logs, tempo or platform_postgres), whether it is the default for its kind, and whether ' +
                'it holds Restricted Telemetry. Use a source name from here as the optional source argument of ' +
                'the query tools. Also lists the Ops Marts (allowlisted BigQuery tables) as ' +
                'ops_marts.<schema>.<table>.',
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            let result: ListSourcesResult;
            try {
                result = await listSources(config, engine);
            } catch (err) {
                const text =
                    err instanceof EngineError
                        ? engineErrorText(err, 'Listing the Ops Marts')
                        : 'Listing the Ops Marts failed: unexpected error';
                return { isError: true, content: [{ type: 'text', text }] };
            }
            return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                structuredContent: { ...result },
            };
        },
    );
}
