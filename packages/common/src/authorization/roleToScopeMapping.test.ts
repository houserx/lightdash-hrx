import { ProjectMemberRole } from '../types/projectMemberRole';
import { getAllScopesForRole, isSystemRoleName } from './roleToScopeMapping';
import { validateRoleInheritance } from './roleToScopeMapping.testUtils';

describe('roleToScopeMapping', () => {
    describe('isSystemRoleName', () => {
        it('should return true for valid system role "developer"', () => {
            expect(isSystemRoleName('developer')).toBe(true);
        });

        it('should return false for invalid role "1234"', () => {
            expect(isSystemRoleName('1234')).toBe(false);
        });

        it('should return true for all valid ProjectMemberRole values', () => {
            expect(isSystemRoleName('viewer')).toBe(true);
            expect(isSystemRoleName('interactive_viewer')).toBe(true);
            expect(isSystemRoleName('editor')).toBe(true);
            expect(isSystemRoleName('developer')).toBe(true);
            expect(isSystemRoleName('admin')).toBe(true);
        });

        it('should return false for invalid strings', () => {
            expect(isSystemRoleName('')).toBe(false);
            expect(isSystemRoleName('invalid-role')).toBe(false);
            expect(isSystemRoleName('custom-uuid-123')).toBe(false);
            expect(isSystemRoleName('VIEWER')).toBe(false); // Case sensitive
            expect(isSystemRoleName('Developer')).toBe(false); // Case sensitive
        });

        it('should work as a type guard', () => {
            const roleUuid: string = 'developer';

            if (isSystemRoleName(roleUuid)) {
                // TypeScript should now know that roleUuid is ProjectMemberRole
                expect(typeof roleUuid).toBe('string');
                expect(roleUuid).toBe('developer');
            } else {
                throw new Error(
                    'isSystemRoleName should return true for "developer"',
                );
            }
        });
    });

    describe('getScopesForRole', () => {
        it('should return scopes for viewer role', () => {
            const scopes = getAllScopesForRole(ProjectMemberRole.VIEWER);
            expect(scopes).toContain('view:Dashboard');
            expect(scopes).toContain('view:SavedChart');
            expect(scopes).toContain('view:Space');
            expect(scopes).toContain('view:Project');
        });

        it('should include inherited scopes for editor role', () => {
            const scopes = getAllScopesForRole(ProjectMemberRole.EDITOR);

            // Should have viewer scopes
            expect(scopes).toContain('view:Dashboard');
            expect(scopes).toContain('view:SavedChart');

            // Should have interactive viewer scopes
            expect(scopes).toContain('view:UnderlyingData');
            expect(scopes).toContain('manage:Explore');
            expect(scopes).toContain('create:ScheduledDeliveries');
            expect(scopes).toContain('manage:ScheduledDeliveries@self');

            // Should have editor-specific scopes
            expect(scopes).toContain('create:Space');
            expect(scopes).toContain('manage:DashboardComments');
        });

        it('should have more scopes for higher roles', () => {
            const viewerScopes = getAllScopesForRole(ProjectMemberRole.VIEWER);
            const editorScopes = getAllScopesForRole(ProjectMemberRole.EDITOR);
            const adminScopes = getAllScopesForRole(ProjectMemberRole.ADMIN);

            expect(editorScopes.length).toBeGreaterThan(viewerScopes.length);
            expect(adminScopes.length).toBeGreaterThan(editorScopes.length);
        });
    });

    describe('validateRoleInheritance', () => {
        it('should validate that roles properly inherit permissions', () => {
            const validation = validateRoleInheritance();

            expect(validation.valid).toBe(true);
            expect(validation.errors).toHaveLength(0);
        });
    });
});
