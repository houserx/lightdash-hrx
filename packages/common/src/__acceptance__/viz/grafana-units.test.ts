/**
 * Feature viz-grafana-unit-formats: the Grafana unit names the dashboards
 * use map onto Lightdash number formats, and values format the way a
 * Grafana user expects.
 */
import { describe, expect, it } from 'vitest';
import {
    applyCustomFormat,
    CustomFormatType,
    grafanaUnitToCustomFormat,
} from '../../index';

const fmt = (unit: string, value: number, decimals?: number) => {
    const format = grafanaUnitToCustomFormat(unit, { decimals });
    expect(format, unit).toBeDefined();
    return applyCustomFormat(value, format!);
};

describe('Grafana units as Lightdash formats', () => {
    // Lightdash byte formats need an explicit compact unit and don't
    // auto-scale like Grafana; the mapping doc lists that gap. Only the
    // format family is checked here.
    it.each([
        ['bytes', CustomFormatType.BYTES_IEC],
        ['decbytes', CustomFormatType.BYTES_SI],
        ['Bps', CustomFormatType.BYTES_IEC],
    ])('maps %s to the %s format family', (unit, type) => {
        expect(grafanaUnitToCustomFormat(unit)!.type).toBe(type);
    });

    it('treats percentunit as a 0-1 ratio and percent as 0-100', () => {
        expect(fmt('percentunit', 0.42, 0)).toMatch(/^42\s?%$/);
        expect(fmt('percent', 42, 0)).toMatch(/^42\s?%$/);
    });

    it.each([
        ['s', 30, /^30(\.0+)?\s?s$/],
        ['ms', 250, /^250(\.0+)?\s?ms$/],
        ['reqps', 12, /^12(\.0+)?\s?req\/s$/],
        ['ops', 7, /^7(\.0+)?\s?ops\/s$/],
    ])('formats %s', (unit, value, expected) => {
        expect(fmt(unit, value as number)).toMatch(expected as RegExp);
    });

    it('honours decimals', () => {
        expect(fmt('ms', 12.3456, 1)).toMatch(/^12\.3\s?ms$/);
    });

    it.each(['short', 'none'])('keeps %s as a plain number', (unit) => {
        const format = grafanaUnitToCustomFormat(unit);
        expect(format).toBeDefined();
        expect([CustomFormatType.NUMBER, CustomFormatType.DEFAULT]).toContain(
            format!.type,
        );
    });

    it('keeps a free-text unit as a suffix', () => {
        expect(fmt('vCPU', 4, 0)).toMatch(/^4\s?vCPU$/);
    });
});
