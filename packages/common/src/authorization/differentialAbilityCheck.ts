import { subject } from '@casl/ability';
import fc from 'fast-check';
import { ProjectType } from '../types/projects';
import { getScopes } from './scopes';
import {
    type AbilityAction,
    type CaslSubjectNames,
    type MemberAbility,
} from './types';

/**
 * Shared machinery for differential behavioral-equivalence tests between a
 * hand-written role-based ability builder and a scope-based one fed some
 * scope list. Extracted from `differentialEquivalence.test.ts` (A1) so
 * `orgRoleToScopeMapping.test.ts` (A4) and future consumers (A6, A9 per the
 * refactor plan) don't each reimplement it. See `differentialEquivalence.test.ts`
 * for the original design rationale (Given/When/Then in its header comment).
 */

export type CASLRule = { action: string; subject: string };

export const OTHER_USER_UUID = 'other-user-uuid-0000';
export const OTHER_TENANT_UUID = 'other-tenant-uuid-0000';

export const ENTERPRISE_SUBJECTS = new Set([
    'MetricsTree',
    'SpotlightTableConfig',
    'AiAgent',
    'OrganizationAiAgent',
    'AiAgentDocument',
    'AiAgentThread',
    'AiDeepResearch',
    'ContentAsCode',
    'PreAggregation',
    'ExternalConnection',
    'ProjectHomepage',
    'OrganizationWarehouseCredentials',
    'Roadmap',
]);

/**
 * Concrete (non-`manage`) actions that some real scope in the vocabulary
 * actually declares for each subject. `manage` really does mean "any action"
 * in CASL, so a rule granting `manage:Job` genuinely does permit
 * `ability.can('impersonate', subject('Job', ...))` -- but no scope named
 * `impersonate:Job` exists and no controller ever checks that combination,
 * so treating it as a probe target only produces noise. Restricting `manage`
 * expansion to actions the vocabulary actually uses for that subject keeps
 * every probe meaningful.
 */
export const SUBJECT_TO_KNOWN_ACTIONS: Map<
    string,
    Set<AbilityAction>
> = (() => {
    const map = new Map<string, Set<AbilityAction>>();
    getScopes({ isEnterprise: true }).forEach((scope) => {
        const [action, subjectWithModifier] = scope.name.split(':');
        const subjectName = subjectWithModifier.split('@')[0];
        if (action === 'manage') return;
        const existing = map.get(subjectName) ?? new Set<AbilityAction>();
        existing.add(action as AbilityAction);
        map.set(subjectName, existing);
    });
    return map;
})();

/**
 * Turns built CASL rules into a probe set of concrete `action:subject` keys.
 * `manage` is expanded only to actions the real scope vocabulary uses for
 * that subject -- not CASL's full action union, most of which is meaningless
 * for any given subject. `excludedSubjects` drops subjects that are
 * dead-on-arrival for the context being tested (e.g. org-only subjects
 * probed with a project-shaped instance); `waivedKeys` drops specific
 * `action:subject` pairs already confirmed as intentional/deferred
 * asymmetries by the caller.
 */
export const extractProbeKeys = (
    rules: CASLRule[],
    isEnterprise: boolean,
    excludedSubjects: Set<string>,
    waivedKeys: Set<string>,
): Set<string> => {
    const keys = new Set<string>();
    rules.forEach((r) => {
        if (excludedSubjects.has(r.subject)) return;
        if (!isEnterprise && ENTERPRISE_SUBJECTS.has(r.subject)) return;
        if (r.action === 'manage') {
            const knownActions =
                SUBJECT_TO_KNOWN_ACTIONS.get(r.subject) ??
                new Set<AbilityAction>(['view']);
            knownActions.forEach((a) => keys.add(`${a}:${r.subject}`));
        } else {
            keys.add(`${r.action}:${r.subject}`);
        }
    });
    waivedKeys.forEach((k) => keys.delete(k));
    return keys;
};

export type Scenario = {
    sameTenant: boolean;
    createdBySelf: boolean;
    accessEntry:
        | 'none'
        | 'self-viewer'
        | 'self-editor'
        | 'self-admin'
        | 'other-viewer';
    inheritsFromOrgOrProject: boolean;
    isPreview: boolean;
};

