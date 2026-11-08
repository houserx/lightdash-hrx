/** A span status that means the span failed: OpenTelemetry's `error` (any case) or its `STATUS_CODE_ERROR` name. */
export const isErrorStatus = (status: string): boolean => {
    const normalised = status.trim().toLowerCase();
    return normalised === 'error' || normalised === 'status_code_error';
};

/** Up to two decimals, without trailing zeros. */
const trimmed = (value: number): string => String(Number(value.toFixed(2)));

/** A duration in milliseconds as `50 ms`, or `1.25 s` from one second up. */
export const formatDurationMs = (ms: number): string => {
    if (!Number.isFinite(ms)) return '';
    if (Math.abs(ms) >= 1000) return `${trimmed(ms / 1000)} s`;
    return `${trimmed(ms)} ms`;
};

/** `part` as a CSS percentage of `whole`, kept between 0% and 100%; 0% for an empty whole. */
export const percentOf = (part: number, whole: number): string => {
    if (!(whole > 0) || !Number.isFinite(part)) return '0%';
    const share = Math.min(Math.max(part / whole, 0), 1);
    return `${Number((share * 100).toFixed(4))}%`;
};
