/**
 * Trace waterfall chart (ENG-1799): a native chart type that shows the spans
 * of a trace from a Telemetry Source, one row per span.
 */
export type TraceWaterfallChart = {
    /** Field id of the trace id column */
    traceIdFieldId?: string;
    /** Field id of the span id column */
    spanIdFieldId?: string;
    /** Field id of the parent span id column */
    parentSpanIdFieldId?: string;
    /** Field id of the service name column */
    serviceFieldId?: string;
    /** Field id of the span name column */
    nameFieldId?: string;
    /** Field id of the span start time column */
    startFieldId?: string;
    /** Field id of the span duration column, in milliseconds */
    durationMsFieldId?: string;
    /** Field id of the span status column */
    statusFieldId?: string;
    /** Field id of the span attributes column (a JSON object) */
    attributesFieldId?: string;
};
