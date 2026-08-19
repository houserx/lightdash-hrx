import { subject } from '@casl/ability';
import { type SpaceAccess } from '../../types/space';

/**
 * The resolved access context a content permission check must be made against.
 * Structurally satisfied by the backend's `SpaceAccessContextForCasl`, and by
 * the resource-aware context that folds direct grants in via
 * `resolveResourceAccess`.
 */
export type ContentAccessContext = {
    organizationUuid: string;
    projectUuid: string;
    inheritsFromOrgOrProject: boolean;
    access: SpaceAccess[];
};

/**
 * Anything else the subject should carry -- typically the resource DAO and its
 * `metadata`. Spread first so the resolved context always wins: a DAO that
 * happens to carry its own `access` or `inheritsFromOrgOrProject` must not be
 * able to grant what the context withheld.
 */
type ContentSubjectFields = Record<string, unknown>;

const contentSubject = <T extends 'Dashboard' | 'SavedChart'>(
    subjectType: T,
    context: ContentAccessContext,
    fields?: ContentSubjectFields,
) => subject(subjectType, { ...fields, ...context });

/**
 * Builds the CASL subject for a Dashboard permission check.
 *
 * Taking the context as a required argument is the point: it is what makes a
 * check that forgot to resolve access a compile error rather than a silently
 * permissive one.
 */
export const dashboardSubject = (
    context: ContentAccessContext,
    fields?: ContentSubjectFields,
) => contentSubject('Dashboard', context, fields);

/** Builds the CASL subject for a SavedChart permission check. */
export const savedChartSubject = (
    context: ContentAccessContext,
    fields?: ContentSubjectFields,
) => contentSubject('SavedChart', context, fields);