export const scenarioArbitrary: fc.Arbitrary<Scenario> = fc.record({
    sameTenant: fc.boolean(),
    createdBySelf: fc.boolean(),
    accessEntry: fc.constantFrom(
        'none',
        'self-viewer',
        'self-editor',
        'self-admin',
        'other-viewer',
    ),
    inheritsFromOrgOrProject: fc.boolean(),
    isPreview: fc.boolean(),
});

export type ProbeMember = {
    userUuid: string;
    organizationUuid?: string;
    projectUuid?: string;
};

/** Builds a concrete resource *instance* to check the two abilities against.
 * Per this repo's own authorization convention (backend-review.md: "Permission
 * checks always execute against a subject using fields only from the
 * subject"), every field here is a property of the hypothetical RESOURCE
 * being checked -- never the caller's own identity, which is instead already
 * baked into the two abilities at build time via `member`. */
export const buildInstance = (
    scenario: Scenario,
    member: ProbeMember,
): Record<string, unknown> => {
    const isOrgContext = Boolean(member.organizationUuid);
    const ownTenantUuid = isOrgContext
        ? member.organizationUuid
        : member.projectUuid;
    const tenantUuid = scenario.sameTenant ? ownTenantUuid : OTHER_TENANT_UUID;
    const tenantCondition = isOrgContext
        ? { organizationUuid: tenantUuid }
        : { projectUuid: tenantUuid };

    const accessEntryMap: Record<
        Scenario['accessEntry'],
        { userUuid: string; role: string } | null
    > = {
        none: null,
        'self-viewer': { userUuid: member.userUuid, role: 'viewer' },
        'self-editor': { userUuid: member.userUuid, role: 'editor' },
        'self-admin': { userUuid: member.userUuid, role: 'admin' },
        'other-viewer': { userUuid: OTHER_USER_UUID, role: 'viewer' },
    };
    const accessEntry = accessEntryMap[scenario.accessEntry];
    // Ownership is checked under two different field names across the scope
    // vocabulary (`@self` conditions use whichever fits the subject -- see
    // authorization/CLAUDE.md's scope-suffix table: "usually userUuid or
    // createdByUserUuid"). A synthetic instance needs both, driven by the
    // same self/other flag, since it doesn't know in advance which name the
    // scope being probed will check.
    const ownerUuid = scenario.createdBySelf
        ? member.userUuid
        : OTHER_USER_UUID;

    return {
        ...tenantCondition,
        userUuid: ownerUuid,
        createdByUserUuid: ownerUuid,
        access: accessEntry ? [accessEntry] : [],
        inheritsFromOrgOrProject: scenario.inheritsFromOrgOrProject,
        ...(scenario.isPreview
            ? {
                  type: ProjectType.PREVIEW,
                  projectUuid: member.projectUuid ?? tenantUuid,
                  upstreamProjectUuid: member.projectUuid ?? tenantUuid,
                  createdByUserUuid: ownerUuid,
              }
            : {}),
        metadata: {},
    };
};

export const runDifferentialCheck = (
    reference: MemberAbility,
    candidate: MemberAbility,
    member: ProbeMember,
    probeKeys: string[],
) => {
    if (probeKeys.length === 0) return;
    fc.assert(
        fc.property(
            fc.constantFrom(...probeKeys),
            scenarioArbitrary,
            (key, scenario) => {
                const separatorIndex = key.indexOf(':');
                const action = key.slice(0, separatorIndex) as AbilityAction;
                // Genuinely one of CaslSubjectNames at runtime (built from
                // real rule subjects/scope names) -- cast because it arrives
                // here as a plain string, which TS can't narrow statically.
                const subjectName = key.slice(
                    separatorIndex + 1,
                ) as CaslSubjectNames;
                const instance = buildInstance(scenario, member);
                return (
                    reference.can(action, subject(subjectName, instance)) ===
                    candidate.can(action, subject(subjectName, instance))
                );
            },
        ),
        { numRuns: 200 },
    );
};
