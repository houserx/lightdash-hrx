import { describe, expect, it } from 'vitest';
import { alertGroupKey, alertGroupLabels } from './routingGrouping';
import { routeAlert } from './routingTree';

const diskDb1 = { alertname: 'Disk almost full', instance: 'db-1' };
const diskDb2 = { alertname: 'Disk almost full', instance: 'db-2' };

describe('alertGroupLabels', () => {
    it('keeps only the group_by labels, sorted, without missing or empty ones', () => {
        expect(
            alertGroupLabels(
                { groupBy: ['team', 'alertname', 'region', 'env'] },
                { team: 'db', alertname: 'x', env: '', other: 'y' },
            ),
        ).toEqual({ alertname: 'x', team: 'db' });
    });
    it("uses every label for '...' and none for []", () => {
        expect(alertGroupLabels({ groupBy: ['...'] }, diskDb1)).toEqual(
            diskDb1,
        );
        expect(
            alertGroupLabels({ groupBy: ['alertname', '...'] }, diskDb1),
        ).toEqual(diskDb1);
        expect(alertGroupLabels({ groupBy: [] }, diskDb1)).toEqual({});
    });
});

describe('alertGroupKey', () => {
    it('puts alerts with the same group_by values in one group', () => {
        const route = { id: 'root', groupBy: ['alertname'] };
        expect(alertGroupKey(route, diskDb1)).toBe(
            'root:{alertname="Disk almost full"}',
        );
        expect(alertGroupKey(route, diskDb1)).toBe(
            alertGroupKey(route, diskDb2),
        );
    });
    it("splits every label set with '...' and none with []", () => {
        const all = { id: 'root', groupBy: ['...'] };
        expect(alertGroupKey(all, diskDb1)).not.toBe(
            alertGroupKey(all, diskDb2),
        );
        expect(alertGroupKey(all, { b: '2', a: '1' })).toBe(
            alertGroupKey(all, { a: '1', b: '2' }),
        );
        const none = { id: 'root', groupBy: [] };
        expect(alertGroupKey(none, diskDb1)).toBe('root:{}');
        expect(alertGroupKey(none, { alertname: 'CPU high' })).toBe('root:{}');
    });
    it('escapes values so different label sets never share a key', () => {
        const all = { id: 'root', groupBy: ['...'] };
        expect(alertGroupKey(all, { a: '1",b="2' })).not.toBe(
            alertGroupKey(all, { a: '1', b: '2' }),
        );
    });
    it('keeps groups separate per route', () => {
        const labels = { team: 'frontend', env: 'prod', alertname: 'x' };
        const routes = routeAlert(
            {
                contactPoint: 'ops',
                groupBy: ['alertname'],
                routes: [
                    {
                        matchers: [
                            { label: 'team', operator: '=', value: 'frontend' },
                        ],
                        continue: true,
                    },
                    {
                        matchers: [
                            { label: 'env', operator: '=', value: 'prod' },
                        ],
                    },
                ],
            },
            labels,
        );
        expect(routes.map((route) => alertGroupKey(route, labels))).toEqual([
            'root.0:{alertname="x"}',
            'root.1:{alertname="x"}',
        ]);
    });
});
