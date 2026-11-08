import {
    type NotificationRouteTree,
    type SavedNotificationRouteTree,
} from '@lightdash/common';
import { type Knex } from 'knex';
import { findProjectOrganizationUuid } from './alertingAccess';
import { ContactPointsTableName } from './ContactPointModel';

// Table from migration 20261108120000_create_alerting_tables.
export const NotificationRoutesTableName = 'notification_routes';

type DbNotificationRoutes = {
    notification_route_uuid: string;
    project_uuid: string;
    tree: NotificationRouteTree;
    managed: boolean;
    updated_by_user_uuid: string | null;
    created_at: Date;
    updated_at: Date;
};

export class NotificationRouteModel {
    constructor(private readonly database: Knex) {}

    async findProjectOrganizationUuid(
        projectUuid: string,
    ): Promise<string | undefined> {
        return findProjectOrganizationUuid(this.database, projectUuid);
    }

    /** The project's tree; pass `trx` to read it inside a transaction. */
    async find(
        projectUuid: string,
        trx: Knex = this.database,
    ): Promise<SavedNotificationRouteTree | undefined> {
        const row = await trx(NotificationRoutesTableName)
            .where('project_uuid', projectUuid)
            .first<DbNotificationRoutes | undefined>();
        return row ? { ...row.tree, managed: row.managed } : undefined;
    }

    /**
     * Saves the project's tree, replacing the one before. `check` gets the
     * current tree (if any) and the project's Contact Point slugs, both
     * locked until the save commits, so a concurrent Contact Point delete
     * can't leave the tree pointing at nothing; it throws to refuse.
     */
    async save(args: {
        projectUuid: string;
        tree: NotificationRouteTree;
        userUuid: string;
        now: Date;
        check: (
            current: SavedNotificationRouteTree | undefined,
            contactPointSlugs: ReadonlySet<string>,
        ) => void;
    }): Promise<void> {
        await this.database.transaction(async (trx) => {
            const current = await trx(NotificationRoutesTableName)
                .where('project_uuid', args.projectUuid)
                .forUpdate()
                .first<DbNotificationRoutes | undefined>();
            const slugs = await trx(ContactPointsTableName)
                .where('project_uuid', args.projectUuid)
                .forShare()
                .select<{ slug: string }[]>('slug');
            args.check(
                current
                    ? { ...current.tree, managed: current.managed }
                    : undefined,
                new Set(slugs.map((row) => row.slug)),
            );
            await trx(NotificationRoutesTableName)
                .insert({
                    project_uuid: args.projectUuid,
                    // jsonb column: stored as given.
                    tree: JSON.stringify(args.tree),
                    managed: false,
                    updated_by_user_uuid: args.userUuid,
                    created_at: args.now,
                    updated_at: args.now,
                })
                .onConflict('project_uuid')
                .merge(['tree', 'updated_by_user_uuid', 'updated_at']);
        });
    }
}
