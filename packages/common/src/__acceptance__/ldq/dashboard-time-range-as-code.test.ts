// ldq-dashboard-time-range-as-code: dashboard-as-code YAML carries the Dashboard Time Range,
// with tile time dimensions keyed by tile slug so the file is portable.
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const schemaPath = path.resolve(
    __dirname,
    '../../schemas/json/dashboard-as-code-1.0.json',
);

const compile = () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    return ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
};

const base = {
    name: 'Service health',
    slug: 'service-health',
    spaceSlug: 'operations',
    version: 1,
    tabs: [],
    tiles: [],
};

describe('dashboard-as-code timeRange', () => {
    it('accepts a relative range with refresh and tile time dimensions', () => {
        const validate = compile();
        const ok = validate({
            ...base,
            timeRange: {
                from: 'now-6h',
                to: 'now',
                refreshInterval: '30s',
                tileTimeDimensions: {
                    'orders-per-hour': {
                        fieldId: 'orders_created_at',
                        tableName: 'orders',
                    },
                },
            },
        });
        expect(validate.errors ?? []).toEqual([]);
        expect(ok).toBe(true);
    });

    it('accepts an absolute range with refresh off', () => {
        const validate = compile();
        expect(
            validate({
                ...base,
                timeRange: {
                    from: '2026-11-01T00:00:00.000Z',
                    to: '2026-11-02T00:00:00.000Z',
                    refreshInterval: null,
                    tileTimeDimensions: {},
                },
            }),
        ).toBe(true);
    });

    it('rejects a refresh interval outside the options', () => {
        const validate = compile();
        expect(
            validate({
                ...base,
                timeRange: {
                    from: 'now-6h',
                    to: 'now',
                    refreshInterval: '2m',
                    tileTimeDimensions: {},
                },
            }),
        ).toBe(false);
    });
});
