/**
 * Feature viz-chart-types-migration.
 *
 * A saved chart's type is a foreign key into `chart_types`, so a chart of a
 * new native type can only be saved once a migration registers it.
 *
 * The full migration chain needs pgvector, which the throwaway Homebrew
 * cluster doesn't have, so this check builds the two tables the chart-type
 * migrations touch (`chart_types`, and `saved_queries_versions` with its
 * foreign key) and runs every migration that mentions the new types, in
 * order, through its real `up` and `down`.
 */
import { ChartType } from '@lightdash/common';
import knex, { type Knex } from 'knex';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listMigrationFiles } from '../../database/migrationFiles';
import {
    startThrowawayPostgres,
    type ThrowawayPostgres,
} from './throwawayPostgres';

type Migration = {
    name: string;
    up: (k: Knex) => Promise<void>;
    down: (k: Knex) => Promise<void>;
};

const NEW_TYPES = ['log_stream', 'trace_waterfall'];

describe('chart_types registers the viz line native chart types', () => {
    let pg: ThrowawayPostgres | undefined;
    let admin: Knex | undefined;
    let db: Knex | undefined;
    let migrations: Migration[] = [];

    beforeAll(async () => {
        pg = await startThrowawayPostgres();
        const connection = {
            host: pg.host,
            port: pg.port,
            user: pg.user,
            password: pg.password,
        };
        admin = knex({
            client: 'pg',
            connection: { ...connection, database: pg.adminDatabase },
        });
        await admin.raw('CREATE DATABASE viz_acceptance');
        db = knex({
            client: 'pg',
            connection: { ...connection, database: 'viz_acceptance' },
        });
        await db.schema.createTable('chart_types', (t) => {
            t.text('chart_type').primary();
        });
        await db('chart_types').insert(
            Object.values(ChartType)
                .filter((type) => !NEW_TYPES.includes(type))
                .map((type) => ({ chart_type: type })),
        );
        await db.schema.createTable('saved_queries_versions', (t) => {
            t.increments('saved_queries_version_id');
            t.text('chart_type')
                .notNullable()
                .references('chart_type')
                .inTable('chart_types');
        });

        const files = await listMigrationFiles();
        const relevant: { name: string; filePath: string }[] = [];
        for (const file of files) {
            // eslint-disable-next-line no-await-in-loop
            const source = await readFile(file.filePath, 'utf-8');
            if (NEW_TYPES.some((type) => source.includes(`'${type}'`))) {
                relevant.push(file);
            }
        }
        relevant.sort((a, b) => a.name.localeCompare(b.name));
        migrations = await Promise.all(
            relevant.map(async ({ name, filePath }) => {
                const mod = await import(filePath);
                return { name, up: mod.up, down: mod.down };
            }),
        );
    }, 180_000);

    afterAll(async () => {
        await db?.destroy();
        await admin?.destroy();
        pg?.stop();
    }, 120_000);

    it('has a migration that mentions the new chart types', () => {
        expect(migrations.length).toBeGreaterThan(0);
    });

    it('up registers log_stream and trace_waterfall', async () => {
        for (const migration of migrations) {
            // eslint-disable-next-line no-await-in-loop
            await migration.up(db!);
        }
        const rows = await db!
            .from('chart_types')
            .select('chart_type')
            .whereIn('chart_type', NEW_TYPES);
        expect(rows.map((r) => r.chart_type).sort()).toEqual(NEW_TYPES);
    });

    it('a saved chart version can use each new type', async () => {
        await db!('saved_queries_versions').insert([
            { chart_type: 'log_stream' },
            { chart_type: 'trace_waterfall' },
        ]);
        const count = await db!('saved_queries_versions')
            .whereIn('chart_type', NEW_TYPES)
            .count<{ count: string }[]>('* as count');
        expect(Number(count[0].count)).toBe(2);
    });

    it('down removes them again, including charts that used them', async () => {
        for (const migration of [...migrations].reverse()) {
            // eslint-disable-next-line no-await-in-loop
            await migration.down(db!);
        }
        const rows = await db!
            .from('chart_types')
            .whereIn('chart_type', NEW_TYPES);
        expect(rows).toEqual([]);
        // The types that were there before are untouched.
        const sankey = await db!
            .from('chart_types')
            .where('chart_type', 'sankey');
        expect(sankey).toHaveLength(1);
    });
});
