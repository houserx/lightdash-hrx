import { ProjectMemberRole } from '../types/projectMemberRole';
import { getAllScopesForRole, isSystemRole } from './roleToScopeMapping';
import { validateRoleInheritance } from './roleToScopeMapping.testUtils';

describe('roleToScopeMapping', () => {
    describe('isSystemRole', () => {
        it('should return true for valid system role "developer"', () => {
            expect(isSystemRole('developer')).toBe(true);
        });

        it('should return false for invalid role "1234"', () => {
            expect(isSystemRole('1234')).toBe(false);
        });

        it('should return true for all valid ProjectMemberRole values', () => {
            expect(isSystemRole('viewer')).toBe(true);
            expect(isSystemRole('interactive_viewer')).toBe(true);
            expect(isSystemRole('editor')).toBe(true);
            expect(isSystemRole('developer')).toBe(true);
            expect(isSystemRole('admin')).toBe(true);
        });

        it('should return false for invalid strings', () => {
            expect(isSystemRole('')).toBe(false);
            expect(isSystemRole('invalid-role')).toBe(false);
            expect(isSystemRole('custom-uuid-123')).toBe(false);
            expect(isSystemRole('VIEWER')).toBe(false); // Case sensitive
            expect(isSystemRole('Developer')).toBe(false); // Case sensitive
        });

        it('should work as a type guard', () => {
            const roleUuid: string = 'developer';

            if (isSystemRole(roleUuid)) {
                // TypeScript should now know that roleUuid is ProjectMemberRole
                expect(typeof roleUuid).toBe('string');
                expect(roleUuid).toBe('developer');
            } else {
                throw new Error(
                    'isSystemRole should return true for "developer"',
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
