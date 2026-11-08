import {
    type ApiWriteConfirmationRequest,
    type ApiWriteConfirmationResponse,
    type ApiWriteRequest,
    type ApiWriteResponse,
} from '@lightdash/common';
import { useMemo } from 'react';
import { useLightdashApi } from '../../../providers/LightdashApi/useLightdashApi';
import { type WriteModeApi } from '../components/WriteModePanel';

/**
 * Write Mode's API on a project: the confirmation and write routes (CONTRACTS §4.2). Neither
 * goes through the async query API.
 */
export const useWriteModeApi = (
    projectUuid: string | undefined,
): WriteModeApi => {
    const lightdashApi = useLightdashApi();
    return useMemo(() => {
        const projectPath = () => {
            if (!projectUuid) throw new Error('No project selected');
            return `/projects/${projectUuid}/write`;
        };
        return {
            createConfirmation: (statement: string) => {
                const body: ApiWriteConfirmationRequest = { statement };
                return lightdashApi<ApiWriteConfirmationResponse['results']>({
                    url: `${projectPath()}/confirmations`,
                    version: 'v2',
                    method: 'POST',
                    body: JSON.stringify(body),
                });
            },
            write: (request: ApiWriteRequest) =>
                lightdashApi<ApiWriteResponse['results']>({
                    url: projectPath(),
                    version: 'v2',
                    method: 'POST',
                    body: JSON.stringify(request),
                }),
        };
    }, [lightdashApi, projectUuid]);
};
