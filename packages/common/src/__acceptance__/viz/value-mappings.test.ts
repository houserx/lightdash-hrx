/**
 * Feature viz-value-mappings: Grafana value mappings (value, range, regex
 * and special) apply to a value the way Grafana applies them.
 */
import { describe, expect, it } from 'vitest';
import { applyValueMappings, type GrafanaValueMapping } from '../../index';

const mappings: GrafanaValueMapping[] = [
    {
        type: 'value',
        options: {
            '0': { text: 'Down', color: 'red', index: 0 },
            '1': { text: 'Up', color: 'green', index: 1 },
        },
    },
    {
        type: 'range',
        options: { from: 10, to: 20, result: { text: 'Busy', index: 2 } },
    },
    {
        type: 'regex',
        options: { pattern: '^api-.*', result: { text: 'API', index: 3 } },
    },
    {
        type: 'special',
        options: { match: 'null', result: { text: 'N/A', index: 4 } },
    },
    {
        type: 'special',
        options: { match: 'nan', result: { text: 'Not a number', index: 5 } },
    },
];

describe('Grafana value mappings', () => {
    it('maps exact values (numbers match their string keys)', () => {
        expect(applyValueMappings(0, mappings)).toMatchObject({ text: 'Down' });
        expect(applyValueMappings('1', mappings)).toMatchObject({ text: 'Up' });
    });

    it('resolves the mapping colour to hex', () => {
        expect(applyValueMappings(0, mappings)!.color!.toUpperCase()).toBe(
            '#F2495C',
        );
    });

    it('maps inclusive ranges', () => {
        expect(applyValueMappings(10, mappings)).toMatchObject({
            text: 'Busy',
        });
        expect(applyValueMappings(20, mappings)).toMatchObject({
            text: 'Busy',
        });
        expect(applyValueMappings(21, mappings)).toBeUndefined();
    });

    it('maps regex matches on the text value', () => {
        expect(applyValueMappings('api-gateway', mappings)).toMatchObject({
            text: 'API',
        });
    });

    it('maps null and NaN specials', () => {
        expect(applyValueMappings(null, mappings)).toMatchObject({
            text: 'N/A',
        });
        expect(applyValueMappings(Number.NaN, mappings)).toMatchObject({
            text: 'Not a number',
        });
    });

    it('returns undefined when nothing matches', () => {
        expect(applyValueMappings(5, mappings)).toBeUndefined();
        expect(applyValueMappings(5, [])).toBeUndefined();
    });

    it('applies the first matching mapping by index', () => {
        const overlapping: GrafanaValueMapping[] = [
            {
                type: 'range',
                options: { from: 0, to: 100, result: { text: 'Late', index: 1 } },
            },
            {
                type: 'value',
                options: { '5': { text: 'Early', index: 0 } },
            },
        ];
        expect(applyValueMappings(5, overlapping)).toMatchObject({
            text: 'Early',
        });
    });
});
