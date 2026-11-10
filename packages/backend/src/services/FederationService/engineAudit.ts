/**
 * CONTRACTS §4.2 audit browser plumbing for FederationService: filter validation and the call
 * to the Federation Engine's GET /v1/audit.
 */
import {
    ParameterError,
    type AuditFilters,
    type AuditPage,
} from '@lightdash/common';
import { requestEngine } from './engineHttp';

const ENGINE_AUDIT_TIMEOUT_MS = 30_000;

const AUDIT_FILTER_KEYS = ['ticket', 'user', 'month', 'cursor'] as const;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Validates the audit filters. Only filters that were given (non-blank after trimming) are
 * kept, so the engine never sees an empty filter. `month` must be YYYY-MM with a real month.
 */
export const parseAuditFilters = (filters: AuditFilters): AuditFilters => {
    const parsed: AuditFilters = {};
    AUDIT_FILTER_KEYS.forEach((key) => {
        const value: unknown = filters[key];
        if (value === undefined || value === null) return;
        if (typeof value !== 'string') {
            throw new ParameterError(`${key} must be a string`);
        }
        const trimmed = value.trim();
        if (trimmed !== '') parsed[key] = trimmed;
    });
    if (parsed.month !== undefined && !MONTH_PATTERN.test(parsed.month)) {
        throw new ParameterError('month must be in the form YYYY-MM');
    }
    return parsed;
};

/** GETs a page of the engine's /v1/audit with exactly the given filters. */
export const getEngineAudit = async (
    httpBaseUrl: string,
    identityToken: string,
    filters: AuditFilters,
): Promise<AuditPage> =>
    (await requestEngine({
        httpBaseUrl,
        identityToken,
        method: 'GET',
        path: '/v1/audit',
        query: filters as Record<string, string>,
        timeoutMs: ENGINE_AUDIT_TIMEOUT_MS,
        label: 'audit',
    })) as AuditPage;
