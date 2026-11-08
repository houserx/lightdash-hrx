// ldq-cli-import-portal-scripts: `lightdash import portal-scripts <file.json>` converts the
// db-query-portal saved-scripts export (SavedScript[] from api/src/dynamo/savedScripts.ts)
// into SQL-chart-as-code YAML that `lightdash upload` accepts.
import { generateSlug } from '@lightdash/common';
import * as yaml from 'js-yaml';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCliProcess } from '../../testing/cliProcess';

const scripts = [
    {
        id: '0f0e0d0c-0000-4000-8000-000000000001',
        title: 'Stuck refills by status',
        description: 'Refills that have not moved in a week',
        sql: "SELECT status, count(*) FROM refills WHERE updated_at < now() - interval '7 days' GROUP BY 1",
        tags: ['refills', 'support'],
        createdByEmail: 'support.one@example.com',
        createdBySub: 'auth0|synthetic-1',
        createdAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-02-03T04:05:06.000Z',
        executionCount: 12,
        lastExecutedAt: '2026-03-01T00:00:00.000Z',
    },
    {
        id: '0f0e0d0c-0000-4000-8000-000000000002',
        title: 'Rx: pending > 7 days!',
        description: '',
        sql: 'SELECT id FROM prescriptions WHERE state = $$pending$$',
        tags: [],
        createdByEmail: 'support.two@example.com',
        createdBySub: 'auth0|synthetic-2',
        createdAt: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
    },
    {
        id: '0f0e0d0c-0000-4000-8000-000000000003',
        title: 'Stuck refills by status',
        description: 'Same title, different script',
        sql: 'SELECT 1',
        tags: [],
        createdByEmail: 'support.one@example.com',
        createdBySub: 'auth0|synthetic-1',
        createdAt: '2026-01-06T00:00:00.000Z',
        updatedAt: '2026-01-06T00:00:00.000Z',
    },
];

const env = () => {
    const result = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    for (const name of [
        'LIGHTDASH_API_KEY',
        'LIGHTDASH_URL',
        'LIGHTDASH_PROJECT',
        'LIGHTDASH_PROXY_AUTHORIZATION',
    ]) {
        delete result[name as keyof typeof result];
    }
    return result;
};

let directory: string;

beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(tmpdir(), 'ldq-portal-scripts-'));
});

afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
});

describe('lightdash import portal-scripts', () => {
    it('writes one SQL chart YAML per saved script', async () => {
        const input = path.join(directory, 'saved-scripts.json');
        const output = path.join(directory, 'lightdash');
        await fs.writeFile(input, JSON.stringify(scripts));
        const result = await runCliProcess({
            args: [
                'import',
                'portal-scripts',
                input,
                '--path',
                output,
                '--space',
                'platform-saved-sql',
            ],
            env: { ...env(), HOME: directory },
            timeoutMs: 60_000,
        });
        expect(result.code).toBe(0);

        const files = (await fs.readdir(path.join(output, 'charts'))).sort();
        const first = generateSlug('Stuck refills by status');
        expect(first).toBe('stuck-refills-by-status');
        expect(files).toEqual(
            [
                `${first}.yml`,
                `${first}-2.yml`,
                `${generateSlug('Rx: pending > 7 days!')}.yml`,
            ].sort(),
        );

        const chart = yaml.load(
            await fs.readFile(path.join(output, 'charts', `${first}.yml`), 'utf8'),
        ) as any;
        expect(chart).toMatchObject({
            version: 1,
            contentType: 'sql_chart',
            name: 'Stuck refills by status',
            description: 'Refills that have not moved in a week',
            slug: first,
            sql: scripts[0].sql,
            spaceSlug: 'platform-saved-sql',
            chartKind: 'table',
            config: { type: 'table' },
        });
        expect(typeof chart.limit).toBe('number');
        expect(JSON.stringify(chart)).not.toContain('auth0|');

        const duplicate = yaml.load(
            await fs.readFile(
                path.join(output, 'charts', `${first}-2.yml`),
                'utf8',
            ),
        ) as any;
        expect(duplicate.slug).toBe(`${first}-2`);
        expect(duplicate.sql).toBe('SELECT 1');
        expect(result.stdout).toContain('3');
    }, 120_000);

    it('fails clearly on a file that is not a saved-scripts export', async () => {
        const input = path.join(directory, 'not-scripts.json');
        await fs.writeFile(input, JSON.stringify({ hello: 'world' }));
        const result = await runCliProcess({
            args: [
                'import',
                'portal-scripts',
                input,
                '--path',
                path.join(directory, 'out'),
            ],
            env: { ...env(), HOME: directory },
            timeoutMs: 60_000,
        });
        expect(result.code).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toMatch(
            /saved.?scripts/i,
        );
        await expect(fs.readdir(path.join(directory, 'out', 'charts'))).rejects
            .toThrow();
    }, 120_000);
});
