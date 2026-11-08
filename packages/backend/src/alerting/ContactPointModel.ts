import {
    type ContactPoint,
    type ContactPointIntegration,
} from '@lightdash/common';
import { type Knex } from 'knex';
import {
    findProjectOrganizationUuid,
    slugPrefixPattern,
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

    /** Deletes it; its send log entries keep a null contact point. */
    async delete(
        projectUuid: string,
        contactPointUuid: string,
    ): Promise<boolean> {
        const deleted = await this.database(ContactPointsTableName)
            .where({
                project_uuid: projectUuid,
                contact_point_uuid: contactPointUuid,
            })
            .delete();
        return deleted > 0;
    }
}
