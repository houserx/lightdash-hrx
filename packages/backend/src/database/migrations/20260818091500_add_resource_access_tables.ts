import { Knex } from 'knex';

const ResourceUserAccessTableName = 'resource_user_access';
const ResourceGroupAccessTableName = 'resource_group_access';

/**
 * Additive migration for direct resource grants: direct user/group access
 * to a single Dashboard or SavedChart, without creating a dedicated Space
 * for it. Shaped like `space_user_access`/`space_group_access` (see
 * migrations/CLAUDE.md's frozen-literal convention -- these two
 * CHECK-constrained literal lists must stay hand-copied here, not imported
 * from @lightdash/common), but with a synthetic UUID primary key per the
 * current PK convention for new tables (space_*_access predates that
 * convention and uses a composite natural key instead).
 *
 * `resource_type` is CHECK-constrained to the two subjects supported
 * initially ('Dashboard', 'SavedChart') -- widening this allowlist is a
 * new migration, not a code-only change, so a future resource type can't
 * silently start being grantable without an explicit schema decision.
 *
 * `action` is CHECK-constrained to ('view', 'manage') -- the only two
 * actions Dashboard/SavedChart scopes use today (view:X / manage:X in
 * scopes.ts); CASL's manage is the built-in "any action" alias, so a
 * 'manage' grant satisfies real checks against 'view', 'update', etc.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable(ResourceUserAccessTableName, (table) => {
        table
            .uuid('resource_user_access_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table
            .uuid('user_uuid')
            .notNullable()
            .references('user_uuid')
            .inTable('users')
            .onDelete('CASCADE');
        table.uuid('resource_uuid').notNullable();
        table.string('resource_type').notNullable();
        table
            .uuid('project_uuid')
            .notNullable()
            .references('project_uuid')
            .inTable('projects')
            .onDelete('CASCADE');
        table.string('action').notNullable();
        table
            .uuid('granted_by')
            .nullable()
            .references('user_uuid')
            .inTable('users')
            .onDelete('SET NULL');
        table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

        table.unique(['user_uuid', 'resource_uuid', 'resource_type', 'action']);
        table.index('resource_uuid');
        table.index('project_uuid');
    });

    await knex.schema.createTable(ResourceGroupAccessTableName, (table) => {
        table
            .uuid('resource_group_access_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table
            .uuid('group_uuid')
            .notNullable()
            .references('group_uuid')
            .inTable('groups')
            .onDelete('CASCADE');
        table.uuid('resource_uuid').notNullable();
        table.string('resource_type').notNullable();
        table
            .uuid('project_uuid')
            .notNullable()
            .references('project_uuid')
            .inTable('projects')
            .onDelete('CASCADE');
        table.string('action').notNullable();
        table
            .uuid('granted_by')
            .nullable()
            .references('user_uuid')
            .inTable('users')
            .onDelete('SET NULL');
        table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

        table.unique([
            'group_uuid',
            'resource_uuid',
            'resource_type',
            'action',
        ]);
        table.index('resource_uuid');
        table.index('project_uuid');
    });

    await knex.raw(`
        ALTER TABLE ${ResourceUserAccessTableName}
            ADD CONSTRAINT resource_user_access_resource_type_check
                CHECK (resource_type IN ('Dashboard', 'SavedChart'))
    `);
    await knex.raw(`
        ALTER TABLE ${ResourceUserAccessTableName}
            ADD CONSTRAINT resource_user_access_action_check
                CHECK (action IN ('view', 'manage'))
    `);
    await knex.raw(`
        ALTER TABLE ${ResourceGroupAccessTableName}
            ADD CONSTRAINT resource_group_access_resource_type_check
                CHECK (resource_type IN ('Dashboard', 'SavedChart'))
    `);
    await knex.raw(`
        ALTER TABLE ${ResourceGroupAccessTableName}
            ADD CONSTRAINT resource_group_access_action_check
                CHECK (action IN ('view', 'manage'))
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTable(ResourceGroupAccessTableName);
    await knex.schema.dropTable(ResourceUserAccessTableName);
}
