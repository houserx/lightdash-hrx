import { subject } from '@casl/ability';
import { ChartKind, type VizTableConfig } from '@lightdash/common';
import { useCallback } from 'react';
import { useSpaceSummaries } from '../../../hooks/useSpaces';
import useApp from '../../../providers/App/useApp';
import { DEFAULT_SQL_LIMIT } from '../../sqlRunner/constants';
import { useCreateSqlChartMutation } from '../../sqlRunner/hooks/useSavedSqlCharts';
import { type InvestigateSaveAsChartRequest } from '../components/InvestigateWorkspace';

/** A new chart shows the SQL's result as a table; the SQL runner fills in the columns. */
const INVESTIGATE_CHART_CONFIG: VizTableConfig = {
    metadata: { version: 1 },
    type: ChartKind.TABLE,
    columns: {},
    display: undefined,
};

/**
 * Saves Investigate SQL as a SQL chart in the project. The chart goes to the first space the
 * user can create charts in, the same space the SQL runner's save dialog preselects, and the
 * SQL runner then opens the new chart.
 */
export const useInvestigateSaveAsChart = (projectUuid: string | undefined) => {
    const { user } = useApp();
    const { data: spaces } = useSpaceSummaries(projectUuid, true, {
        select: (data) =>
            data.filter((space) =>
                user.data?.ability.can(
                    'create',
                    subject('SavedChart', {
                        ...space,
                        access: space.userAccess ? [space.userAccess] : [],
                    }),
                ),
            ),
    });
    const { mutateAsync: createSqlChart } = useCreateSqlChartMutation(
        projectUuid ?? '',
    );

    return useCallback(
        async ({ name, sql }: InvestigateSaveAsChartRequest) => {
            if (!projectUuid) throw new Error('No project selected');
            const space = spaces?.[0];
            if (!space) {
                throw new Error(
                    'You have no space you can save charts in. Create one first.',
                );
            }
            await createSqlChart({
                name,
                description: null,
                sql,
                limit: DEFAULT_SQL_LIMIT,
                config: INVESTIGATE_CHART_CONFIG,
                spaceUuid: space.uuid,
            });
        },
        [projectUuid, spaces, createSqlChart],
    );
};
