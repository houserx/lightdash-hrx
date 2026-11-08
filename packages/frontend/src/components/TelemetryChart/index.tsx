import { ChartType, type ChartConfig } from '@lightdash/common';
import { renderChart, type RenderedChart } from '@lightdash/visualization';
import { Box } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { IconFilterOff } from '@tabler/icons-react';
import { memo, useEffect, useMemo, useRef, type FC } from 'react';
import LoadingChart from '../common/LoadingChart';
import SuboptimalState from '../common/SuboptimalState/SuboptimalState';
import {
    isTelemetryVisualizationConfig,
    type VisualizationConfigTelemetry,
} from '../LightdashVisualization/types';
import {
    useVisualizationConfig,
    useVisualizationInputs,
} from '../LightdashVisualization/useVisualizationContext';
import { LogStreamView } from '../LogStream/LogStreamView';
import { TraceWaterfallView } from '../TraceWaterfall/TraceWaterfallView';

/** The log stream's height before its box is measured (and in jsdom). */
const FALLBACK_LOG_STREAM_HEIGHT = 400;

const EMPTY_STATE_TEXT: Record<
    ChartType.LOG_STREAM | ChartType.TRACE_WATERFALL,
    string
> = {
    [ChartType.LOG_STREAM]:
        'Run a logs query, or pick the field that holds each log line in the chart config.',
    [ChartType.TRACE_WATERFALL]:
        'Run a spans query, or pick the field that holds each span id in the chart config.',
};

const toChartConfig = ({
    chartType,
    chartConfig,
}: VisualizationConfigTelemetry): ChartConfig =>
    chartType === ChartType.LOG_STREAM
        ? { type: chartType, config: chartConfig.validConfig }
        : { type: chartType, config: chartConfig.validConfig };

type Props = {
    onScreenshotReady?: () => void;
    onScreenshotError?: () => void;
};

/**
 * Draws a log stream or a trace waterfall: the results go through
 * `@lightdash/visualization`, and its model goes to the view. The same
 * component draws the chart in the explorer and in a dashboard tile.
 */
const TelemetryChart: FC<Props> = memo(
    ({ onScreenshotReady, onScreenshotError }) => {
        const visualizationConfig = useVisualizationConfig();
        const { resultsData, itemsMap, colorPalette, isLoading } =
            useVisualizationInputs();
        const { ref, height } = useElementSize();
        const telemetryConfig = isTelemetryVisualizationConfig(
            visualizationConfig,
        )
            ? visualizationConfig
            : undefined;
        const chartConfig = useMemo(
            () => telemetryConfig && toChartConfig(telemetryConfig),
            [telemetryConfig],
        );

        const rendered: RenderedChart | undefined = useMemo(() => {
            if (!resultsData || !chartConfig) return undefined;
            return renderChart(
                { chartConfig },
                { rows: resultsData.rows, fields: itemsMap ?? {} },
                { colors: { palette: colorPalette } },
            );
        }, [chartConfig, resultsData, itemsMap, colorPalette]);

        // Every line or span of the query, not only the first page
        useEffect(() => {
            resultsData?.setFetchAll(true);
        }, [resultsData]);

        const hasSignaledScreenshotReady = useRef(false);
        useEffect(() => {
            if (hasSignaledScreenshotReady.current) return;
            if (!onScreenshotReady && !onScreenshotError) return;
            if (!isLoading) {
                onScreenshotReady?.();
                hasSignaledScreenshotReady.current = true;
            }
        }, [isLoading, onScreenshotReady, onScreenshotError]);

        if (!telemetryConfig) return null;
        if (isLoading) return <LoadingChart />;

        let content;
        if (rendered?.kind === 'logStream') {
            content = (
                <LogStreamView
                    model={rendered.model}
                    height={height > 0 ? height : FALLBACK_LOG_STREAM_HEIGHT}
                />
            );
        } else if (rendered?.kind === 'traceWaterfall') {
            content = <TraceWaterfallView model={rendered.model} />;
        } else {
            content = (
                <Box py="xl" h="100%">
                    <SuboptimalState
                        title="No data available"
                        description={
                            EMPTY_STATE_TEXT[telemetryConfig.chartType]
                        }
                        icon={IconFilterOff}
                    />
                </Box>
            );
        }

        return (
            <Box ref={ref} h="100%" w="100%" mih="inherit">
                {content}
            </Box>
        );
    },
);

export default TelemetryChart;
