import { SEED_ORG_1 } from '@lightdash/common';
import { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
    await knex('organization_homepage_settings').insert({
        organization_uuid: SEED_ORG_1.organization_uuid,
        enabled: true,
        opening: null,
    });
}
