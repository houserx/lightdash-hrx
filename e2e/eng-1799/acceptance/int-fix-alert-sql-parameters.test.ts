/* eslint-disable */
// @ts-nocheck
// int-fix-alert-sql-parameters: one SQL convention for reserved time parameters across Lightdash.
// SQL written in Investigate / the SQL Runner (bare `${ld.parameters.__from}`, quoted by Lightdash's
// parameter substitution) is a valid Alert Rule query: the alerting evaluator's substitution
// produces exactly the SQL Lightdash's substitution produces, and it runs on the engine. The
// shipped alerting examples follow the same convention.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { disposeAll, federationCredentials, harness, load, REPO_ROOT, track } from './support';

afterAll(disposeAll);

describe('int-fix-alert-sql-parameters', () => {
    it('Investigate SQL evaluates as an Alert Rule query', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'up', instance: 'db-1' }, value: 1 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const { warehouseClientFromCredentials } = await load('packages/warehouses/src/index.ts');
        const { buildTelemetrySql } = await load('packages/common/src/utils/telemetrySql.ts');
        const { resolveAlertQueryParameters, substituteAlertQueryParameters } = await load('packages/common/src/alerting/queryParameters.ts');
        const { safeReplaceParametersWithSqlBuilder } = await load('packages/backend/src/utils/QueryBuilder/parameters.ts');
        const client = warehouseClientFromCredentials(federationCredentials(engine));

        const sql = `SELECT max(value) AS value, labels FROM (${buildTelemetrySql({ kind: 'promql', query: 'up' })}) t GROUP BY labels`;
        const parameters = resolveAlertQueryParameters({ at: new Date('2026-11-08T10:00:00.000Z'), timeRange: '10m' });
        const byAlerting = substituteAlertQueryParameters(sql, parameters);
        const byLightdash = safeReplaceParametersWithSqlBuilder(sql, parameters, client).replacedSql;
        expect(byAlerting).toBe(byLightdash);

        const result = await client.runQuery(byAlerting);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].value).toBe(1);
    });

    it('the alerting docs and examples use bare parameter references', async () => {
        const dir = path.join(REPO_ROOT, 'docs/eng-1799/alerting-examples/alert-rules');
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
        expect(files.length).toBeGreaterThan(0);
        const docs = [...files.map((f) => path.join(dir, f)), path.join(REPO_ROOT, 'docs/eng-1799/alerting.md')];
        for (const file of docs) {
            const text = fs.readFileSync(file, 'utf8');
            expect(text, file).not.toMatch(/'\$\{\s*ld\.parameters\.__(from|to|interval|range)\s*\}'/);
        }
    });
});
