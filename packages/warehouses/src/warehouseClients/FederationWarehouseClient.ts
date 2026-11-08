import { PostgresWarehouseClient } from './PostgresWarehouseClient';

/**
 * Client for the Federation Engine: the Postgres warehouse type with
 * `flavor: 'federation'` (docs/eng-1799/CONTRACTS.md §4.1).
 *
 * It speaks the Postgres wire protocol, so it keeps the Postgres SQL builder,
 * dialect and `WarehouseTypes.POSTGRES` everywhere. Engine-specific behaviour
 * (information_schema-only catalog, `SET hrx.identity` per query, no
 * `pg_matviews` gating) is layered on here.
 */
export class FederationWarehouseClient extends PostgresWarehouseClient {}
