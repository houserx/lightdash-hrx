import { translateGrafanaTarget } from './grafanaQuery';
import {
    grafanaVariableParameters,
    mergeProjectParameters,
} from './grafanaVariables';

describe('grafanaVariableParameters', () => {
    it('turns custom, query, textbox and interval variables into parameters', () => {
        const result = grafanaVariableParameters([
            {
                type: 'custom',
                name: 'env',
                label: 'Environment',
                query: 'prod,staging',
                current: { text: 'staging', value: 'staging' },
            },
            { type: 'constant', name: 'cluster', query: 'prod-eks' },
            {
                type: 'query',
                name: 'pod',
                description: 'The pod',
                current: { text: 'api-1', value: 'api-1' },
            },
            {
                type: 'interval',
                name: 'agg',
                query: '1m,5m',
                current: { text: '5m', value: '5m' },
            },
            { type: 'textbox', name: 'q', current: { text: '', value: '' } },
            {
                type: 'datasource',
                name: 'ds',
                query: 'prometheus',
                current: { text: 'Prometheus', value: 'abc' },
            },
        ]);
        expect(result.parameters).toEqual({
            env: {
                label: 'Environment',
                options: ['prod', 'staging'],
                default: 'staging',
            },
            pod: {
                label: 'pod',
                description: 'The pod',
                allow_custom_values: true,
                default: 'api-1',
            },
            agg: { label: 'agg', options: ['1m', '5m'], default: '5m' },
            q: { label: 'q', allow_custom_values: true },
        });
        expect(result.dashboardParameters).toEqual({
            env: { parameterName: 'env', value: 'staging' },
            pod: { parameterName: 'pod', value: 'api-1' },
            agg: { parameterName: 'agg', value: '5m' },
            q: { parameterName: 'q', value: '' },
        });
        expect(result.warnings).toEqual([]);
    });

    it('reads saved options and custom `text : value` pairs, without All or auto', () => {
        const saved = grafanaVariableParameters([
            {
                type: 'interval',
                name: 'agg',
                query: '1m,5m',
                options: [
                    { text: 'auto', value: '$__auto_interval_agg' },
                    { text: '1m', value: '1m' },
                    { text: '1h', value: '1h' },
                ],
                current: { text: '1m', value: '1m' },
            },
        ]);
        expect(saved.parameters.agg.options).toEqual(['1m', '1h']);
        const pairs = grafanaVariableParameters([
            {
                type: 'custom',
                name: 'region',
                query: 'East : us-east-1, West : us-west-2, a\\,b',
                current: { text: 'East', value: 'us-east-1' },
            },
        ]);
        expect(pairs.parameters.region.options).toEqual([
            { label: 'East', value: 'us-east-1' },
            { label: 'West', value: 'us-west-2' },
            { label: 'a,b', value: 'a,b' },
        ]);
    });

    it('starts All at the custom all value or .*, and auto at the first option, with a warning', () => {
        const result = grafanaVariableParameters([
            {
                type: 'query',
                name: 'pod',
                includeAll: true,
                current: { text: 'All', value: ['$__all'] },
            },
            {
                type: 'query',
                name: 'node',
                includeAll: true,
                allValue: 'node-.*',
                current: { text: 'All', value: '$__all' },
            },
            {
                type: 'interval',
                name: 'agg',
                auto: true,
                query: '1m,10m',
                current: { text: 'auto', value: '$__auto_interval_agg' },
            },
        ]);
        expect(result.dashboardParameters.pod.value).toBe('.*');
        expect(result.dashboardParameters.node.value).toBe('node-.*');
        expect(result.dashboardParameters.agg.value).toBe('1m');
        expect(result.warnings.map((w) => w.code)).toEqual([
            'parameter-default-adjusted',
            'parameter-default-adjusted',
            'parameter-default-adjusted',
        ]);
    });

    it('skips a variable whose name a parameter cannot have', () => {
        const result = grafanaVariableParameters([
            { type: 'textbox', name: 'a.b', current: { value: 'x' } },
        ]);
        expect(result.parameters).toEqual({});
        expect(result.warnings.map((w) => w.code)).toEqual([
            'variable-unsupported',
        ]);
    });
});

describe('mergeProjectParameters', () => {
    it('keeps identical definitions without a warning', () => {
        const env = { label: 'Env', options: ['prod'] };
        const result = mergeProjectParameters([
            { dashboard: 'A', parameters: { env } },
            { dashboard: 'B', parameters: { env } },
        ]);
        expect(result.parameters).toEqual({ env });
        expect(result.warnings).toEqual([]);
    });

    it('adds options, accepts any value when one does, and warns on the later dashboard', () => {
        const result = mergeProjectParameters([
            {
                dashboard: 'A',
                parameters: {
                    env: { label: 'Env', options: ['prod'], default: 'prod' },
                    pod: { label: 'Pod', options: ['api-1'] },
                },
            },
            {
                dashboard: 'B',
                parameters: {
                    env: { label: 'env', options: ['prod', 'dev'] },
                    pod: { label: 'Pod', allow_custom_values: true },
                },
            },
        ]);
        expect(result.parameters).toEqual({
            env: { label: 'Env', options: ['prod', 'dev'], default: 'prod' },
            pod: {
                label: 'Pod',
                options: ['api-1'],
                allow_custom_values: true,
            },
        });
        expect(
            result.warnings.map(({ index, warning }) => [index, warning.code]),
        ).toEqual([
            [1, 'parameter-merged'],
            [1, 'parameter-merged'],
        ]);
    });
});

describe('datasource variables', () => {
    const target = {
        refId: 'A',
        datasource: { type: 'prometheus', uid: '${ds}' },
        expr: 'up',
    };
    const ds = (current: { text?: unknown; value?: unknown }) => ({
        variables: [
            { type: 'datasource', name: 'ds', query: 'prometheus', current },
        ],
    });

    it('name the Telemetry Source from the current text without a datasource map', () => {
        const result = translateGrafanaTarget(
            target,
            ds({ text: 'Prometheus Staging', value: 'uid1' }),
        );
        expect(result.sql).toContain(`'prometheus-staging')`);
        expect(result.warnings.map((w) => w.code)).not.toContain(
            'datasource-unresolved',
        );
    });

    it('leave default and All to the engine default source', () => {
        for (const current of [
            { text: 'default', value: 'default' },
            { text: 'All', value: '$__all' },
        ]) {
            const result = translateGrafanaTarget(target, ds(current));
            expect(result.warnings.map((w) => w.code)).toContain(
                'datasource-unresolved',
            );
        }
    });
});
