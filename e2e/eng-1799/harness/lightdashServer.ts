/**
 * Child-process entry for `startLightdash` (lightdash.ts): the real Lightdash backend app.
 *
 * lightdash.ts forks this file with `node --import tsx`, cwd `packages/backend` (so tsx uses the
 * backend's tsconfig, as `pnpm -F backend dev` does) and a minimal env it builds. The backend's
 * config is parsed from that env at import, so each boot gets a fresh process and its own config.
 *
 *   argv[2] = 'migrate'  Applies every non-ee knex migration and graphile-worker's migrations to
 *                        PGCONNECTIONURI, then exits 0 (used once to build the template cluster).
 *   argv[2] = 'serve'    Seeds the Operations Project fixtures (E2E_SEED, JSON) into the freshly
 *                        cloned database, starts the App on PORT and sends
 *                        `{ type: 'ready', seeded }` over IPC (or `{ type: 'error', message }`).
 *                        SIGTERM stops the App and exits.
 *
 * Nothing here talks to anything but the throwaway Postgres, the fake S3 and the engine.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';

const BACKEND_SRC = path.resolve(__dirname, '../../../packages/backend/src');
// Third-party packages are resolved from the backend, which depends on them.
const requireBackend = createRequire(path.join(BACKEND_SRC, '../package.json'));

type Seed = {
    organizationName: string;
    userEmail: string;
    projectName: string;
    spaceName: string;
    apiKey: string;
    warehouseCredentials: Record<string, unknown>;
};

export type Seeded = {
    organizationUuid: string;
    userUuid: string;
    projectUuid: string;
    spaceUuid: string;
};

const send = (message: unknown) =>
    new Promise<void>((resolve) => {
        if (!process.send) {
            resolve();
            return;
        }
        process.send(message, () => resolve());
    });

const errorText = (error: unknown) =>
    error instanceof Error ? (error.stack ?? error.message) : String(error);

async function migrate(): Promise<void> {
    const { default: knexConfig } = await import(
        path.join(BACKEND_SRC, 'knexfile')
    );
    const knex = requireBackend('knex');
    const { runMigrations } = requireBackend('graphile-worker');
    const database = knex(knexConfig.development);
    try {
        await database.migrate.latest();
    } finally {
        await database.destroy();
    }
    await runMigrations({ connectionString: process.env.PGCONNECTIONURI });
}

async function seed(database: any, input: Seed): Promise<Seeded> {
    const common = requireBackend('@lightdash/common');
    const { lightdashConfig } = await import(
        path.join(BACKEND_SRC, 'config/lightdashConfig')
    );
    const { EncryptionUtil } = await import(
        path.join(BACKEND_SRC, 'utils/EncryptionUtil/EncryptionUtil')
    );
    const { hash } = await import(path.join(BACKEND_SRC, 'utils/hash'));
    const enc = new EncryptionUtil({ lightdashConfig });

    return database.transaction(async (trx: any) => {
        const [organization] = await trx('organizations')
            .insert({ organization_name: input.organizationName })
            .returning(['organization_id', 'organization_uuid']);

        const [user] = await trx('users')
            .insert({
                first_name: 'E2E',
                last_name: 'Admin',
                is_marketing_opted_in: false,
                is_tracking_anonymized: true,
                is_setup_complete: true,
                is_active: true,
            })
            .returning(['user_id', 'user_uuid']);
        await trx('emails').insert({
            user_id: user.user_id,
            email: input.userEmail,
            is_primary: true,
            is_verified: true,
        });
        await trx('organization_memberships').insert({
            user_id: user.user_id,
            organization_id: organization.organization_id,
            role: common.OrganizationMemberRole.ADMIN,
        });
        await trx('onboarding')
            .insert({
                organization_id: organization.organization_id,
                ranQuery_at: new Date(),
                shownSuccess_at: new Date(),
            })
            .onConflict('organization_id')
            .ignore();
        await trx('personal_access_tokens').insert({
            created_by_user_id: user.user_id,
            description: 'eng-1799 e2e harness',
            token_hash: await hash(input.apiKey),
            expires_at: null,
        });

        const [project] = await trx('projects')
            .insert({
                name: input.projectName,
                slug: common.generateSlug(input.projectName),
                project_type: common.ProjectType.DEFAULT,
                organization_id: organization.organization_id,
                dbt_connection_type: common.DbtProjectType.NONE,
                dbt_connection: enc.encrypt(
                    JSON.stringify({ type: common.DbtProjectType.NONE }),
                ),
                dbt_version: common.SupportedDbtVersions.V1_12,
                copied_from_project_uuid: null,
                organization_warehouse_credentials_uuid: null,
                created_by_user_uuid: user.user_uuid,
            })
            .returning(['project_id', 'project_uuid']);
        await trx('warehouse_credentials').insert({
            project_id: project.project_id,
            encrypted_credentials: enc.encrypt(
                JSON.stringify(input.warehouseCredentials),
            ),
            warehouse_type: input.warehouseCredentials.type,
        });

        const spaceSlug = common.generateSlug(input.spaceName);
        const [space] = await trx('spaces')
            .insert({
                name: input.spaceName,
                project_id: project.project_id,
                slug: spaceSlug,
                parent_space_uuid: null,
                path: common.getLtreePathFromSlug(spaceSlug),
                inherit_parent_permissions: true,
                is_default_user_space: false,
            })
            .returning(['space_uuid']);
        await trx('space_user_access').insert({
            user_uuid: user.user_uuid,
            space_uuid: space.space_uuid,
            space_role: 'admin',
        });

        return {
            organizationUuid: organization.organization_uuid,
            userUuid: user.user_uuid,
            projectUuid: project.project_uuid,
            spaceUuid: space.space_uuid,
        };
    });
}

async function serve(): Promise<void> {
    const input = JSON.parse(process.env.E2E_SEED ?? '') as Seed;
    delete process.env.E2E_SEED;

    const { default: knexConfig } = await import(
        path.join(BACKEND_SRC, 'knexfile')
    );
    const knex = requireBackend('knex');
    const database = knex({
        ...knexConfig.development,
        pool: { min: 0, max: 1 },
    });
    let seeded: Seeded;
    try {
        seeded = await seed(database, input);
    } finally {
        await database.destroy();
    }

    const { lightdashConfig } = await import(
        path.join(BACKEND_SRC, 'config/lightdashConfig')
    );
    const { default: App } = await import(path.join(BACKEND_SRC, 'App'));
    const app = new App({
        lightdashConfig,
        port: process.env.PORT,
        environment: 'development',
        knexConfig,
    });

    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        app.stop()
            .catch(() => undefined)
            .finally(() => process.exit(0));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    // The parent died without stopping us: don't linger.
    process.on('disconnect', stop);

    await app.start();
    await send({ type: 'ready', seeded });
}

const mode = process.argv[2];
(mode === 'migrate' ? migrate() : serve())
    .then(() => {
        if (mode === 'migrate') process.exit(0);
    })
    .catch(async (error: unknown) => {
        await send({ type: 'error', message: errorText(error) });
        console.error(errorText(error));
        process.exit(1);
    });
