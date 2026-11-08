import {
    ChartType,
    type LogStreamChart,
    type TraceWaterfallChart,
} from '@lightdash/common';
import { memo, useMemo, type FC } from 'react';
import {
    type VisualizationConfigTelemetry,
    type VisualizationTelemetryConfigProps,
} from './types';

/**
 * The log stream and trace waterfall keep no editor state: the saved config
 * is the whole state, so the adapter exposes the prop and hands every edit
 * to the owner, whose echoed prop is the next config.
 */
const VisualizationTelemetryConfig: FC<VisualizationTelemetryConfigProps> = ({
    chartConfig,
    onChartConfigChange,
    children,
}) => {
    const visualizationConfig: VisualizationConfigTelemetry = useMemo(
        () =>
            chartConfig.type === ChartType.LOG_STREAM
                ? {
                      chartType: ChartType.LOG_STREAM,
                      chartConfig: {
                          validConfig: chartConfig.config ?? {},
                          setConfig: (config: LogStreamChart) =>
                              onChartConfigChange?.({
                                  type: ChartType.LOG_STREAM,
                                  config,
                              }),
                      },
                  }
                : {
                      chartType: ChartType.TRACE_WATERFALL,
                      chartConfig: {
                          validConfig: chartConfig.config ?? {},
                          setConfig: (config: TraceWaterfallChart) =>
                              onChartConfigChange?.({
                                  type: ChartType.TRACE_WATERFALL,
                                  config,
                              }),
                      },
                  },
        [chartConfig, onChartConfigChange],
    );

    return children({ visualizationConfig });
};

// Memoised so a resize skips it; an echoed config re-renders it, the memoised aggregate spares consumers
export default memo(VisualizationTelemetryConfig);
