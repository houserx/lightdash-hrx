import {
    getErrorMessage,
    WAREHOUSE_LISTED_DATABASES_LIMIT,
    WarehouseQueryError,
    type CreatePostgresCredentials,
    type WarehouseDatabaseListing,
} from '@lightdash/common';
import type { PoolClient } from 'pg';
import type { IdentityTokenProvider } from '../warehouseClientFromCredentials';
import { PostgresWarehouseClient } from './PostgresWarehouseClient';

export type FederationWarehouseClientOptions = {
    agentSession?: boolean;
    /** Mints the CONTRACTS §3 identity token sent before each query. */
    getIdentityToken?: IdentityTokenProvider;
};

/** `SET hrx.identity = '<token>'`, with the token quoted as a SQL string literal. */
const getIdentityStatement = (token: string): string =>
    `SET hrx.identity = '${token.replaceAll("'", "''")}'`;

/** Replace every occurrence of the token (raw or SQL-quoted) with a marker. */
const redactToken = (text: string, token: string): string =>
    [token, token.replaceAll("'", "''")]
        .filter((value) => value.length > 0)
        .reduce((acc, value) => acc.split(value).join('[redacted]'), text);

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
    private readonly getIdentityToken: IdentityTokenProvider | undefined;

    constructor(
        credentials: CreatePostgresCredentials,
        options?: FederationWarehouseClientOptions,
    ) {
        super(credentials, options);
        this.getIdentityToken = options?.getIdentityToken;
    }

    /**
     * CONTRACTS §3: immediately before each query, on the connection that
     * runs it, send a freshly minted identity token. The provider is called
     * once per query (and per retry attempt), so no token is ever reused.
     * Without a provider nothing is sent and the engine applies its own
     * no-identity rules.
     */
    protected async beforeQuery(client: PoolClient): Promise<void> {
        if (!this.getIdentityToken) {
            return;
        }
        const token = await this.getIdentityToken({
            agent: this.agentSession,
        });
        try {
            await client.query(getIdentityStatement(token));
        } catch (error) {
            // The engine's error may echo the rejected value. Raise a fresh
            // error with the token redacted and no `cause`, so neither the
            // message nor a serialised error can carry the token. A
            // WarehouseQueryError passes through streamQuery's parseError
            // unchanged.
            throw new WarehouseQueryError(
                `Federation identity was rejected: ${redactToken(
                    getErrorMessage(error),
                    token,
                )}`,
            );
        }
    }

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
