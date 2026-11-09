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

    describe('filters', () => {
        const PG_SQL = "SELECT * FROM platform_query('SELECT a, b FROM t')";
        const apply = (transformation: object, shape?: 'series' | 'number') =>
            applyGrafanaTransformations(
                [transformation],
                { sql: PG_SQL, shape },
                ChartKind.TABLE,
            );
        const byValue = (options: object) =>
            apply({ id: 'filterByValue', options }).sql;

        it('selects the fields filterFieldsByName names, quoted', () => {
            const result = apply({
                id: 'filterFieldsByName',
                options: { include: { names: ['a', 'Odd "x"', 'a'] } },
            });
            expect(result.sql).toBe(
                `SELECT "a", "Odd ""x"""\nFROM (${PG_SQL}) AS filtered`,
            );
            expect(result.warnings).toEqual([]);
        });

        it('reports field patterns, exclusions and shaped results, and skips an empty filter', () => {
            [
                apply({
                    id: 'filterFieldsByName',
                    options: { include: { pattern: 'p\\d+' } },
                }),
                apply({
                    id: 'filterFieldsByName',
                    options: { exclude: { names: ['a'] } },
                }),
                apply(
                    {
                        id: 'filterFieldsByName',
                        options: { include: { names: ['Time'] } },
                    },
                    'series',
                ),
                apply(
                    {
                        id: 'filterByValue',
                        options: {
                            filters: [
                                {
                                    fieldName: 'value',
                                    config: { id: 'isNull' },
                                },
                            ],
                        },
                    },
                    'number',
                ),
            ].forEach((result) => {
                expect(result.sql).toBe(PG_SQL);
                expect(result.warnings).toEqual([
                    expect.objectContaining({
                        code: 'transformation-unsupported',
                    }),
                ]);
            });
            expect(
                apply({ id: 'filterFieldsByName', options: { include: {} } }),
            ).toEqual({ sql: PG_SQL, columns: {}, warnings: [] });
        });

        it('excludes rows matching any filter, null-safe only when it has to be', () => {
            expect(
                byValue({
                    type: 'exclude',
                    match: 'any',
                    filters: [
                        {
                            fieldName: 'a',
                            config: { id: 'equal', options: { value: 0 } },
                        },
                        { fieldName: 'a', config: { id: 'isNull' } },
                    ],
                }),
            ).toBe(
                `SELECT *\nFROM (${PG_SQL}) AS filtered\nWHERE NOT ("a" = 0 OR "a" IS NULL)`,
            );
            expect(
                byValue({
                    type: 'exclude',
                    filters: [
                        {
                            fieldName: 'a',
                            config: { id: 'greater', options: { value: '5' } },
                        },
                    ],
                }),
            ).toContain('WHERE NOT COALESCE("a" > 5, FALSE)');
        });

        it('keeps rows matching all filters, with every matcher translated', () => {
            expect(
                byValue({
                    type: 'include',
                    match: 'all',
                    filters: [
                        {
                            fieldName: 'a',
                            config: {
                                id: 'range',
                                options: { from: 1, to: 9 },
                            },
                        },
                        {
                            fieldName: 'b',
                            config: { id: 'regex', options: { value: "^x'" } },
                        },
                        {
                            fieldName: 'b',
                            config: {
                                id: 'notEqual',
                                options: { value: 'n/a' },
                            },
                        },
                        { fieldName: 'b', config: { id: 'isNotNull' } },
                    ],
                }),
            ).toContain(
                `WHERE ("a" > 1 AND "a" < 9) AND CAST("b" AS VARCHAR) ~ '^x''' AND "b" <> 'n/a' AND "b" IS NOT NULL`,
            );
        });

        it('reports a filter with a matcher it does not translate', () => {
            const result = apply({
                id: 'filterByValue',
                options: {
                    filters: [{ fieldName: 'a', config: { id: 'substring' } }],
                },
            });
            expect(result.sql).toBe(PG_SQL);
            expect(result.warnings).toHaveLength(1);
        });
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
