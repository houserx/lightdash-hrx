import {
    DimensionType,
    getErrorMessage,
    WAREHOUSE_LISTED_DATABASES_LIMIT,
    WarehouseQueryError,
    type CreatePostgresCredentials,
    type TimestampDomain,
    type WarehouseDatabaseListing,
} from '@lightdash/common';
import type { PoolClient } from 'pg';
import type { IdentityTokenProvider } from '../warehouseClientFromCredentials';
import {
    mapPostgresFieldType,
    PostgresWarehouseClient,
} from './PostgresWarehouseClient';

export type FederationWarehouseClientOptions = {
    agentSession?: boolean;
    /** Mints the CONTRACTS §3 identity token sent before each query. */
    getIdentityToken?: IdentityTokenProvider;
};

/** `SET hrx.identity = '<token>'`, with the token quoted as a SQL string literal. */
const getIdentityStatement = (token: string): string =>
    `SET hrx.identity = '${token.replaceAll("'", "''")}'`;

/**
 * The engine keeps `hrx.identity` for the life of the connection, and pooled connections are
 * shared by every user's queries; a query with no identity must not inherit the last one.
 */
const CLEAR_IDENTITY_STATEMENT = 'RESET hrx.identity';

/**
 * The engine's `information_schema.columns.data_type` is DataFusion's Arrow
 * type name (`Timestamp(µs, "UTC")`, `Utf8`, `Int64`, `Float64`,
 * `Decimal128(38, 9)`, `Date32`, `Boolean`), not a Postgres type name.
 * Anything that is not an Arrow name falls back to the Postgres mapping.
 */
const ARROW_FIELD_TYPES: ReadonlyArray<[RegExp, DimensionType]> = [
    [
        /^(U?Int(8|16|32|64)|Float(16|32|64)|Decimal(32|64|128|256)\b)/,
        DimensionType.NUMBER,
    ],
    [/^Date(32|64)$/, DimensionType.DATE],
    [/^(Timestamp|Time(32|64))\(/, DimensionType.TIMESTAMP],
    [/^Boolean$/, DimensionType.BOOLEAN],
    [
        /^(Utf8|LargeUtf8|Utf8View|Binary|LargeBinary|BinaryView|FixedSizeBinary|List|LargeList|FixedSizeList|Struct|Map|Dictionary|Interval|Duration|Null)\b/,
        DimensionType.STRING,
    ],
];

export const mapFederationFieldType = (dataType: string): DimensionType =>
    ARROW_FIELD_TYPES.find(([pattern]) => pattern.test(dataType))?.[1] ??
    mapPostgresFieldType(dataType);

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
     * no-identity rules. A provider that has no identity for this query
     * (`null`) clears the connection's identity instead.
     */
    protected async beforeQuery(client: PoolClient): Promise<void> {
        if (!this.getIdentityToken) {
            return;
        }
        const token = await this.getIdentityToken({
            agent: this.agentSession,
        });
        if (token === null) {
            await client.query(CLEAR_IDENTITY_STATEMENT);
            return;
        }
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

    protected mapCatalogFieldType(dataType: string): DimensionType {
        return mapFederationFieldType(dataType);
    }

    /**
     * Arrow type names carry no Postgres timestamp domain. Leaving the domain
     * unset keeps the catalog in the shape Lightdash had before domains
     * (no `__lightdashTimestampDomains` sidecar for engine tables).
     */
    protected getCatalogTimestampDomain(
        _dataType: string,
    ): TimestampDomain | undefined {
        return undefined;
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
