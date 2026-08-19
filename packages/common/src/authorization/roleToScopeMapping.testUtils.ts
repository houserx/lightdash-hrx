import { ProjectMemberRole } from '../types/projectMemberRole';
import { getAllScopesForRole } from './roleToScopeMapping';

/**
 * Test utilities for role to scope mapping validation
 * These functions are only used for testing migration compatibility
 */

/**
 * Validates that a role properly inherits permissions from lower roles
 */
export const validateRoleInheritance = (): {
    valid: boolean;
    errors: string[];
} => {
    const errors: string[] = [];
    const roleOrder = [
        ProjectMemberRole.VIEWER,
        ProjectMemberRole.INTERACTIVE_VIEWER,
        ProjectMemberRole.EDITOR,
        ProjectMemberRole.DEVELOPER,
        ProjectMemberRole.ADMIN,
    ];

    for (let i = 1; i < roleOrder.length; i += 1) {
        const currentRole = roleOrder[i];
        const previousRole = roleOrder[i - 1];

        const currentScopes = new Set(getAllScopesForRole(currentRole));
        const previousScopes = getAllScopesForRole(previousRole);

        // Check that all previous scopes are included in current role
        for (const scope of previousScopes) {
            if (!currentScopes.has(scope)) {
                errors.push(
                    `Role ${currentRole} is missing inherited scope: ${scope} from ${previousRole}`,
                );
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    };
};
