import {
    type AlertingAsCodeChange,
    type ContactPoint,
    type ContactPointIntegration,
} from '@lightdash/common';
import { type Knex } from 'knex';
import {
    findProjectOrganizationUuid,
    slugPrefixPattern,
    stableStringify,
} from './alertingAccess';

// Table from migration 20261108120000_create_alerting_tables.
export const ContactPointsTableName = 'contact_points';

type DbContactPoint = {
    contact_point_uuid: string;
    project_uuid: string;
    slug: string;
    name: string;
    integrations: ContactPointIntegration[];
    managed: boolean;
    created_by_user_uuid: string | null;
    updated_by_user_uuid: string | null;
    created_at: Date;
    updated_at: Date;
};

const toContactPoint = (row: DbContactPoint): ContactPoint => ({
    uuid: row.contact_point_uuid,
    projectUuid: row.project_uuid,
    slug: row.slug,
    name: row.name,
    integrations: row.integrations,
    managed: row.managed,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdByUserUuid: row.created_by_user_uuid,
    updatedByUserUuid: row.updated_by_user_uuid,
});

export class ContactPointModel {
    constructor(private readonly database: Knex) {}

    async findProjectOrganizationUuid(
        projectUuid: string,
    ): Promise<string | undefined> {
        return findProjectOrganizationUuid(this.database, projectUuid);
    }

    async find(
        projectUuid: string,
        contactPointUuid: string,
    ): Promise<ContactPoint | undefined> {
        const row = await this.database(ContactPointsTableName)
            .where({
                project_uuid: projectUuid,
                contact_point_uuid: contactPointUuid,
            })
            .first<DbContactPoint | undefined>();
        return row ? toContactPoint(row) : undefined;
    }

    async list(projectUuid: string): Promise<ContactPoint[]> {
        const rows = await this.database(ContactPointsTableName)
            .where('project_uuid', projectUuid)
            .orderBy([
                { column: 'name', order: 'asc' },
                { column: 'created_at', order: 'asc' },
            ])
            .select<DbContactPoint[]>('*');
        return rows.map(toContactPoint);
    }

    async getSlugs(projectUuid: string, prefix: string): Promise<string[]> {
        const rows = await this.database(ContactPointsTableName)
            .where('project_uuid', projectUuid)
            .andWhere('slug', 'like', slugPrefixPattern(prefix))
            .select<{ slug: string }[]>('slug');
        return rows.map((row) => row.slug);
    }

    async create(args: {
        projectUuid: string;
        slug: string;
        name: string;
        integrations: ContactPointIntegration[];
        userUuid: string;
        now: Date;
    }): Promise<string> {
        const [{ contact_point_uuid: contactPointUuid }] = await this.database(
            ContactPointsTableName,
        )
            .insert({
                project_uuid: args.projectUuid,
                slug: args.slug,
                name: args.name,
                // jsonb column: knex would send the array as a Postgres array.
                integrations: JSON.stringify(args.integrations),
                created_by_user_uuid: args.userUuid,
                updated_by_user_uuid: args.userUuid,
                created_at: args.now,
                updated_at: args.now,
            })
            .returning<{ contact_point_uuid: string }[]>('contact_point_uuid');
        return contactPointUuid;
    }

    /**
     * As-code upload, inside the caller's transaction: creates the Contact
     * Point with this slug or overwrites its name and integrations, and
     * marks it managed either way.
     */
    async upsertManaged(
        trx: Knex.Transaction,
        args: {
            projectUuid: string;
            slug: string;
            name: string;
            integrations: ContactPointIntegration[];
            userUuid: string;
            now: Date;
        },
    ): Promise<{ contactPointUuid: string; change: AlertingAsCodeChange }> {
        const row = await trx(ContactPointsTableName)
            .where({ project_uuid: args.projectUuid, slug: args.slug })
            .forUpdate()
            .first<DbContactPoint | undefined>();
        if (!row) {
            const [{ contact_point_uuid: contactPointUuid }] = await trx(
                ContactPointsTableName,
            )
                .insert({
                    project_uuid: args.projectUuid,
                    slug: args.slug,
                    name: args.name,
                    integrations: JSON.stringify(args.integrations),
                    managed: true,
                    created_by_user_uuid: args.userUuid,
                    updated_by_user_uuid: args.userUuid,
                    created_at: args.now,
                    updated_at: args.now,
                })
                .returning<{ contact_point_uuid: string }[]>(
                    'contact_point_uuid',
                );
            return { contactPointUuid, change: 'created' };
        }
        const unchanged =
            row.managed &&
            row.name === args.name &&
            stableStringify(row.integrations) ===
                stableStringify(args.integrations);
        if (!unchanged) {
            await trx(ContactPointsTableName)
                .where('contact_point_uuid', row.contact_point_uuid)
                .update({
                    name: args.name,
                    integrations: JSON.stringify(args.integrations),
                    managed: true,
                    updated_by_user_uuid: args.userUuid,
                    updated_at: args.now,
                });
        }
        return {
            contactPointUuid: row.contact_point_uuid,
            change: unchanged ? 'unchanged' : 'updated',
        };
    }

    /**
     * Applies `change` to the current Contact Point under a row lock.
     * Returns false when it's gone.
     */
    async update(args: {
        projectUuid: string;
        contactPointUuid: string;
        apply: (
            current: ContactPoint,
        ) => Pick<ContactPoint, 'name' | 'integrations'>;
        userUuid: string;
        now: Date;
    }): Promise<boolean> {
        return this.database.transaction(async (trx) => {
            const row = await trx(ContactPointsTableName)
                .where({
                    project_uuid: args.projectUuid,
                    contact_point_uuid: args.contactPointUuid,
                })
                .forUpdate()
                .first<DbContactPoint | undefined>();
            if (!row) return false;
            const next = args.apply(toContactPoint(row));
            await trx(ContactPointsTableName)
                .where('contact_point_uuid', args.contactPointUuid)
                .update({
                    name: next.name,
                    integrations: JSON.stringify(next.integrations),
                    updated_by_user_uuid: args.userUuid,
                    updated_at: args.now,
                });
            return true;
        });
    }

    /**
     * Deletes it; its send log entries keep a null contact point.
     * `beforeCommit` runs in the same transaction once the row is deleted
     * (and locked), and can throw to keep it. Returns false when it's gone.
     */
    async delete(args: {
        projectUuid: string;
        contactPointUuid: string;
        beforeCommit: (
            trx: Knex.Transaction,
            deleted: ContactPoint,
        ) => Promise<void>;
    }): Promise<boolean> {
        return this.database.transaction(async (trx) => {
            const [row] = await trx(ContactPointsTableName)
                .where({
                    project_uuid: args.projectUuid,
                    contact_point_uuid: args.contactPointUuid,
                })
                .delete()
                .returning<DbContactPoint[]>('*');
            if (!row) return false;
            await args.beforeCommit(trx, toContactPoint(row));
            return true;
        });
    }
}
