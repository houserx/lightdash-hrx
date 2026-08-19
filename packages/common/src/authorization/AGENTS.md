# Authorization Roles And Permissions

This folder is the main authorization surface for Lightdash. TypeScript files are the source of truth; this note is a map for agents.

## Core Files

| File                                    | Purpose                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `index.ts`                              | Builds user abilities by combining org + project membership layers, both via `buildAbilityFromScopes`. |
| `scopes.ts`                             | Scope vocabulary and conditions for every role, built-in and custom. Exhaustive permission list lives here, not in this doc. |
| `scopeAbilityBuilder.ts`                | Converts a scope list into CASL rules — the single ability-building primitive, used by every principal type.     |
| `roleToScopeMapping.ts`                 | Maps built-in project roles to their literal, flat scope lists (`PROJECT_ROLE_TO_SCOPES_MAP`).                    |
| `orgRoleToScopeMapping.ts`              | Maps built-in organization roles to their literal, flat scope lists (`ORGANIZATION_ROLE_TO_SCOPES_MAP`).          |
| `serviceAccountAbility.ts`              | Legacy service-account scopes plus `system:*` delegation (also via `buildAbilityFromScopes`).                     |
| `types.ts`                              | CASL subject/action type definitions.                                                                             |
| `../types/organizationMemberProfile.ts` | Organization system role enum and labels.                                                                         |
| `../types/projectMemberRole.ts`         | Project system role enum, labels, and system-role order.                                                          |
| `../types/space.ts`                     | Space role enum and space access types.                                                                           |

## Ability Model

A user's ability is the union of two independent layers, both built through the same primitive, `buildAbilityFromScopes`:

| Layer        | Source                     | Scopes                                                                                                                                                                    |
| ------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization | `organization_memberships` | `getAllScopesForOrgRole(role)` when `role_uuid` is null (system role); the custom role's own scopes when `role_uuid` is set — for both human users and service accounts. |
| Project      | `project_memberships`      | `getAllScopesForRole(role)` when `role_uuid` is null; the custom role's own scopes when `role_uuid` is set.                                                                                        |

There is no separate hand-written builder for built-in roles anymore — a system role is just a fixed, literal scope list fed through the same `buildAbilityFromScopes` call a custom role uses. (Before this refactor, built-in roles had their own `organizationMemberAbility.ts`/`projectMemberAbility.ts` CASL builders with function-call inheritance; those are gone.)

CASL rules are additive. Project permissions cannot revoke organization permissions. If the org layer grants a permission, a narrower project custom role cannot remove it.

Org-level custom roles are a supported human-user surface. Assigning one (`upsertOrganizationUserRoleAssignment` with a custom `roleId`) sets `organization_memberships.role_uuid` and stores `role = 'member'`; the role's `level` must be `'organization'` (validated at assign time, alongside an org-ownership check). At runtime, when `role_uuid` is set and custom roles are enabled, the org layer is built from that role's scopes and **replaces** the system-role org abilities — it does not add on top of `member`. So an org-level custom role must be self-contained: it has to list every org scope its users need (including basic `view:*`), because the system-role defaults do not apply underneath it. This mirrors project custom roles, which replace the project system role rather than extending it. SCIM still assigns system org roles only (`setUserOrgAndProjectRoles`).

## Custom Roles Are Part Of The Contract

Do not reason about authorization only from built-in role ordering. `ProjectRoleOrder`, `OrganizationMemberRole`, `roleToScopeMapping.ts`'s `PROJECT_ROLE_TO_SCOPES_MAP`, and `orgRoleToScopeMapping.ts`'s `ORGANIZATION_ROLE_TO_SCOPES_MAP` describe stock roles only, as flat literal scope lists — not a linear viewer → admin hierarchy derived by inheritance. Custom roles grant arbitrary individual scopes and don't fit that hierarchy either.

Treat each scope in `scopes.ts` as a user-facing permission contract:

