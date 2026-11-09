import { ChartKind } from '../types/savedCharts';
import { applyGrafanaTransformations } from './grafanaTransformations';

const SERIES_SQL = "SELECT * FROM promql('up', a, b, c)";

describe('applyGrafanaTransformations', () => {
    it('renames series with regexp_replace, translating the replacement pattern', () => {
        const result = applyGrafanaTransformations(
            [
                {
                    id: 'renameByRegex',
                    options: {
                        regex: '/^job-(.*)$/gi',
                        renamePattern: "$1's \\ $$ $&",
                    },
                },
            ],
            { sql: SERIES_SQL, shape: 'series' },
            ChartKind.LINE,
        );
        expect(result.sql).toBe(
            `SELECT "timestamp", "value", labels, regexp_replace(series, '^job-(.*)$', '\\1''s \\\\ $ \\&', 'gi') AS series\nFROM (${SERIES_SQL}) AS renamed`,
        );
        expect(result.warnings).toEqual([]);
    });

    it('keeps the number shape columns and skips disabled or empty renames', () => {
        const result = applyGrafanaTransformations(
            [
                {
                    id: 'renameByRegex',
                    options: { regex: 'a', renamePattern: 'b' },
                },
                {
                    id: 'renameByRegex',
                    disabled: true,
                    options: { regex: 'x' },
                },
                { id: 'renameByRegex', options: { regex: '' } },
            ],
            { sql: 'SELECT 1', shape: 'number' },
            ChartKind.BIG_NUMBER,
        );
        expect(result.sql).toBe(
            `SELECT "value", labels, regexp_replace(series, 'a', 'b') AS series\nFROM (SELECT 1) AS renamed`,
        );
    });

    it('warns when renameByRegex has no series to rename', () => {
        const result = applyGrafanaTransformations(
            [
                {
                    id: 'renameByRegex',
                    options: { regex: 'a', renamePattern: 'b' },
                },
            ],
            { sql: 'SELECT a FROM platform_query(...)' },
            ChartKind.TABLE,
        );
        expect(result.sql).toBe('SELECT a FROM platform_query(...)');
        expect(result.warnings.map((w) => w.code)).toEqual([
            'transformation-unsupported',
        ]);
        expect(result.warnings[0].message).toContain('renameByRegex');
    });

    it('organizes table columns: label, visibility and order', () => {
        const result = applyGrafanaTransformations(
            [
                {
                    id: 'organize',
                    options: {
                        renameByName: { jobname: 'Job' },
                        excludeByName: { status: true, runs: false },
                        indexByName: { runs: 0, jobname: 1 },
                    },
                },
            ],
            { sql: 'SELECT 1' },
            ChartKind.TABLE,
        );
        expect(result.columns).toEqual({
            jobname: {
                reference: 'jobname',
                label: 'Job',
                visible: true,
                frozen: false,
                order: 1,
            },
            runs: {
                reference: 'runs',
                label: 'runs',
                visible: true,
                frozen: false,
                order: 0,
            },
            status: {
                reference: 'status',
                label: 'status',
                visible: false,
                frozen: false,
            },
        });
        expect(result.warnings).toEqual([]);
    });

    it('warns for organize on a chart that is not a table, unless it names no column', () => {
        const organize = (options: object) =>
            applyGrafanaTransformations(
                [{ id: 'organize', options }],
                { sql: 'SELECT 1', shape: 'series' },
                ChartKind.LINE,
            );
        expect(organize({ renameByName: { value: 'Rate' } }).warnings).toEqual([
            expect.objectContaining({ code: 'transformation-unsupported' }),
        ]);
        expect(
            organize({ renameByName: {}, excludeByName: {} }).warnings,
        ).toEqual([]);
    });

    it('leaves transformations it does not know as they are', () => {
        const result = applyGrafanaTransformations(
            [{ id: 'sortBy', options: {} }],
            { sql: 'SELECT 1' },
            ChartKind.TABLE,
        );
        expect(result).toEqual({ sql: 'SELECT 1', columns: {}, warnings: [] });
    });
});
