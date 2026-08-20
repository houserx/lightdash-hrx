import { Knex } from 'knex';

const ResourceUserAccessTableName = 'resource_user_access';
const ResourceGroupAccessTableName = 'resource_group_access';

/**
 * Additive migration for direct resource grants: direct user or group access to a
 * single Dashboard or SavedChart, without creating a dedicated Space for it.
 *
 * Shaped like `space_user_access`/`space_group_access` (see migrations/CLAUDE.md's
 * frozen-literal convention -- the CHECK-constrained literal lists below must stay
 * hand-copied here, not imported from @lightdash/common), but with a synthetic UUID
 * primary key per the current convention for new tables; space_*_access predates
 * that and uses a composite natural key instead.
 *
 * `resource_type` is CHECK-constrained to the two subjects supported initially, so
 * widening the allowlist is a new migration rather than a code-only change and a
 * future resource type cannot silently become grantable.
 *
 * `action` is CHECK-constrained to ('view', 'manage'), matching the two actions
 * Dashboard/SavedChart scopes expose. These map onto the space role vocabulary when
 * resolved -- view to VIEWER, manage to EDITOR -- so existing access-gated CASL
 * rules apply unchanged. See resolveResourceAccess.
 *
 * Each unique constraint leads with its principal column, ahead of resource_uuid:
 * the read path filters by principal first, so the implicit btree behind the
 * constraint is what keeps that lookup indexed. `resource_uuid` is indexed
 * separately for the reverse lookup, listing who holds a grant on a resource.
 */
/**
 * Purely additive: two new tables, no changes to existing ones, so nothing an
 * existing deployment reads or writes is affected.
 */
export const classification: { kind: 'safe' | 'breaking'; reason: string } = {
    kind: 'safe',
    reason: 'Creates two new tables and their constraints; touches no existing table, column or index.',
};

export async function up(knex: Knex): Promise<void> {
    // A waiting ALTER can queue every later query behind it. Cheap here (the
    // tables are new and uncontended) but the gate expects DDL to bound it.
    await knex.raw('SET lock_timeout = 10000');

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
        // Nulled rather than cascading: offboarding whoever issued a grant must
        // not silently revoke access that is still legitimately held.
        table
            .uuid('granted_by')
            .nullable()
            .references('user_uuid')
            .inTable('users')
            .onDelete('SET NULL')
            .index();
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
            .onDelete('SET NULL')
            .index();
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

    await knex.raw('RESET lock_timeout');
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTable(ResourceGroupAccessTableName);
    await knex.schema.dropTable(ResourceUserAccessTableName);
}
