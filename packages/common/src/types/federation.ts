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
