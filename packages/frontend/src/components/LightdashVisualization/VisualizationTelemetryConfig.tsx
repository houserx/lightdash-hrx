import { ChartType } from '@lightdash/common';
import { memo, useMemo, type FC } from 'react';
import {
    type VisualizationConfigTelemetry,
    type VisualizationTelemetryConfigProps,
} from './types';

const VisualizationTelemetryConfig: FC<VisualizationTelemetryConfigProps> = ({
    chartConfig,
    children,
}) => {
    const visualizationConfig: VisualizationConfigTelemetry = useMemo(
        () =>
            chartConfig.type === ChartType.LOG_STREAM
                ? {
                      chartType: ChartType.LOG_STREAM,
                      chartConfig: { validConfig: chartConfig.config ?? {} },
                  }
                : {
                      chartType: ChartType.TRACE_WATERFALL,
                      chartConfig: { validConfig: chartConfig.config ?? {} },
                  },
        [chartConfig],
    );

    return children({ visualizationConfig });
};

// Memoised so a resize skips it; an echoed config re-renders it, the memoised aggregate spares consumers
export default memo(VisualizationTelemetryConfig);
