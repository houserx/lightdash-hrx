import {
    type ApiAuditPageResponse,
    type AuditFilters,
    type AuditPage,
} from '@lightdash/common';
import { useCallback } from 'react';
import { useLightdashApi } from '../../../providers/LightdashApi/useLightdashApi';

/**
 * Loads one page of the project's audit store through
 * GET /api/v2/projects/{projectUuid}/federation/audit (CONTRACTS §4.2). Only filters that
 * were given are sent.
 */
export const useAuditBrowserApi = (projectUuid: string | undefined) => {
    const lightdashApi = useLightdashApi();
    return useCallback(
        (query: AuditFilters): Promise<AuditPage> => {
            if (!projectUuid) {
                return Promise.reject(new Error('No project selected'));
            }
            const params = new URLSearchParams();
            Object.entries(query).forEach(([key, value]) => {
                if (typeof value === 'string' && value.trim()) {
                    params.set(key, value.trim());
                }
            });
            const search = params.toString();
            return lightdashApi<ApiAuditPageResponse['results']>({
                url: `/projects/${projectUuid}/federation/audit${
                    search ? `?${search}` : ''
                }`,
                version: 'v2',
                method: 'GET',
                body: undefined,
            });
        },
        [lightdashApi, projectUuid],
    );
};
