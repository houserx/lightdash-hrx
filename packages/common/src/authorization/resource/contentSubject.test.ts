import { Ability, AbilityBuilder } from '@casl/ability';
import { OrganizationMemberRole } from '../../types/organizationMemberProfile';
import { ProjectMemberRole } from '../../types/projectMemberRole';
import { SpaceMemberRole, type SpaceAccess } from '../../types/space';
import { type MemberAbility } from '../types';
import {
    dashboardSubject,
    savedChartSubject,
    type ContentAccessContext,
} from './contentSubject';

const ORGANIZATION_UUID = 'org-1';
const PROJECT_UUID = 'project-1';
const USER_UUID = 'user-1';

/** What every migrated call site sources from the resource itself. */
const resourceFields = (extra: Record<string, unknown> = {}) => ({
    organizationUuid: ORGANIZATION_UUID,
    projectUuid: PROJECT_UUID,
    ...extra,
});

const accessEntry = (overrides: Partial<SpaceAccess> = {}): SpaceAccess => ({
    userUuid: USER_UUID,
    role: SpaceMemberRole.VIEWER,
    hasDirectAccess: true,
    projectRole: ProjectMemberRole.VIEWER,
    inheritedRole: OrganizationMemberRole.VIEWER,
    inheritedFrom: 'project',
    ...overrides,
});

const context = (
    overrides: Partial<ContentAccessContext> = {},
): ContentAccessContext => ({
    inheritsFromOrgOrProject: false,
    access: [],
    ...overrides,
});

/**
 * Mirrors the shape both ability-building paths emit for space-gated content
 * rules: `projectMemberAbility.ts` for built-in roles and `addAccessCondition`
 * in `scopes.ts` for custom roles produce exactly these conditions.
 */
const abilityGatedOnAccess = (role?: SpaceMemberRole): MemberAbility => {
    const builder = new AbilityBuilder<MemberAbility>(Ability);
    builder.can('view', 'Dashboard', {
        projectUuid: PROJECT_UUID,
        access: {
            $elemMatch: { userUuid: USER_UUID, ...(role ? { role } : {}) },
        },
    });
    builder.can('view', 'SavedChart', {
        projectUuid: PROJECT_UUID,
        access: { $elemMatch: { userUuid: USER_UUID } },
    });
    return builder.build();
};

