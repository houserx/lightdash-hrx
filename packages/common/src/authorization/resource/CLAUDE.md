<summary>
Folds direct per-resource grants into the access entries resolved for a resource's space.

A direct grant lets one user or group be given `view` or `manage` on a single Dashboard or
SavedChart without needing a space for it. This resolver turns those grants into ordinary
`SpaceAccess` entries and merges them with the space-derived ones, so the resulting `access`
array is the single thing a Dashboard/SavedChart CASL subject carries.

</summary>

<howToUse>

**Entry point:** `resolveResourceAccess(input: ResourceAccessWithGrantsInput): SpaceAccess[]`

Call it with the resource uuid, the output of `resolveSpaceAccess` for the space the resource
lives in, and the persisted grants. Grants for any other resource uuid are ignored, so a
batched fetch can be passed straight in.

</howToUse>

<codeExample>

```typescript
import { resolveResourceAccess, resolveSpaceAccess } from '@lightdash/common';

const spaceAccess = resolveSpaceAccess({
    /* ... */
});

const access = resolveResourceAccess({
    resourceUuid: dashboard.uuid,
    spaceAccess,
    directResourceAccess: grants[dashboard.uuid] ?? [],
});

// access: SpaceAccess[] — feeds subject('Dashboard', { ..., access })
```

</codeExample>

<importantToKnow>

- **Why this is not a second mechanism.** Lightdash resolves content access along a chain:
  `space -> ancestor spaces -> project -> org`, most permissive wins. A direct grant is one
  more link at the leaf end of that same chain. It produces the same entry type, feeds the
  same `access` array, and is read by the same CASL conditions — there is no parallel rule set
  and nothing new to audit.

- **Grants reuse the space role vocabulary.** `view` becomes `VIEWER`, `manage` becomes
  `EDITOR`. Every access-gated scope reduces to
  `access: { $elemMatch: { userUuid, role? } }`, so **no scope definition changes** and no
  `scoped_roles` migration is needed. `ADMIN` is deliberately unreachable from a grant: space
  administration is not a per-resource concept.

- **A `manage` grant also confers `promote` on that one resource.** `promote:Dashboard@space`
  tests the same EDITOR/ADMIN shape as `manage:Dashboard@space`, and the scope vocabulary
  already declares the latter a dependency of the former. It only applies to users who already
  hold the `promote` scope from their role.

- **Runs after `resolveSpaceAccess`, never inside it.** That resolver returns `undefined` for
  any user with no org or project role (its `highestRole` gate), which would silently discard
  users holding nothing but a grant.

- **Most permissive source wins — a deliberate divergence.** In space access a direct user
  entry beats a group entry regardless of height, so an admin can hold someone below their
  group's level. Grants are purely additive and cannot revoke anything, so here the highest
  grant wins instead. That is what makes "adding a grant never lowers anyone's access" a real
  invariant, asserted as a property test.

- **A grant cannot manufacture access on its own.** The entry only satisfies conditions on
  rules the user already holds. A user whose role carries no `view:Dashboard` scope — org
  `MEMBER`, which has three scopes and none of them content — gets nothing from a grant. This
  matches space sharing, where sharing with such a user is equally inert, and it means a grant
  to someone outside the organization is inert by construction rather than by a validation
  check that could be forgotten.

- **Attribution.** A merged entry is re-attributed `inheritedFrom: 'direct_resource'` only
  when the grant is what earned the role, so audit output keeps pointing at whichever source
  actually decided it. Merged entries always get `hasDirectAccess: true`, which is what keeps
  granted items visible through the `hasDirectAccessToSpace` filter on list endpoints.

- **Ordering is stable.** Existing entries keep their input order; grant-only users are
  appended sorted by uuid, so the output does not depend on the order grants arrive in.

</importantToKnow>

<links>

- Types: @packages/common/src/types/resourceAccess.ts
- The space-level resolver this composes with: @packages/common/src/authorization/space/spaceAccessResolver.ts
- Space access mental model: @packages/common/src/authorization/space/CLAUDE.md
- Tests: @packages/common/src/authorization/resource/resourceAccessResolver.test.ts
- Properties: @packages/common/src/authorization/resource/resourceAccessResolver.property.test.ts

</links>
