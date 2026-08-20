import knex from 'knex';
import { MockClient } from 'knex-mock-client';
import { ContentFilters } from '../ContentModelTypes';
import { dashboardContentConfiguration } from './DashboardContentConfiguration';
import { dbtExploreChartContentConfiguration } from './DbtExploreChartContentConfiguration';

const db = knex({ client: MockClient, dialect: 'pg' });

const SPACE_UUID = 'space-1';
const GRANTED_UUID = 'granted-1';

/**
 * Content browse filters by space reachability, so a resource shared directly --
 * without access to its space -- would be openable by link and findable in search
 * but absent from browse. These widen the space predicate with the resources the
 * user holds a grant on.
 */
describe.each([
    ['dashboard', dashboardContentConfiguration],
    ['chart', dbtExploreChartContentConfiguration],
] as const)('%s content browse', (_name, configuration) => {
    const buildQuery = (filters: ContentFilters) =>
        configuration.getSummaryQuery(db, filters).toSQL();

    it('given no grants, then only the space filter applies', () => {
        // The resource uuid column appears in the select list either way, so the
        // binding is what distinguishes a widened predicate from a plain one.
        const { sql, bindings } = buildQuery({ spaceUuids: [SPACE_UUID] });

        expect(sql).toContain('"spaces"."space_uuid"');
        expect(bindings).toContain(SPACE_UUID);
        expect(bindings).not.toContain(GRANTED_UUID);
    });

    it('given grants, then granted resources are included alongside reachable spaces', () => {
        const { sql, bindings } = buildQuery({
            spaceUuids: [SPACE_UUID],
            grantedResourceUuids: [GRANTED_UUID],
        });

        expect(sql).toContain('or');
        expect(bindings).toContain(SPACE_UUID);
        expect(bindings).toContain(GRANTED_UUID);
    });

    it('given an empty grant list, then no empty IN clause is emitted', () => {
        const { sql, bindings } = buildQuery({
            spaceUuids: [SPACE_UUID],
            grantedResourceUuids: [],
        });

        expect(bindings).toContain(SPACE_UUID);
        expect(bindings).not.toContain(GRANTED_UUID);
        expect(sql).not.toContain('in ()');
    });

    it('given grants but no space filter, then nothing is narrowed', () => {
        // No space filter means the caller is not restricting by space at all.
        // Introducing one here would narrow an unrestricted query.
        const { bindings } = buildQuery({
            grantedResourceUuids: [GRANTED_UUID],
        });

        expect(bindings).not.toContain(GRANTED_UUID);
    });
});