describe('dashboardSubject', () => {
    describe('given a resolved access context', () => {
        it('then the access entries reach CASL', () => {
            const ability = abilityGatedOnAccess();

            expect(
                ability.can(
                    'view',
                    dashboardSubject(
                        context({ access: [accessEntry()] }),
                        resourceFields(),
                    ),
                ),
            ).toBe(true);
        });

        it('then an empty access array denies an access-gated rule', () => {
            const ability = abilityGatedOnAccess();

            expect(
                ability.can(
                    'view',
                    dashboardSubject(context(), resourceFields()),
                ),
            ).toBe(false);
        });

        it('then it is checked as a Dashboard, not a SavedChart', () => {
            const builder = new AbilityBuilder<MemberAbility>(Ability);
            builder.can('view', 'SavedChart');
            const ability = builder.build();

            expect(
                ability.can(
                    'view',
                    dashboardSubject(context(), resourceFields()),
                ),
            ).toBe(false);
        });
    });

    describe('given a context that also carries organization and project uuids', () => {
        it('then the resource own uuids are what reach CASL', () => {
            const ability = abilityGatedOnAccess();

            // SpaceAccessContextForCasl carries organizationUuid/projectUuid
            // resolved from the space, but call sites source them from the
            // resource. The builder must not silently re-source them: that would
            // change which org and project every migrated check is made against.
            expect(
                ability.can(
                    'view',
                    dashboardSubject(
                        {
                            ...context({ access: [accessEntry()] }),
                            organizationUuid: 'a-different-org',
                            projectUuid: 'a-different-project',
                        },
                        resourceFields(),
                    ),
                ),
            ).toBe(true);
        });
    });

    describe('given extra resource fields', () => {
        it('then they are carried onto the subject', () => {
            const builder = new AbilityBuilder<MemberAbility>(Ability);
            builder.can('view', 'Dashboard', {
                'metadata.dashboardUuid': 'dashboard-1',
            });
            const ability = builder.build();

            expect(
                ability.can(
                    'view',
                    dashboardSubject(
                        context(),
                        resourceFields({
                            metadata: { dashboardUuid: 'dashboard-1' },
                        }),
                    ),
                ),
            ).toBe(true);
        });

        it('then a stale access array on the resource cannot override the context', () => {
            const ability = abilityGatedOnAccess();

            // getByIdOrSlug merges the context into the DAO it returns, so a DAO
            // reaching a later check can already carry an `access` field.
            expect(
                ability.can(
                    'view',
                    dashboardSubject(
                        context({ access: [] }),
                        resourceFields({ access: [accessEntry()] }),
                    ),
                ),
            ).toBe(false);
        });

        it('then a stale inheritsFromOrgOrProject on the resource cannot override the context', () => {
            const builder = new AbilityBuilder<MemberAbility>(Ability);
            builder.can('view', 'Dashboard', {
                projectUuid: PROJECT_UUID,
                inheritsFromOrgOrProject: true,
            });
            const ability = builder.build();

            expect(
                ability.can(
                    'view',
                    dashboardSubject(
                        context({ inheritsFromOrgOrProject: false }),
                        resourceFields({ inheritsFromOrgOrProject: true }),
                    ),
                ),
            ).toBe(false);
        });
    });

    describe('given a role-gated rule', () => {
        it('then a viewer entry does not satisfy an editor gate', () => {
            const ability = abilityGatedOnAccess(SpaceMemberRole.EDITOR);

            expect(
                ability.can(
                    'view',
                    dashboardSubject(
                        context({
                            access: [
                                accessEntry({ role: SpaceMemberRole.VIEWER }),
                            ],
                        }),
                        resourceFields(),
                    ),
                ),
            ).toBe(false);
        });

        it('then an editor entry satisfies an editor gate', () => {
            const ability = abilityGatedOnAccess(SpaceMemberRole.EDITOR);

            expect(
                ability.can(
                    'view',
                    dashboardSubject(
                        context({
                            access: [
                                accessEntry({ role: SpaceMemberRole.EDITOR }),
                            ],
                        }),
                        resourceFields(),
                    ),
                ),
            ).toBe(true);
        });

        it('then only the role is consulted, not where the entry came from', () => {
            const ability = abilityGatedOnAccess(SpaceMemberRole.EDITOR);
            const provenances: SpaceAccess['inheritedFrom'][] = [
                'organization',
                'project',
                'group',
                'space_group',
                'parent_space',
                undefined,
            ];

            provenances.forEach((inheritedFrom) => {
                expect(
                    ability.can(
                        'view',
                        dashboardSubject(
                            context({
                                access: [
                                    accessEntry({
                                        role: SpaceMemberRole.EDITOR,
                                        inheritedFrom,
                                    }),
                                ],
                            }),
                            resourceFields(),
                        ),
                    ),
                ).toBe(true);
            });
        });
    });
});

describe('savedChartSubject', () => {
    it('given an access context, then it is checked as a SavedChart', () => {
        const ability = abilityGatedOnAccess();

        expect(
            ability.can(
                'view',
                savedChartSubject(
                    context({ access: [accessEntry()] }),
                    resourceFields(),
                ),
            ),
        ).toBe(true);
    });

    it('given an empty access array, then an access-gated rule denies it', () => {
        const ability = abilityGatedOnAccess();

        expect(
            ability.can('view', savedChartSubject(context(), resourceFields())),
        ).toBe(false);
    });
});
