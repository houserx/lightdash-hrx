/**
 * A throwaway Postgres with every non-ee Lightdash migration applied. Migrations load through
 * vitest's module graph (so TypeScript and the @lightdash/* aliases work).
 */
import knex, { type Knex } from 'knex';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { load } from './load';
import { startPgCluster, type PgCluster } from './pgCluster';

const migrationsDir = path.resolve(__dirname, '../../database/migrations');

export type MigratedDatabase = {
    cluster: PgCluster;
    database: Knex;
    stop: () => Promise<void>;
};

export const startMigratedDatabase = async (): Promise<MigratedDatabase> => {
    const cluster = await startPgCluster();
    const database = knex({
        client: 'pg',
        connection: cluster.url,
        pool: { min: 0, max: 5 },
    });
    try {
        await database.migrate.latest({
            tableName: 'knex_migrations',
            migrationSource: {
                getMigrations: async () =>
                    readdirSync(migrationsDir)
                        .filter(
                            (file) =>
                                file.endsWith('.ts') &&
                                !file.endsWith('.test.ts') &&
                                /^\d/.test(file),
                        )
                        .sort(),
                getMigrationName: (migration: string) => migration,
                getMigration: async (migration: string) =>
                    load(
                        `../../database/migrations/${migration.replace(/\.ts$/, '')}`,
                    ),
            },
        });
    } catch (error) {
        await database.destroy();
        cluster.stop();
        throw error;
    }
    return {
        cluster,
        database,
        stop: async () => {
            await database.destroy();
            cluster.stop();
        },
    };
};
