/**
 * The ENG-1799 e2e harness: what the protected checks in ../acceptance reach through
 * `harness()` in support.ts. The API is described in PROGRESS.md ("Harness API").
 *
 * Rule for every later addition: load the telemetry MCP server (packages/telemetry-mcp) and the
 * Lightdash backend app ONLY lazily, with a dynamic `await import(...)` inside the function that
 * starts them (startTelemetryMcp, startLightdash). Never import them statically here or from a
 * module this file imports statically: a broken or slow import there must not break the early
 * harness checks (engine, fakes, Platform Database).
 */
export {
    AUDIT_INTEGRITY_KEY,
    ENGINE_BINARY,
    IDENTITY_SECRET,
    startEngine,
} from './engine';
export type { Engine, StartEngineOptions } from './engine';
export { startFakeAuditStore } from './auditStore';
export type { FakeAuditStore } from './auditStore';
export { startPlatformDatabase } from './platform';
export type { PlatformDatabase } from './platform';
export type { FakeServer, RecordedRequest } from './fakeServer';
export { startFakeLoki } from './loki';
export type {
    FakeLoki,
    LokiSeries,
    LokiStream,
    StartFakeLokiOptions,
} from './loki';
export { startFakeCloudWatch } from './cloudwatch';
export type {
    CloudWatchMetric,
    FakeCloudWatch,
    MetricDataQuery,
    StartFakeCloudWatchOptions,
} from './cloudwatch';
export { startFakeCloudWatchLogs } from './cloudwatchLogs';
export type {
    CloudWatchLogsResult,
    CloudWatchLogsStartQuery,
    FakeCloudWatchLogs,
    StartFakeCloudWatchLogsOptions,
} from './cloudwatchLogs';
export { startFakeTempo } from './tempo';
export type {
    FakeTempo,
    StartFakeTempoOptions,
    TempoAttributeValue,
    TempoSpan,
    TempoTrace,
} from './tempo';
export { startFakePrometheus } from './prometheus';
export type {
    FakePrometheus,
    PrometheusSeries,
    StartFakePrometheusOptions,
} from './prometheus';
export { engineSources } from './engine';
export type { EngineSource } from './engine';
export { OKTA_AUDIENCE, startFakeOkta } from './okta';
export type { FakeOkta, MintAccessTokenOptions } from './okta';
export { startFakeLightdashApi } from './lightdashApi';
export type {
    FakeLightdashApi,
    FakeLightdashUser,
    StartFakeLightdashApiOptions,
} from './lightdashApi';
// Loads packages/telemetry-mcp only inside startTelemetryMcp (dynamic import).
export { MCP_PUBLIC_URL, startTelemetryMcp } from './telemetryMcp';
export type { StartTelemetryMcpOptions, TelemetryMcp } from './telemetryMcp';
