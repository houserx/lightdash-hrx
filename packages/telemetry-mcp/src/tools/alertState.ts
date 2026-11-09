/**
 * `alert_state` (CONTRACTS §7): the current state of the Operations Project's Alert Rules, from
 * `GET /api/v2/projects/{LIGHTDASH_PROJECT_UUID}/alerting/state` with the service-account token. The optional
 * `rule_uuid` is checked to be a uuid before Lightdash is called and is sent as Lightdash's `rule` filter, and
 * also as `ruleUuid` (the name this package's contract assumption gave it, which its acceptance check pins;
 * Lightdash ignores it). The result is `{ results: <Lightdash results> }`, untouched.
 *
 * The results are not row-shaped, so nothing is dropped to fit `MCP_MAX_OUTPUT_BYTES`: a result over the cap is a
 * tool error that suggests filtering by rule.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { UUID_RE, type Config } from '../config.js';
import { AlertingError, type AlertingClient } from '../lightdash/alerting.js';
import { errorResult } from './telemetryArgs.js';

export const ALERT_STATE_TOOL = 'alert_state';

export interface AlertStateArgs {
    rule_uuid?: string;
}

/** The structured result and its JSON text, or an error result when it is over `maxBytes` (UTF-8). */
export function alertingResult(results: unknown, maxBytes: number, narrowHint: string): CallToolResult {
    const structuredContent = { results };
    const text = JSON.stringify(structuredContent);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        return errorResult(`The result is too large to return (MCP_MAX_OUTPUT_BYTES). ${narrowHint}`);
    }
    return { content: [{ type: 'text', text }], structuredContent };
}

export async function alertState(
    alerting: AlertingClient,
    maxBytes: number,
    args: AlertStateArgs,
): Promise<CallToolResult> {
    const ruleUuid = args.rule_uuid;
    if (ruleUuid !== undefined && !UUID_RE.test(ruleUuid)) {
        return errorResult('rule_uuid must be an Alert Rule uuid, such as a ruleUuid from alert_state');
    }
    try {
        const results = await alerting.get('state', { rule: ruleUuid, ruleUuid });
        return alertingResult(results, maxBytes, 'Pass rule_uuid to get one Alert Rule.');
    } catch (err) {
        if (err instanceof AlertingError) return errorResult(err.message);
        return errorResult('The Lightdash alerting state request failed: unexpected error');
    }
}

export function registerAlertState(server: McpServer, config: Config, alerting: AlertingClient): void {
    server.registerTool(
        ALERT_STATE_TOOL,
        {
            title: 'Alert state',
            description:
                'Returns the current state of the Alert Rules in the Lightdash Operations Project, as reported by ' +
                'Lightdash alerting: each rule with its ruleUuid, name and state (for example firing, pending or ' +
                'normal) and its per-series state. Pass rule_uuid to get one Alert Rule. Use alert_history for ' +
                'past state transitions.',
            inputSchema: {
                rule_uuid: z
                    .string()
                    .optional()
                    .describe('Only this Alert Rule: its uuid, such as a ruleUuid from an earlier alert_state result.'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => alertState(alerting, config.maxOutputBytes, args),
    );
}
