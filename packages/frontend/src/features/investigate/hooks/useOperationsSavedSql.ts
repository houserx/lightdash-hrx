import {
    ChartSourceType,
    ContentType,
    type ApiChartContentResponse,
} from '@lightdash/common';
import { useMemo } from 'react';
import { useLightdashApi } from '../../../providers/LightdashApi/useLightdashApi';
import { fetchSavedSqlChart } from '../../sqlRunner/hooks/useSavedSqlCharts';
import { type SavedSqlLoaders } from '../components/InvestigateWorkspace';
import { type SavedSqlItem } from '../components/SavedSqlPicker';

const PAGE_SIZE = 100;
/** The list stops after this many pages (1,000 charts); the picker searches what it has. */
const MAX_PAGES = 10;

/**
 * Reads the shared saved SQL of the Operations Project, the federation project Investigate runs
 * on: the SQL charts in the spaces the user can see, through the content API. A chart's SQL is
 * read only when the user opens it.
 */
export const useOperationsSavedSql = (
    projectUuid: string | undefined,
): SavedSqlLoaders => {
    const lightdashApi = useLightdashApi();
    return useMemo(
        () => ({
            loadItems: async (): Promise<SavedSqlItem[]> => {
                if (!projectUuid) throw new Error('No project selected');
                const items: SavedSqlItem[] = [];
                for (let page = 1; page <= MAX_PAGES; page += 1) {
                    const params = new URLSearchParams({
                        projectUuids: projectUuid,
                        contentTypes: ContentType.CHART,
                        pageSize: String(PAGE_SIZE),
                        page: String(page),
                        sortBy: 'name',
                        sortDirection: 'asc',
                    });
                    // eslint-disable-next-line no-await-in-loop
                    const { data, pagination } = await lightdashApi<
                        ApiChartContentResponse['results']
                    >({
                        version: 'v2',
                        url: `/content?${params.toString()}`,
                        method: 'GET',
                        body: undefined,
                    });
                    data.filter(
                        (chart) => chart.source === ChartSourceType.SQL,
                    ).forEach((chart) =>
                        items.push({
                            uuid: chart.uuid,
                            name: chart.name,
                            description: chart.description,
                            spaceName: chart.space.name,
                        }),
                    );
                    if (!pagination || page >= pagination.totalPageCount) {
                        break;
                    }
                }
                return items;
            },
            loadSql: async (item: SavedSqlItem): Promise<string> => {
                if (!projectUuid) throw new Error('No project selected');
                const chart = await fetchSavedSqlChart(lightdashApi, {
                    projectUuid,
                    uuid: item.uuid,
                });
                return chart.sql;
            },
        }),
        [lightdashApi, projectUuid],
    );
};
