import { subject } from '@casl/ability';
import { OrganizationMemberRole } from '../../types/organizationMemberProfile';
import { ProjectMemberRole } from '../../types/projectMemberRole';
import {
    DirectResourceAccessOrigin,
    type DirectResourceAccess,
} from '../../types/resourceAccess';
import { defineUserAbility } from '../index';
import { resolveResourceAccess } from './resourceAccessResolver';

const HOME_ORG = 'org-home';
const HOME_PROJECT = 'project-home';
const OTHER_ORG = 'org-other';
const OTHER_PROJECT = 'project-other';
const DASHBOARD_UUID = 'dashboard-1';

const grantFor = (userUuid: string): DirectResourceAccess => ({
    userUuid,
    resourceUuid: DASHBOARD_UUID,
    groupUuid: null,
    action: 'view',
    from: DirectResourceAccessOrigin.USER_ACCESS,
});

const groupGrantFor = (userUuid: string): DirectResourceAccess => ({
    ...grantFor(userUuid),
    groupUuid: 'group-1',
    from: DirectResourceAccessOrigin.GROUP_ACCESS,
});

/** The dashboard always lives in the home organization's project. */
const canViewDashboard = (
    ability: ReturnType<typeof defineUserAbility>,
    grants: DirectResourceAccess[],
) => {
    const access = resolveResourceAccess({
        resourceUuid: DASHBOARD_UUID,
        spaceAccess: [],
        directResourceAccess: grants,
    });

    return ability.can(
        'view',
        subject('Dashboard', {
            organizationUuid: HOME_ORG,
            projectUuid: HOME_PROJECT,
            inheritsFromOrgOrProject: false,
            access,
            metadata: { dashboardUuid: DASHBOARD_UUID },
        }),
    );
};

/**
 * A grant is a row keyed by user uuid with no organization column and no
 * organization condition on the rule it satisfies. The write path rejects
 * out-of-organization recipients, but that check is one layer. These specs pin
 * the second, structural layer: a grant row that should never have existed --
 * inserted directly, or left behind by a bug -- must still confer nothing.
 *
 * The mechanism is that a grant only satisfies conditions on rules the principal
 * already holds. It cannot manufacture a rule.
 */
describe('cross-tenant isolation of direct grants', () => {
    describe('given a recipient whose access is in another organization', () => {
        it('then a grant on this dashboard confers nothing', () => {
            const outsider = defineUserAbility(
                {
                    userUuid: 'outsider',
                    role: OrganizationMemberRole.ADMIN,
                    organizationUuid: OTHER_ORG,
                    roleUuid: undefined,
                },
                [
                    {
                        projectUuid: OTHER_PROJECT,
                        role: ProjectMemberRole.ADMIN,
                        userUuid: 'outsider',
                        roleUuid: undefined,
                    },
                ],
            );

            // Admin everywhere they legitimately belong, and still nothing here.
            expect(canViewDashboard(outsider, [grantFor('outsider')])).toBe(
                false,
            );
        });

        it('then a group grant confers nothing either', () => {
            const outsider = defineUserAbility(
                {
                    userUuid: 'outsider',
                    role: OrganizationMemberRole.ADMIN,
                    organizationUuid: OTHER_ORG,
                    roleUuid: undefined,
                },
                [],
            );

            expect(
                canViewDashboard(outsider, [groupGrantFor('outsider')]),
            ).toBe(false);
        });
    });

    describe('given a recipient in the right organization but with no content scope', () => {
        it('then a grant confers nothing', () => {
            // Organization MEMBER carries three scopes, none of them content.
            const member = defineUserAbility(
                {
                    userUuid: 'member',
                    role: OrganizationMemberRole.MEMBER,
                    organizationUuid: HOME_ORG,
                    roleUuid: undefined,
                },
                [],
            );

            expect(canViewDashboard(member, [grantFor('member')])).toBe(false);
        });
    });

    describe('given a recipient in the right organization who holds the scope', () => {
        it('then the grant is what lets them in', () => {
            // Positive control. Without this the suite could pass vacuously --
            // every case above would also be false if grants simply never worked.
            const colleague = defineUserAbility(
                {
                    userUuid: 'colleague',
                    role: OrganizationMemberRole.MEMBER,
                    organizationUuid: HOME_ORG,
                    roleUuid: undefined,
                },
                [
                    {
                        projectUuid: HOME_PROJECT,
                        role: ProjectMemberRole.VIEWER,
                        userUuid: 'colleague',
                        roleUuid: undefined,
                    },
                ],
            );

            expect(canViewDashboard(colleague, [])).toBe(false);
            expect(canViewDashboard(colleague, [grantFor('colleague')])).toBe(
                true,
            );
        });

        it('then a grant made out to someone else confers nothing', () => {
            const colleague = defineUserAbility(
                {
                    userUuid: 'colleague',
                    role: OrganizationMemberRole.MEMBER,
                    organizationUuid: HOME_ORG,
                    roleUuid: undefined,
                },
                [
                    {
                        projectUuid: HOME_PROJECT,
                        role: ProjectMemberRole.VIEWER,
                        userUuid: 'colleague',
                        roleUuid: undefined,
                    },
                ],
            );

            expect(
                canViewDashboard(colleague, [grantFor('somebody-else')]),
            ).toBe(false);
        });
    });
});
