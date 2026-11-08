import { ChartType, getItemLabelWithoutTableName } from '@lightdash/common';
import { memo, useMemo, type FC } from 'react';
import { isTelemetryVisualizationConfig } from '../../LightdashVisualization/types';
import {
    useVisualizationConfig,
    useVisualizationInputs,
} from '../../LightdashVisualization/useVisualizationContext';
import { LogStreamConfigPanel } from '../LogStreamConfig/LogStreamConfigPanel';
import { TraceWaterfallConfigPanel } from '../TraceWaterfallConfig/TraceWaterfallConfigPanel';

/** The fields of the results a log or span column can bind to, by label. */
const useResultFields = () => {
    const { itemsMap } = useVisualizationInputs();
    return useMemo(
        () =>
            Object.entries(itemsMap ?? {}).map(([id, item]) => ({
                id,
                label: getItemLabelWithoutTableName(item),
            })),
        [itemsMap],
    );
};

/**
 * The config tab of a log stream or trace waterfall: its panel, bound to
 * the explorer's chart config and the query's fields.
 */
export const ConfigTabs: FC = memo(() => {
    const visualizationConfig = useVisualizationConfig();
    const fields = useResultFields();

    if (!isTelemetryVisualizationConfig(visualizationConfig)) return null;

    return visualizationConfig.chartType === ChartType.LOG_STREAM ? (
        <LogStreamConfigPanel
            config={visualizationConfig.chartConfig.validConfig}
            fields={fields}
            onChange={visualizationConfig.chartConfig.setConfig}
        />
    ) : (
        <TraceWaterfallConfigPanel
            config={visualizationConfig.chartConfig.validConfig}
            fields={fields}
            onChange={visualizationConfig.chartConfig.setConfig}
        />
    );
});
