/**
 * Feature viz-chart-type-wiring: the two native types are wired into the
 * app's chart-type plumbing: they have a name and an icon in content lists,
 * and the image export (an ECharts capture) is not offered for them.
 */
import { ChartKind, ChartType, ResourceViewItemType } from '@lightdash/common';
import { describe, expect, it } from 'vitest';
import { CHART_TYPES_WITHOUT_IMAGE_EXPORT } from '../../components/common/ChartDownload/chartDownloadUtils';
import { getChartIcon } from '../../components/common/ResourceIcon/utils';
import { getResourceTypeName } from '../../components/common/ResourceView/resourceUtils';

const chartItem = (chartKind: ChartKind) =>
    ({
        type: ResourceViewItemType.CHART,
        data: { chartKind },
    }) as unknown as Parameters<typeof getResourceTypeName>[0];

describe('chart type wiring', () => {
    it('names the types in content lists', () => {
        expect(getResourceTypeName(chartItem(ChartKind.LOG_STREAM))).toBe(
            'Log stream',
        );
        expect(getResourceTypeName(chartItem(ChartKind.TRACE_WATERFALL))).toBe(
            'Trace waterfall',
        );
    });

    it('gives each type its own icon', () => {
        const fallback = getChartIcon(undefined);
        expect(getChartIcon(ChartKind.LOG_STREAM)).not.toBe(fallback);
        expect(getChartIcon(ChartKind.TRACE_WATERFALL)).not.toBe(fallback);
        expect(getChartIcon(ChartKind.LOG_STREAM)).not.toBe(
            getChartIcon(ChartKind.TRACE_WATERFALL),
        );
    });

    it('does not offer image export', () => {
        expect(CHART_TYPES_WITHOUT_IMAGE_EXPORT).toContain(ChartType.LOG_STREAM);
        expect(CHART_TYPES_WITHOUT_IMAGE_EXPORT).toContain(
            ChartType.TRACE_WATERFALL,
        );
    });
});
