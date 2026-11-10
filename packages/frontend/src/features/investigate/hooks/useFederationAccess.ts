import {
    type ApiFederationAccessResponse,
    type FederationAccess,
} from '@lightdash/common';
import { useQuery } from '@tanstack/react-query';
import { useLightdashApi } from '../../../providers/LightdashApi/useLightdashApi';

/**
 * The current user's federation access on a project: whether it is a Federation Engine project
 * and which ldq claims (platform_read, platform_explain, ...) they hold. The UI uses it only to
 * offer the right actions; the engine enforces every claim itself.
 */
export const useFederationAccess = (
    projectUuid: string | undefined,
    enabled = true,
) => {
    const lightdashApi = useLightdashApi();
    return useQuery<FederationAccess>({
        queryKey: ['federation-access', projectUuid],
        queryFn: () =>
            lightdashApi<ApiFederationAccessResponse['results']>({
                url: `/projects/${projectUuid}/federation/access`,
                version: 'v2',
                method: 'GET',
                body: undefined,
            }),
        enabled: enabled && !!projectUuid,
    });
};
