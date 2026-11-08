// ldq-dashboard-time-range-persisted: the Dashboard Time Range is stored with the dashboard,
// not just client state: it survives create, read and a new version, and can be cleared.
import { DashboardModel } from '../../models/DashboardModel/DashboardModel';
import { startMigratedDatabase, type MigratedDatabase } from './migratedDatabase';

let db: MigratedDatabase;
let projectUuid: string;
let spaceUuid: string;
let userUuid: string;

beforeAll(async () => {
    db = await startMigratedDatabase();
    const { database } = db;
    const [organization] = await database('organizations')
        .insert({ organization_name: 'ldq test org' })
        .returning(['organization_id']);
    const [user] = await database('users')
        .insert({ first_name: 'Test', last_name: 'Person' } as never)
        .returning(['user_uuid']);
    userUuid = user.user_uuid;
    const [project] = await database('projects')
        .insert({
            organization_id: organization.organization_id,
            name: 'Operations',
        } as never)
        .returning(['project_id', 'project_uuid']);
    projectUuid = project.project_uuid;
    const [space] = await database('spaces')
        .insert({
            project_id: project.project_id,
            name: 'Service health',
            slug: 'service-health',
        } as never)
        .returning(['space_uuid']);
    spaceUuid = space.space_uuid;
}, 240_000);

afterAll(async () => {
    await db?.stop();
});

const timeRange = {
    from: 'now-6h',
    to: 'now',
    refreshInterval: '30s',
    tileTimeDimensions: {
        'tile-orders': { fieldId: 'orders_created_at', tableName: 'orders' },
    },
};

describe('DashboardModel time range', () => {
    it('stores the time range on create and reads it back', async () => {
        const model = new DashboardModel({ database: db.database } as never);
        const created = await model.create(
            spaceUuid,
            {
                name: 'Service health',
                slug: 'service-health',
                tiles: [],
                tabs: [],
                filters: { dimensions: [], metrics: [], tableCalculations: [] },
                timeRange,
            } as never,
            { userUuid },
            projectUuid,
        );
        expect((created as any).timeRange).toEqual(timeRange);
        const read = await model.getByIdOrSlug(created.uuid);
        expect((read as any).timeRange).toEqual(timeRange);
    });

    it('versions it: a new version can change or clear it', async () => {
        const model = new DashboardModel({ database: db.database } as never);
        const created = await model.create(
            spaceUuid,
            {
                name: 'Queue depth',
                slug: 'queue-depth',
                tiles: [],
                tabs: [],
                filters: { dimensions: [], metrics: [], tableCalculations: [] },
                timeRange,
            } as never,
            { userUuid },
            projectUuid,
        );
        const absolute = {
            from: '2026-11-01T00:00:00.000Z',
            to: '2026-11-02T00:00:00.000Z',
            refreshInterval: null,
            tileTimeDimensions: {},
        };
        await model.addVersion(
            created.uuid,
            {
                tiles: [],
                tabs: [],
                filters: { dimensions: [], metrics: [], tableCalculations: [] },
                timeRange: absolute,
            } as never,
            { userUuid },
            projectUuid,
        );
        expect(((await model.getByIdOrSlug(created.uuid)) as any).timeRange).toEqual(
            absolute,
        );
        await model.addVersion(
            created.uuid,
            {
                tiles: [],
                tabs: [],
                filters: { dimensions: [], metrics: [], tableCalculations: [] },
                timeRange: null,
            } as never,
            { userUuid },
            projectUuid,
        );
        const cleared = (await model.getByIdOrSlug(created.uuid)) as any;
        expect(cleared.timeRange ?? null).toBeNull();
        const [row] = await db.database('dashboard_versions')
            .join(
                'dashboards',
                'dashboards.dashboard_id',
                'dashboard_versions.dashboard_id',
            )
            .where('dashboards.dashboard_uuid', created.uuid)
            .orderBy('dashboard_versions.dashboard_version_id', 'desc')
            .limit(1)
            .select('dashboard_versions.time_range');
        expect(row.time_range).toBeNull();
    });
});