- Adding a new permission means adding/updating the scope vocabulary, not only adding a scope to a system role's literal list.
- Renaming, splitting, merging, or removing a scope needs a `scoped_roles` migration so existing custom roles keep their intended access.
- `roleToScopeMapping.ts`/`orgRoleToScopeMapping.ts` are the sole source of truth for built-in role scopes — there's no second hand-written builder to keep in sync with anymore.
- A role's `level` (`'project' | 'organization'`) gates which scopes it may hold and where it can be assigned: org-level roles may only contain org-assignable scopes (`getOrgAssignableScopes` / `isScopeAssignableAtLevel`) and build org-level conditions with `{ organizationUuid }`; project-level roles build project-level conditions with `{ projectUuid }`. This applies to both human-user and service-account custom roles.
- Org-level grants are deliberately hard to restrict with project-level custom roles because layers are additive.

## Role Types

| Type                       | Meaning                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in organization role | `member`, `viewer`, `interactive_viewer`, `editor`, `developer`, `admin`; scopes in `orgRoleToScopeMapping.ts`.                                                                      |
| Built-in project role      | `viewer`, `interactive_viewer`, `editor`, `developer`, `admin`; scopes in `roleToScopeMapping.ts`.                                                                                   |
| Custom role                | Row in `roles` plus rows in `scoped_roles`; assigned to project users/groups, or to service accounts through their internal org membership. Built through `scopeAbilityBuilder.ts`. |
| Space role                 | Direct user/group access on a space; affects content rules that check `access` and `SpaceMemberRole`.                                                                               |

Built-in roles do not inherit by function call anymore. Every role — built-in or custom — is exactly its own flat, explicit list of scopes (composition, not inheritance): built-in roles' lists live in `roleToScopeMapping.ts`/`orgRoleToScopeMapping.ts`, custom roles' lists live in `scoped_roles`. `admin` includes every scope `developer` has because its literal list happens to be a superset, not because it calls `developer`'s builder.

## Scope Conditions

Scope suffixes are condition hints, not hierarchy levels:

| Suffix      | Usual meaning                                                                      |
| ----------- | ---------------------------------------------------------------------------------- |
| `@self`     | Current user only, usually `userUuid` or `createdByUserUuid`.                      |
| `@space`    | Requires matching space access, usually editor/admin depending on scope.           |
| `@assigned` | Requires assigned space access, currently space admin for `manage:Space@assigned`. |
| `@public`   | Public/inherited content or space condition.                                       |
| `@preview`  | Preview project condition.                                                         |

Always verify exact conditions in `scopes.ts`; suffix names are shorthand only.

## Principal Types

| Principal             | Permission behavior                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser session user  | Uses the authenticated user's org/project membership rows.                                                                                                                                                      |
| Personal access token | Inherits the owning user's membership rows.                                                                                                                                                                     |
| Service account       | Uses its linked internal user/org membership: custom role when `organization_memberships.role_uuid` is set, otherwise legacy service-account scopes; `system:*` delegates to organization system-role builders. |
| SCIM token            | Uses constrained legacy `scim:manage`, not the normal role stack.                                                                                                                                               |
| Embed JWT             | Uses separate embedded-dashboard authorization, not normal memberships.                                                                                                                                         |

## Practical Rules For Changes

| Rule                                                                    | Why it matters                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Add new CASL subjects to `types.ts`.                                    | Keeps action/subject checks typed.                                   |
| Add custom-role coverage to `scopes.ts`.                                | Custom roles cannot grant permissions without a scope.               |
| Update `roleToScopeMapping.ts` and/or `orgRoleToScopeMapping.ts` to change what a built-in role grants. | These flat literal lists are the sole source of truth for built-in roles now — no second builder to keep in sync. |
| Add `scoped_roles` migrations for scope vocabulary changes.             | Existing custom roles persist scope names as strings.                |
| Add/extend fixture cases in `*.fixture.test.ts` when touching roles/scopes. | The differential hand-written-vs-scope-composed harness that used to catch drift was deleted along with the hand-written builders — fixtures are the regression oracle now. |
| Check both org and project layers when debugging.                       | Either additive layer can grant access.                              |
| Check space access for private/assigned content.                        | Many content rules depend on `access` entries and `SpaceMemberRole`. |

See also:

- `docs/authentication-and-roles.md`
- `docs/authorization-scopes.md`
- `docs/service-accounts.md`
