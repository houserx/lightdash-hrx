import {
    WAREHOUSE_LISTED_DATABASES_LIMIT,
    type WarehouseDatabaseListing,
} from '@lightdash/common';
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
export class FederationWarehouseClient extends PostgresWarehouseClient {
    /**
     * The engine exposes only `information_schema.tables` and
     * `information_schema.columns`; nothing from `pg_catalog` is guaranteed
     * (CONTRACTS §1.1). Reporting no materialized-view support makes
     * `getAllTables`, `getFields` and `getCatalog` skip their
     * `pg_matviews`/`pg_class` branches, and skips the `version()` lookup
     * that gates them.
     */
    protected async supportsMatviews(): Promise<boolean> {
        return false;
    }

    /**
     * The engine serves a single database (the configured `dbname`). Listing
     * would otherwise read `pg_database`, and any other database would be
     * opened with a plain Postgres client that bypasses this class.
     */
    async listDatabases(): Promise<WarehouseDatabaseListing> {
        const { dbname } = this.credentials;
        return {
            databases: [
                {
                    name: dbname,
                    database: dbname,
                    schema: null,
                    isDefault: true,
                },
            ],
            truncated: false,
            limit: WAREHOUSE_LISTED_DATABASES_LIMIT,
        };
    }
}
