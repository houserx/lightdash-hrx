import { useCallback } from 'react';
import { useLightdashApi } from '../../../providers/LightdashApi/useLightdashApi';
import { executeSqlQuery } from '../../queryRunner/executeQuery';
import {
    type InvestigateQueryResult,
    type InvestigateRunRequest,
} from '../components/InvestigateWorkspace';

/**
 * Runs Investigate SQL through the project's async SQL query API, sending the time range that
 * resolves the reserved time parameters and, for an Audited Query, its description and ticket.
 */
export const useInvestigateRunQuery = (projectUuid: string | undefined) => {
    const lightdashApi = useLightdashApi();
    return useCallback(
        async ({
            sql,
            timeRange,
            audit,
        }: InvestigateRunRequest): Promise<InvestigateQueryResult> => {
            if (!projectUuid) throw new Error('No project selected');
            const { columns, results } = await executeSqlQuery(
                lightdashApi,
                projectUuid,
                sql,
                undefined,
                undefined,
                undefined,
                undefined,
                { timeRange, audit },
            );
            return {
                columns: columns.map((column) => column.reference),
                rows: results,
            };
        },
        [lightdashApi, projectUuid],
    );
};
