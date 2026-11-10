import {
    buildPlatformColumnsSql,
    PLATFORM_TABLES_SQL,
    type RawResultRow,
} from '@lightdash/common';
import { useMemo } from 'react';
import { useLightdashApi } from '../../../providers/LightdashApi/useLightdashApi';
import { executeSqlQuery } from '../../queryRunner/executeQuery';
import {
    type PlatformColumn,
    type PlatformSchemaLoaders,
    type PlatformTable,
} from '../components/PlatformSchemaBrowser';

const text = (value: unknown) =>
    value === null || value === undefined ? '' : String(value);

// Postgres booleans can arrive as a boolean or as their text form.
const bool = (value: unknown) =>
    value === true || value === 'true' || value === 't';

/**
 * Reads the Platform Database catalog for the schema browser through the same SQL query API
 * Investigate runs on. platform_tables() and platform_columns() are Audited Queries, so each
 * read carries a description saying the schema browser made it.
 */
export const usePlatformSchemaLoaders = (
    projectUuid: string | undefined,
): PlatformSchemaLoaders => {
    const lightdashApi = useLightdashApi();
    return useMemo(() => {
        const run = async (sql: string, description: string) => {
            if (!projectUuid) throw new Error('No project selected');
            const { results } = await executeSqlQuery(
                lightdashApi,
                projectUuid,
                sql,
                undefined,
                undefined,
                undefined,
                undefined,
                { audit: { description } },
            );
            return results;
        };
        return {
            loadTables: async (): Promise<PlatformTable[]> =>
                (
                    await run(
                        PLATFORM_TABLES_SQL,
                        'Schema browser: list Platform Database tables',
                    )
                ).map((row: RawResultRow) => ({
                    table_schema: text(row.table_schema),
                    table_name: text(row.table_name),
                })),
            loadColumns: async (
                tableSchema: string,
                tableName: string,
            ): Promise<PlatformColumn[]> =>
                (
                    await run(
                        buildPlatformColumnsSql(tableSchema, tableName),
                        `Schema browser: list columns of ${tableSchema}.${tableName}`,
                    )
                ).map((row: RawResultRow) => ({
                    column_name: text(row.column_name),
                    data_type: text(row.data_type),
                    is_nullable: bool(row.is_nullable),
                })),
        };
    }, [lightdashApi, projectUuid]);
};
