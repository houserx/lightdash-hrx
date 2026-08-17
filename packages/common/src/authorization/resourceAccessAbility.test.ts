import { Ability, AbilityBuilder, subject } from '@casl/ability';
import {
    applyResourceAccessAbilities,
    RESOURCE_ACCESS_METADATA_KEY,
} from './resourceAccessAbility';
import { type MemberAbility } from './types';

describe('applyResourceAccessAbilities', () => {
    it('is a no-op when there are no grants', () => {
        const builder = new AbilityBuilder<MemberAbility>(Ability);
        applyResourceAccessAbilities([], builder);
        expect(builder.rules).toHaveLength(0);
    });

    it('grants view access to exactly the named dashboard, keyed on metadata.dashboardUuid', () => {
        const builder = new AbilityBuilder<MemberAbility>(Ability);
        applyResourceAccessAbilities(
            [
                {
                    resourceUuid: 'dash-1',
                    resourceType: 'Dashboard',
                    action: 'view',
                },
            ],
            builder,
        );
        const ability = builder.build();

        expect(
            ability.can(
                'view',
                subject('Dashboard', { metadata: { dashboardUuid: 'dash-1' } }),
            ),
        ).toBe(true);
        expect(
            ability.can(
                'view',
                subject('Dashboard', {
                    metadata: { dashboardUuid: 'not-granted' },
                }),
            ),
        ).toBe(false);
        // A direct grant doesn't imply manage.
        expect(
            ability.can(
                'manage',
                subject('Dashboard', { metadata: { dashboardUuid: 'dash-1' } }),
            ),
        ).toBe(false);
    });

    it('grants manage access to exactly the named saved chart, keyed on metadata.savedChartUuid', () => {
        const builder = new AbilityBuilder<MemberAbility>(Ability);
        applyResourceAccessAbilities(
            [
                {
                    resourceUuid: 'chart-1',
                    resourceType: 'SavedChart',
                    action: 'manage',
                },
            ],
            builder,
        );
        const ability = builder.build();

        // CASL's 'manage' is the built-in "any action" alias, so a manage
        // grant also satisfies the real check site's 'update' check.
        expect(
            ability.can(
                'update',
                subject('SavedChart', {
                    metadata: { savedChartUuid: 'chart-1' },
                }),
            ),
        ).toBe(true);
        expect(
            ability.can(
                'update',
                subject('SavedChart', {
                    metadata: { savedChartUuid: 'not-granted' },
                }),
            ),
        ).toBe(false);
    });

    it('composes additively alongside other rules already on the builder', () => {
        const builder = new AbilityBuilder<MemberAbility>(Ability);
        builder.can('view', 'Dashboard', { projectUuid: 'project-1' });
        applyResourceAccessAbilities(
            [
                {
                    resourceUuid: 'dash-1',
                    resourceType: 'Dashboard',
                    action: 'view',
                },
            ],
            builder,
        );
        const ability = builder.build();

        expect(
            ability.can(
                'view',
                subject('Dashboard', { projectUuid: 'project-1' }),
            ),
        ).toBe(true);
        expect(
            ability.can(
                'view',
                subject('Dashboard', {
                    projectUuid: 'other-project',
                    metadata: { dashboardUuid: 'dash-1' },
                }),
            ),
        ).toBe(true);
    });

    it('verifies the metadata key map matches the real check sites (dashboardUuid vs savedChartUuid -- not uniform)', () => {
        expect(RESOURCE_ACCESS_METADATA_KEY.Dashboard).toBe('dashboardUuid');
        expect(RESOURCE_ACCESS_METADATA_KEY.SavedChart).toBe('savedChartUuid');
    });
});
