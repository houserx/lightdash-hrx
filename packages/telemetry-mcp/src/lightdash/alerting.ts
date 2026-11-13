/**
 * The Lightdash alerting API for the Operations Project (Contract assumption 2; the alerting line owns the shape):
 * `GET /api/v2/projects/{LIGHTDASH_PROJECT_UUID}/alerting/state|history`, called with the service-account token
 * (`Authorization: ApiKey <LIGHTDASH_API_TOKEN>`; alert state is not PHI). It answers the standard
 * `{ status: "ok", results }` envelope, and `results` is passed through untouched.
 *
 * A failed call becomes an `AlertingError` whose message names the HTTP status and Lightdash's own error message,
 * with the service token and any token-shaped string removed (`redactSecrets`).
 */
import type { Config } from '../config.js';
import { redactSecrets } from '../engine/errors.js';
import { LIGHTDASH_TIMEOUT_MS } from '../auth/userMapping.js';

export type AlertingKind = 'state' | 'history';

/** A failed alerting call. The message is safe to show to the MCP client. */
export class AlertingError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'AlertingError';
    }
}

export type AlertingQuery = Record<string, string | undefined>;

export interface AlertingClient {
    /** The `results` of `GET /api/v2/projects/{uuid}/alerting/{kind}`; undefined query values are not sent. */
    get(kind: AlertingKind, query?: AlertingQuery): Promise<unknown>;
}

/** The path and query string for one alerting call. */
export function alertingPath(projectUuid: string, kind: AlertingKind, query: AlertingQuery = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value);
    const search = params.toString();
    return `/api/v2/projects/${encodeURIComponent(projectUuid)}/alerting/${kind}${search ? `?${search}` : ''}`;
}

/** Lightdash's error message from its `{ status: "error", error: { message } }` envelope, if there is one. */
function lightdashErrorMessage(body: unknown): string | undefined {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    return typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined;
}

export function createAlertingClient(lightdash: Config['lightdash']): AlertingClient {
    const safe = (text: string) => redactSecrets(text, [lightdash.apiToken]);
    return {
        async get(kind, query) {
            const what = `The Lightdash alerting ${kind} request`;
            let response: Response;
            try {
                response = await fetch(`${lightdash.url}${alertingPath(lightdash.projectUuid, kind, query)}`, {
                    headers: { Authorization: `ApiKey ${lightdash.apiToken}`, Accept: 'application/json' },
                    signal: AbortSignal.timeout(LIGHTDASH_TIMEOUT_MS),
                });
            } catch (err) {
                throw new AlertingError(`${what} failed: could not reach Lightdash`, { cause: err });
            }
            const body: unknown = await response.json().catch(() => undefined);
            if (!response.ok) {
                const message = lightdashErrorMessage(body);
                throw new AlertingError(
                    safe(`${what} failed with HTTP ${response.status}${message ? `: ${message}` : ''}`),
                );
            }
            const envelope = body as { status?: unknown; results?: unknown } | undefined;
            if (envelope?.status !== 'ok' || !('results' in envelope)) {
                throw new AlertingError(`${what} failed: Lightdash sent an unexpected response`);
            }
            return envelope.results;
        },
    };
}
