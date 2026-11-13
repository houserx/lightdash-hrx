import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertingError, alertingPath, createAlertingClient } from './alerting.js';

const PROJECT = '5c0f8d2e-6b7a-4c1d-9e8f-0a1b2c3d4e5f';
const LIGHTDASH = { url: 'http://lightdash.test', apiToken: 'svc-token-not-real', projectUuid: PROJECT };

function stubFetch(respond: () => Response | Promise<Response>) {
    const calls: { url: URL; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL, init?: RequestInit) => {
            calls.push({ url: new URL(String(input)), headers: { ...(init?.headers as Record<string, string>) } });
            return respond();
        }),
    );
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('alertingPath', () => {
    it('builds the project alerting path and skips undefined query values', () => {
        expect(alertingPath(PROJECT, 'state')).toBe(`/api/v2/projects/${PROJECT}/alerting/state`);
        expect(alertingPath(PROJECT, 'history', { ruleUuid: 'r', from: undefined, limit: '5' })).toBe(
            `/api/v2/projects/${PROJECT}/alerting/history?ruleUuid=r&limit=5`,
        );
    });
});

describe('createAlertingClient', () => {
    it('GETs with the service-account token and returns results untouched', async () => {
        const results = [{ ruleUuid: 'x', state: 'firing', extra: { kept: true } }];
        const calls = stubFetch(() => Response.json({ status: 'ok', results }));
        await expect(createAlertingClient(LIGHTDASH).get('state', { ruleUuid: 'x' })).resolves.toEqual(results);
        expect(calls[0]?.url.pathname).toBe(`/api/v2/projects/${PROJECT}/alerting/state`);
        expect(calls[0]?.url.searchParams.get('ruleUuid')).toBe('x');
        expect(calls[0]?.headers.Authorization).toBe('ApiKey svc-token-not-real');
    });

    it('turns an HTTP error into an AlertingError with the status and message, never the token', async () => {
        stubFetch(() =>
            Response.json(
                { status: 'error', error: { statusCode: 503, message: 'down; token svc-token-not-real' } },
                { status: 503 },
            ),
        );
        const err = await createAlertingClient(LIGHTDASH).get('state').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AlertingError);
        expect((err as Error).message).toContain('HTTP 503: down');
        expect((err as Error).message).not.toContain('svc-token-not-real');
    });

    it('reports an unreachable Lightdash and a non-envelope body', async () => {
        stubFetch(() => {
            throw new TypeError('fetch failed');
        });
        await expect(createAlertingClient(LIGHTDASH).get('state')).rejects.toThrow(/could not reach Lightdash/);
        stubFetch(() => new Response('<html>', { status: 200 }));
        await expect(createAlertingClient(LIGHTDASH).get('state')).rejects.toThrow(/unexpected response/);
    });
});
