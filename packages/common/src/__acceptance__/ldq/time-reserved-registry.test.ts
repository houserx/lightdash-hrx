// ldq-time-reserved-parameters: __from, __to, __interval and __range ride Lightdash's
// reserved-parameter pipeline, so `${ld.parameters.__from}` compiles like any parameter.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

const now = new Date('2026-11-08T10:37:43.512Z');

describe('reserved time parameters', () => {
    it('registers the four names as reserved', () => {
        const names: string[] = common.getReservedParameterNames();
        expect(names).toEqual(
            expect.arrayContaining([
                'date_zoom',
                '__from',
                '__to',
                '__interval',
                '__range',
            ]),
        );
        expect(common.isReservedParameterName('__from')).toBe(true);
        expect(common.isReservedParameterName('__range')).toBe(true);
    });

    it('resolves them from a time range in the reserved context', () => {
        const values = common.resolveReservedParameterValues({
            dateZoom: undefined,
            timeRange: { from: 'now-6h', to: 'now' },
            refreshInterval: '1m',
            now,
        });
        expect(values).toMatchObject({
            date_zoom: '',
            __from: '2026-11-08T04:37:00.000Z',
            __to: '2026-11-08T10:37:00.000Z',
            __interval: '30s',
            __range: '6h',
        });
    });

    it('lets a user parameter of the same name win', () => {
        const merged = common.mergeReservedValues(
            { __from: '2020-01-01T00:00:00.000Z' },
            common.resolveReservedParameterValues({
                dateZoom: undefined,
                timeRange: { from: 'now-6h', to: 'now' },
                now,
            }),
        );
        expect(merged.__from).toBe('2020-01-01T00:00:00.000Z');
        expect(merged.__to).toBe('2026-11-08T10:37:40.000Z');
    });

    it('finds the references in telemetry SQL', () => {
        expect(
            common
                .getParameterReferences(
                    "SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})",
                )
                .sort(),
        ).toEqual(['__from', '__interval', '__to']);
    });
});
