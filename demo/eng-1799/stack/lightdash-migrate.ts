// ENG-1799 demo: applies Lightdash's database migrations (every non-ee knex migration, then graphile-worker's)
// to PGCONNECTIONURI and exits 0. stack/lightdash.ts runs it once per migrated template:
//
//   cd packages/backend && node --import tsx ../../demo/eng-1799/stack/lightdash-migrate.ts
//
// The working directory must be packages/backend so tsx compiles the backend with its own tsconfig (decorators,
// paths), as `pnpm -F backend dev` does. The backend's config is parsed from the environment at import, so the
// environment must carry a config that parses (stack/lightdash.ts passes the demo's backend env).
import { createRequire } from 'node:module';
import path from 'node:path';

const BACKEND = path.resolve(__dirname,'../../../packages/backend');
// Third-party packages are resolved from the backend, which depends on them.
const requireBackend = createRequire(path.join(BACKEND, 'package.json'));

async function main(): Promise<void> {
    const connectionString = process.env.PGCONNECTIONURI;
    if (!connectionString) throw new Error('PGCONNECTIONURI is not set');
    const { default: knexConfig } = await import(path.join(BACKEND, 'src/knexfile.ts'));
    const knex = requireBackend('knex');
    const { runMigrations } = requireBackend('graphile-worker');
    const database = knex(knexConfig.development);
    try {
        const [batch, applied] = await database.migrate.latest();
        console.log(`lightdash-migrate: knex batch ${batch}, ${applied.length} migrations applied`);
    } finally {
        await database.destroy();
    }
    await runMigrations({ connectionString });
    console.log('lightdash-migrate: graphile-worker migrations applied');
}

main().then(
    () => process.exit(0),
    (e: unknown) => {
        console.error('lightdash-migrate: failed:', e instanceof Error ? (e.stack ?? e.message) : e);
        process.exit(1);
    },
);
