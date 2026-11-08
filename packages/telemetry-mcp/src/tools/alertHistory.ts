/**
 * `alert_history` (CONTRACTS §7): Alert Rule state transitions in the Operations Project, from
 * `GET /api/v2/projects/{LIGHTDASH_PROJECT_UUID}/alerting/history` with the service-account token. The optional
 * `rule_uuid`, `from`, `to` and `limit` are checked before Lightdash is called and are sent as `ruleUuid`, `from`,
 * `to` (absolute ISO-8601, resolved against the server clock) and `limit`. The result is
 * `{ results: <Lightdash results> }`, untouched; a result over `MCP_MAX_OUTPUT_BYTES` is a tool error.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { UUID_RE, type Config } from '../config.js';
import { AlertingError, type AlertingClient, type AlertingQuery } from '../lightdash/alerting.js';
import { alertingResult } from './alertState.js';
import { errorResult, isoParam, parseInstant, ToolInputError } from './telemetryArgs.js';

export const ALERT_HISTORY_TOOL = 'alert_history';

/** The most transitions one call may ask for (Contract assumption: the contract gives no bound). */
export const ALERT_HISTORY_MAX_LIMIT = 1000;

export interface AlertHistoryArgs {
    rule_uuid?: string;
    from?: string;
    to?: string;
    limit?: number;
}

/** The Lightdash query for valid arguments, or a `ToolInputError` for arguments that must not be sent. */
export function buildAlertHistoryQuery(args: AlertHistoryArgs, now: number): AlertingQuery {
    const { rule_uuid: ruleUuid, limit } = args;
    if (ruleUuid !== undefined && !UUID_RE.test(ruleUuid)) {
        throw new ToolInputError('rule_uuid must be an Alert Rule uuid, such as a ruleUuid from alert_state');
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > ALERT_HISTORY_MAX_LIMIT)) {
        throw new ToolInputError(`limit must be a whole number from 1 to ${ALERT_HISTORY_MAX_LIMIT}`);
    }
    const from = args.from === undefined ? undefined : parseInstant('from', args.from, now);
    const to = args.to === undefined ? undefined : parseInstant('to', args.to, now);
    if (from !== undefined && to !== undefined && to < from) {
        throw new ToolInputError('to must not be before from');
    }
    return {
        ruleUuid,
        from: from === undefined ? undefined : isoParam(from),
        to: to === undefined ? undefined : isoParam(to),
        limit: limit === undefined ? undefined : String(limit),
    };
}

export async function alertHistory(
    alerting: AlertingClient,
    maxBytes: number,
    args: AlertHistoryArgs,
    now: number,
): Promise<CallToolResult> {
    try {
        const query = buildAlertHistoryQuery(args, now);
        const results = await alerting.get('history', query);
        return alertingResult(results, maxBytes, 'Pass rule_uuid, a narrower from/to range or a lower limit.');
    } catch (err) {
        if (err instanceof ToolInputError || err instanceof AlertingError) return errorResult(err.message);
        return errorResult('The Lightdash alerting history request failed: unexpected error');
    }
}

export function registerAlertHistory(
    server: McpServer,
    config: Config,
    alerting: AlertingClient,
    now: () => number,
): void {
    server.registerTool(
        ALERT_HISTORY_TOOL,
        {
            title: 'Alert history',
            description:
                'Returns past state transitions of the Alert Rules in the Lightdash Operations Project, as recorded ' +
                'by Lightdash alerting: each transition with its ruleUuid, series labels, the state it left and ' +
                'entered (normal, pending, firing, resolved, nodata or error) and when. Filter by rule_uuid and a ' +
                'from/to time range, and cap the count with limit. Use alert_state for the current state.',
            inputSchema: {
                rule_uuid: z
                    .string()
                    .optional()
                    .describe('Only this Alert Rule: its uuid, such as a ruleUuid from alert_state.'),
                from: z
                    .string()
                    .optional()
                    .describe('Only transitions at or after this time: an ISO-8601 time such as ' +
                            '2026-11-08T10:00:00Z, or now or now-<duration> such as now-1d, resolved against the ' +
                            'server clock.'),
                to: z
                    .string()
                    .optional()
                    .describe('Only transitions at or before this time, not before from: an ISO-8601 time, now, ' +
                            'or now-<duration>.'),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(ALERT_HISTORY_MAX_LIMIT)
                    .optional()
                    .describe(`The most transitions to return, from 1 to ${ALERT_HISTORY_MAX_LIMIT}. ` +
                            'Defaults to the Lightdash default.'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => alertHistory(alerting, config.maxOutputBytes, args, now()),
    );
}
