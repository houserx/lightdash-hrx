import { ParseError } from '@lightdash/common';
import {
    parsePortalSavedScripts,
    portalScriptsToSqlCharts,
} from './importPortalScripts';

const script = (id: string, title: string, sql = 'SELECT 1') => ({
    id,
    title,
    sql,
});

describe('parsePortalSavedScripts', () => {
    it('keeps id, title, description and sql and drops the author fields', () => {
        const [parsed] = parsePortalSavedScripts(
            [
                {
                    ...script('a', 'Title'),
                    description: 'Desc',
                    createdBySub: 'auth0|synthetic',
                    createdByEmail: 'someone@example.com',
                },
            ],
            'export.json',
        );
        expect(parsed).toEqual({
            id: 'a',
            title: 'Title',
            description: 'Desc',
            sql: 'SELECT 1',
        });
    });

    it('accepts an empty export', () => {
        expect(parsePortalSavedScripts([], 'export.json')).toEqual([]);
    });

    it.each([
        [{ hello: 'world' }, /expected a JSON array/],
        [['text'], /item 1 is not an object/],
        [[script('a', 'A'), { id: 'b', title: 'B' }], /item 2 has no sql/],
        [[{ id: 'a', title: ' ', sql: 'SELECT 1' }], /item 1 has no title/],
        [[{ ...script('a', 'A'), description: 3 }], /description/],
    ])('rejects %j', (json, message) => {
        expect(() => parsePortalSavedScripts(json, 'x.json')).toThrow(
            ParseError,
        );
        expect(() => parsePortalSavedScripts(json, 'x.json')).toThrow(message);
        expect(() => parsePortalSavedScripts(json, 'x.json')).toThrow(
            /x\.json is not a db-query-portal saved-scripts export/,
        );
    });
});

describe('portalScriptsToSqlCharts', () => {
    it('makes table SQL charts in the given space', () => {
        expect(
            portalScriptsToSqlCharts(
                [
                    {
                        ...script('a', ' Open orders ', 'SELECT 2'),
                        description: '',
                    },
                ],
                'ops',
            ),
        ).toEqual([
            {
                version: 1,
                contentType: 'sql_chart',
                name: 'Open orders',
                description: null,
                slug: 'open-orders',
                spaceSlug: 'ops',
                sql: 'SELECT 2',
                limit: 500,
                chartKind: 'table',
                config: {
                    metadata: { version: 1 },
                    type: 'table',
                    columns: {},
                    display: {},
                },
            },
        ]);
    });

    it('gives repeated titles unique slugs in export order', () => {
        const slugs = portalScriptsToSqlCharts(
            [
                script('a', 'Same'),
                script('b', 'Same'),
                script('c', 'Same 2'),
                script('d', 'Same'),
                script('e', '!!!'),
                script('f', '???'),
            ],
            'ops',
        ).map((chart) => chart.slug);
        expect(slugs).toEqual([
            'same',
            'same-2',
            'same-2-2',
            'same-3',
            'saved-script',
            'saved-script-2',
        ]);
    });

    it('keeps long titles under the slug length limit', () => {
        const [chart] = portalScriptsToSqlCharts(
            [script('a', 'word '.repeat(100))],
            'ops',
        );
        expect(chart.slug.length).toBeLessThanOrEqual(192);
        expect(chart.slug.endsWith('-')).toBe(false);
    });
});
