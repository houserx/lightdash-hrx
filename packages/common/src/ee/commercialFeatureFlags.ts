export enum CommercialFeatureFlags {
    Embedding = 'embedding',
    Scim = 'scim-token-management',
    AiCopilot = 'ai-copilot',
    ServiceAccounts = 'service-accounts',
    OrganizationWarehouseCredentials = 'organization-warehouse-credentials',
    CustomRoles = 'custom-roles',
    /** Multiple roles per organization/project (requires CustomRoles). Gates management surfaces only. */
    MultipleRoles = 'multiple-roles',
    HomepageBuilder = 'homepage-builder',
    /** Stages the cutover of project system roles from the hand-written
     * `projectMemberAbilities` builder onto `buildAbilityFromScopes` --
     * see plan item A5. Behaviorally verified equivalent by
     * `differentialEquivalence.test.ts`; this flag exists to roll the
     * change out safely, not because the two paths are expected to
     * diverge. */
    ScopeComposedSystemRoles = 'scope-composed-system-roles',
}
