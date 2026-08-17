import knex from 'knex';
import { getTracker, MockClient, Tracker } from 'knex-mock-client';
import {
    ResourceGroupAccessTableName,
    ResourceUserAccessTableName,
} from '../database/entities/resourceAccess';
import { ResourceAccessModel } from './ResourceAccessModel';

describe('ResourceAccessModel', () => {
    const database = knex({ client: MockClient, dialect: 'pg' });
    const model = new ResourceAccessModel({ database });
    let tracker: Tracker;

    beforeAll(() => {
        tracker = getTracker();
    });

    afterEach(() => {
        tracker.reset();
    });

    describe('addUserAccess', () => {
        it('upserts a grant keyed on user/resource/type/action', async () => {
            tracker.on.insert(ResourceUserAccessTableName).response([]);

            await model.addUserAccess({
                userUuid: 'user-1',
                resourceUuid: 'dash-1',
                resourceType: 'Dashboard',
                projectUuid: 'project-1',
                action: 'view',
                grantedByUserUuid: 'granter-1',
            });

            expect(tracker.history.insert).toHaveLength(1);
            const [insertQuery] = tracker.history.insert;
            expect(insertQuery.sql).toContain(ResourceUserAccessTableName);
            expect(insertQuery.sql).toContain('on conflict');
            expect(insertQuery.bindings).toEqual(
                expect.arrayContaining([
                    'user-1',
                    'dash-1',
                    'Dashboard',
                    'project-1',
                    'view',
                    'granter-1',
                ]),
            );
        });
    });

    describe('addGroupAccess', () => {
        it('upserts a grant keyed on group/resource/type/action', async () => {
            tracker.on.insert(ResourceGroupAccessTableName).response([]);

            await model.addGroupAccess({
                groupUuid: 'group-1',
                resourceUuid: 'chart-1',
                resourceType: 'SavedChart',
                projectUuid: 'project-1',
                action: 'manage',
                grantedByUserUuid: 'granter-1',
            });

            expect(tracker.history.insert).toHaveLength(1);
            const [insertQuery] = tracker.history.insert;
            expect(insertQuery.sql).toContain(ResourceGroupAccessTableName);
            expect(insertQuery.sql).toContain('on conflict');
            expect(insertQuery.bindings).toEqual(
                expect.arrayContaining([
                    'group-1',
                    'chart-1',
                    'SavedChart',
                    'project-1',
                    'manage',
                    'granter-1',
                ]),
            );
        });
    });

    describe('removeUserAccess', () => {
        it('deletes the exact grant, idempotently', async () => {
            tracker.on.delete(ResourceUserAccessTableName).response([]);

            await model.removeUserAccess({
                userUuid: 'user-1',
                resourceUuid: 'dash-1',
                resourceType: 'Dashboard',
                action: 'view',
            });

            expect(tracker.history.delete).toHaveLength(1);
            const [deleteQuery] = tracker.history.delete;
            expect(deleteQuery.bindings).toEqual([
                'user-1',
                'dash-1',
                'Dashboard',
                'view',
            ]);
        });
    });

    describe('removeGroupAccess', () => {
        it('deletes the exact grant, idempotently', async () => {
            tracker.on.delete(ResourceGroupAccessTableName).response([]);

            await model.removeGroupAccess({
                groupUuid: 'group-1',
                resourceUuid: 'chart-1',
                resourceType: 'SavedChart',
                action: 'manage',
            });

            expect(tracker.history.delete).toHaveLength(1);
            const [deleteQuery] = tracker.history.delete;
            expect(deleteQuery.bindings).toEqual([
                'group-1',
                'chart-1',
                'SavedChart',
                'manage',
            ]);
        });
    });

    describe('listAccessForResource', () => {
        it('combines user and group grants into one summary list', async () => {
            const createdAt = new Date('2026-01-01T00:00:00Z');
            tracker.on.select(ResourceUserAccessTableName).response([
                {
                    user_uuid: 'user-1',
                    action: 'view',
                    granted_by: 'granter-1',
                    created_at: createdAt,
                },
            ]);
            tracker.on.select(ResourceGroupAccessTableName).response([
                {
                    group_uuid: 'group-1',
                    action: 'manage',
                    granted_by: 'granter-2',
                    created_at: createdAt,
                },
            ]);

            const result = await model.listAccessForResource({
                resourceUuid: 'dash-1',
                resourceType: 'Dashboard',
            });

            expect(result).toEqual([
                {
                    userUuid: 'user-1',
                    groupUuid: null,
                    action: 'view',
                    grantedByUserUuid: 'granter-1',
                    createdAt,
                },
                {
                    userUuid: null,
                    groupUuid: 'group-1',
                    action: 'manage',
                    grantedByUserUuid: 'granter-2',
                    createdAt,
                },
            ]);
        });
    });
});
