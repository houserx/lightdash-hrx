import { subject } from '@casl/ability';
import {
    ForbiddenError,
    NotFoundError,
    ParameterError,
    type SessionUser,
} from '@lightdash/common';
import { type Knex } from 'knex';

export const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lowercase letters, digits and single hyphens, as in as-code documents. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type AlertingSubject =
    | 'AlertRule'
    | 'ContactPoint'
    | 'NotificationRoute';
export type AlertingAction = 'view' | 'manage';

const POSTGRES_UNIQUE_VIOLATION = '23505';

export const isUniqueViolation = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === POSTGRES_UNIQUE_VIOLATION;

/** Organization of a project, or undefined when it doesn't exist. */
export const findProjectOrganizationUuid = async (
    database: Knex,
    projectUuid: string,
): Promise<string | undefined> => {
    const row = await database('projects')
        .innerJoin(
            'organizations',
            'organizations.organization_id',
            'projects.organization_id',
        )
        .where('projects.project_uuid', projectUuid)
        .first<{ organization_uuid: string } | undefined>(
            'organizations.organization_uuid',
        );
    return row?.organization_uuid;
};

/**
 * 404 for an unknown (or non-uuid) project, 403 unless the user may
 * `action` the alerting subject in it. Runs before anything else in a
 * request, so outsiders can't learn what exists.
 */
export const assertAlertingAbility = async (
    lookup: {
        findProjectOrganizationUuid(
            projectUuid: string,
        ): Promise<string | undefined>;
    },
    user: SessionUser,
    action: AlertingAction,
    subjectName: AlertingSubject,
    projectUuid: string,
): Promise<void> => {
    const organizationUuid = UUID_PATTERN.test(projectUuid)
        ? await lookup.findProjectOrganizationUuid(projectUuid)
        : undefined;
    if (!organizationUuid) {
        throw new NotFoundError('Project not found');
    }
    if (
        user.ability.cannot(
            action,
            subject(subjectName, { organizationUuid, projectUuid }),
        )
    ) {
        throw new ForbiddenError();
    }
};

/** The query parameter's values; repeated parameters arrive as an array. */
export const queryValues = (key: string, value: unknown): string[] => {
    if (value === undefined) return [];
    const values = Array.isArray(value) ? value : [value];
    if (!values.every((v): v is string => typeof v === 'string')) {
        throw new ParameterError(`${key} must be a string`);
    }
    return values;
};

/** The query parameter's value; 400 when it is given more than once. */
export const singleQueryValue = (
    key: string,
    value: unknown,
): string | undefined => {
    const values = queryValues(key, value);
    if (values.length > 1) {
        throw new ParameterError(`${key} must be given at most once`);
    }
    return values[0];
};

/** `base`, or `base-2`, `base-3`… : the first one not in `taken`. */
export const nextFreeSlug = (base: string, taken: Iterable<string>): string => {
    const used = new Set(taken);
    if (!used.has(base)) return base;
    let suffix = 2;
    while (used.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
};

/** LIKE pattern matching every slug that starts with `prefix`. */
export const slugPrefixPattern = (prefix: string): string =>
    `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
