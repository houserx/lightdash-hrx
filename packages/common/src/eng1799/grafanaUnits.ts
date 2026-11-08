import { Compact, CustomFormatType, type CustomFormat } from '../types/field';

/**
 * Grafana panel units (`fieldConfig.defaults.unit`) as Lightdash number
 * formats (`CustomFormat`).
 *
 * Known gaps, where Lightdash renders differently from Grafana:
 * - Grafana auto-scales byte, time and rate units (1536 bytes -> 1.5 KiB,
 *   1500 ms -> 1.5 s). Lightdash byte formats need an explicit compact unit
 *   and time/rate formats are a fixed suffix, so values keep the panel's
 *   base unit (raw bytes, ms, req/s).
 * - Byte-rate units (`Bps`, `binBps`, `decBps`) map to the byte format
 *   family; Lightdash byte formats have no suffix, so the "/s" is lost.
 * - `short` maps to Lightdash's auto compact (K, M, B, T), which stops at
 *   trillions where Grafana continues (Quadrillion, ...).
 * - Any unit not listed here is shown as a free-text suffix, as Grafana
 *   does for a unit it does not recognise.
 */

export type GrafanaUnitFormatOptions = {
    /** The panel's `fieldConfig.defaults.decimals`; unset means automatic. */
    decimals?: number | null;
};

type UnitFormat = Omit<CustomFormat, 'round'>;

const suffix = (text: string): UnitFormat => ({
    type: CustomFormatType.NUMBER,
    suffix: text,
});

const GRAFANA_UNIT_FORMATS: Record<string, UnitFormat> = {
    // Misc
    none: { type: CustomFormatType.NUMBER },
    short: { type: CustomFormatType.NUMBER, compact: Compact.AUTO },
    percent: suffix('%'),
    percentunit: { type: CustomFormatType.PERCENT },
    // Data (IEC = 1024, SI = 1000)
    bytes: { type: CustomFormatType.BYTES_IEC },
    decbytes: { type: CustomFormatType.BYTES_SI },
    // Data rate
    Bps: { type: CustomFormatType.BYTES_IEC },
    binBps: { type: CustomFormatType.BYTES_IEC },
    decBps: { type: CustomFormatType.BYTES_SI },
    bps: suffix(' b/s'),
    pps: suffix(' p/s'),
    // Time
    ns: suffix(' ns'),
    µs: suffix(' µs'),
    us: suffix(' µs'),
    ms: suffix(' ms'),
    s: suffix(' s'),
    m: suffix(' min'),
    h: suffix(' hour'),
    d: suffix(' day'),
    // Throughput
    reqps: suffix(' req/s'),
    reqpm: suffix(' req/min'),
    ops: suffix(' ops/s'),
    opm: suffix(' ops/min'),
    rps: suffix(' rd/s'),
    wps: suffix(' wr/s'),
    iops: suffix(' io/s'),
    cps: suffix(' c/s'),
    // Date & time (values are epoch milliseconds)
    dateTimeAsIso: { type: CustomFormatType.TIMESTAMP },
    dateTimeAsSystem: { type: CustomFormatType.TIMESTAMP },
    dateTimeAsUS: { type: CustomFormatType.TIMESTAMP },
    // Currency
    currencyUSD: { type: CustomFormatType.CURRENCY, currency: 'USD' },
    currencyGBP: { type: CustomFormatType.CURRENCY, currency: 'GBP' },
    currencyEUR: { type: CustomFormatType.CURRENCY, currency: 'EUR' },
};

/** Grafana's custom-unit prefixes: `suffix:<text>` and `prefix:<text>`. */
const customUnitFormat = (unit: string): UnitFormat | undefined => {
    const match = /^(suffix|prefix):(.*)$/.exec(unit);
    if (!match) return undefined;
    const [, kind, text] = match;
    return kind === 'prefix'
        ? { type: CustomFormatType.NUMBER, prefix: text }
        : { type: CustomFormatType.NUMBER, suffix: text };
};

/**
 * The Lightdash number format for a Grafana unit, or `undefined` when the
 * panel sets no unit (keep the field's own format). `decimals` becomes the
 * format's rounding; unset keeps Lightdash's automatic decimals.
 */
export const grafanaUnitToCustomFormat = (
    unit: string | null | undefined,
    options: GrafanaUnitFormatOptions = {},
): CustomFormat | undefined => {
    const trimmed = unit?.trim();
    if (!trimmed) return undefined;

    const known = Object.prototype.hasOwnProperty.call(
        GRAFANA_UNIT_FORMATS,
        trimmed,
    )
        ? GRAFANA_UNIT_FORMATS[trimmed]
        : undefined;
    const base = known ?? customUnitFormat(trimmed) ?? suffix(` ${trimmed}`);

    const { decimals } = options;
    if (
        decimals === null ||
        decimals === undefined ||
        !Number.isFinite(decimals)
    ) {
        return { ...base };
    }
    return { ...base, round: Math.max(0, Math.round(decimals)) };
};
