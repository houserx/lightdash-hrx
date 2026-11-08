// The Federation Engine is a flavour of the Postgres warehouse type, never a new
// WarehouseTypes member (docs/eng-1799/CONTRACTS.md §4.1).
import { WarehouseTypes, type CreatePostgresCredentials } from './projects';

export const FEDERATION_FLAVOR = 'federation' as const;

/** Port the Federation Engine's Postgres wire listener uses by default. */
export const FEDERATION_DEFAULT_PORT = 5433;

/** Database name the Federation Engine exposes by default. */
export const FEDERATION_DEFAULT_DBNAME = 'operations';

export type PostgresFlavor = NonNullable<CreatePostgresCredentials['flavor']>;

export type FederationCredentials<
    T extends { type: WarehouseTypes.POSTGRES } = CreatePostgresCredentials,
> = T & { flavor: typeof FEDERATION_FLAVOR };

/**
 * True for Postgres credentials (with or without secrets) whose flavour is
 * 'federation'. Absent flavour means plain Postgres.
 */
export const isFederationCredentials = <
    T extends { type: WarehouseTypes; flavor?: string },
>(
    credentials: T | undefined | null,
): credentials is T & {
    type: WarehouseTypes.POSTGRES;
    flavor: typeof FEDERATION_FLAVOR;
} =>
    credentials?.type === WarehouseTypes.POSTGRES &&
    credentials.flavor === FEDERATION_FLAVOR;

/**
 * A "federation project" is a project whose warehouse credentials have
 * flavor 'federation' (CONTRACTS §4.1).
 */
export const isFederationProject = (
    project:
        | {
              warehouseConnection?: { type: WarehouseTypes; flavor?: string };
          }
        | undefined
        | null,
): boolean => isFederationCredentials(project?.warehouseConnection);

/**
 * The ldq claims a user can hold (CONTRACTS §3 `attrs`). Each comes from the Lightdash user
 * attribute of the same name; only the value "true" is true.
 */
export type FederationAttrs = {
    telemetry_restricted: boolean;
    platform_read: boolean;
    platform_write: boolean;
    platform_explain: boolean;
};

/** What the app may know about a project's federation access. Never carries a secret. */
export type FederationAccess = {
    isFederation: boolean;
    attrs: FederationAttrs;
};

export type ApiFederationAccessResponse = {
    status: 'ok';
    results: FederationAccess;
};

/** Body of POST /api/v2/projects/{projectUuid}/write/confirmations (CONTRACTS §4.2). */
export type ApiWriteConfirmationRequest = {
    statement: string;
};

/** A single-statement Write Mode confirmation; `expiresAt` is the token's exp, ISO 8601. */
export type WriteConfirmation = {
    confirmationToken: string;
    expiresAt: string;
};

export type ApiWriteConfirmationResponse = {
    status: 'ok';
    results: WriteConfirmation;
};
