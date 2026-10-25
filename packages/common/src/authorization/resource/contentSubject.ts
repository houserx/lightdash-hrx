import { subject } from '@casl/ability';
import { type SpaceAccess } from '../../types/space';

/**
 * The resolved access half of a content permission check -- the part a call site
 * must not be able to forget.
 *
 * Deliberately excludes organizationUuid/projectUuid even though the backend's
 * `SpaceAccessContextForCasl` carries them: call sites source those from the
 * resource, and re-sourcing them from the space-resolved context would change
 * which organization and project every check is made against. Structurally
 * satisfied by that context, and by the resource-aware context that folds direct
 * grants in via `resolveResourceAccess`.
 */
export type ContentAccessContext = {
    inheritsFromOrgOrProject: boolean;
    access: SpaceAccess[];
};

/**
 * What the call site supplies from the resource. organizationUuid and projectUuid
 * are required because every access-gated rule is scoped by one of them; the rest
 * is passthrough, typically the resource DAO and its `metadata`.
 */
export type ContentSubjectFields = Record<string, unknown> & {
    organizationUuid: string;
    projectUuid: string;
};

const contentSubject = (
    subjectType: 'Dashboard' | 'SavedChart',
    context: ContentAccessContext,
    fields: ContentSubjectFields,
) =>
    subject(subjectType, {
        ...fields,
        // Applied last: a resource DAO can already carry these -- getByIdOrSlug
        // merges the context into the DAO it returns -- and a stale copy must
        // never grant what the resolved context withheld.
        inheritsFromOrgOrProject: context.inheritsFromOrgOrProject,
        access: context.access,
    });

/**
 * Builds the CASL subject for a Dashboard permission check.
 *
 * Taking the resolved access context as a required argument is the point: it is
 * what makes a check that forgot to resolve access a compile error rather than a
 * silently unmatched one.
 */
export const dashboardSubject = (
    context: ContentAccessContext,
    fields: ContentSubjectFields,
) => contentSubject('Dashboard', context, fields);

/** Builds the CASL subject for a SavedChart permission check. */
export const savedChartSubject = (
    context: ContentAccessContext,
    fields: ContentSubjectFields,
) => contentSubject('SavedChart', context, fields);
