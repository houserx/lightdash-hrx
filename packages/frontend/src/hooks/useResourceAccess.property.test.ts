import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import {
    buildResourceAccessQueryString,
    getResourceAccessQueryKey,
    RESOURCE_ACCESS_QUERY_KEY,
    type ResourceAccessQueryParams,
} from './useResourceAccess';

/**
 * The falsy edges -- `0`, `''`, `false` -- are drawn as their own weighted
 * branches rather than left to chance inside a range. They are the exact values a
 * truthiness check silently drops, and `fc.nat()` picks 0 too rarely to be relied
 * on: a `if (params.page)` regression survived 100 runs of a uniform generator.
 */
const optionalNat: fc.Arbitrary<number | undefined> = fc.oneof(
    { arbitrary: fc.constant(undefined), weight: 2 },
    { arbitrary: fc.constant(0), weight: 2 },
    { arbitrary: fc.nat({ max: 5000 }), weight: 6 },
);

const optionalSearchQuery: fc.Arbitrary<string | undefined> = fc.oneof(
    { arbitrary: fc.constant(undefined), weight: 2 },
    { arbitrary: fc.constant(''), weight: 2 },
    { arbitrary: fc.string(), weight: 6 },
);

const optionalBoolean: fc.Arbitrary<boolean | undefined> = fc.oneof(
    { arbitrary: fc.constant(undefined), weight: 1 },
    { arbitrary: fc.constant(false), weight: 1 },
    { arbitrary: fc.constant(true), weight: 1 },
);

const paramsArb: fc.Arbitrary<ResourceAccessQueryParams> = fc.record({
    page: optionalNat,
    pageSize: optionalNat,
    searchQuery: optionalSearchQuery,
    directOnly: optionalBoolean,
});

const resourceTypeArb = fc.constantFrom(
    'Dashboard' as const,
    'SavedChart' as const,
);

/**
 * The two collapses the serializer is allowed to make, because in both cases the
 * omitted form and the explicit form ask the server the same question: an empty
 * search matches everything, and `directOnly` defaults to false.
 *
 * Note what is *not* in here: there is no array-valued param, so there is no
 * "empty array vs absent" case to normalize away. That ambiguity is unrepresentable
 * in a repeated query param, and the server treats the two differently, so the
 * param is deliberately absent from this surface rather than normalized here.
 */
const normalize = (
    params: ResourceAccessQueryParams,
): ResourceAccessQueryParams => ({
    page: params.page,
    pageSize: params.pageSize,
    searchQuery: params.searchQuery === '' ? undefined : params.searchQuery,
    directOnly: params.directOnly === false ? undefined : params.directOnly,
});

/**
 * Decoded with the platform parser rather than a hand-written inverse, because
 * the platform parser is what the browser and the server actually use. A bespoke
 * inverse could share a bug with the encoder and the round trip would still pass.
 */
const decode = (queryString: string): ResourceAccessQueryParams => {
    const parsed = new URLSearchParams(queryString);
    const page = parsed.get('page');
    const pageSize = parsed.get('pageSize');
    const searchQuery = parsed.get('searchQuery');
    const directOnly = parsed.get('directOnly');
    return {
        page: page === null ? undefined : Number(page),
        pageSize: pageSize === null ? undefined : Number(pageSize),
        searchQuery: searchQuery === null ? undefined : searchQuery,
        directOnly: directOnly === null ? undefined : directOnly === 'true',
    };
};

describe('given any set of resource access query params', () => {
    describe('when they are serialized into a request', () => {
        test.prop([paramsArb])(
            'then the server is asked exactly what was requested',
            (params) => {
                expect(decode(buildResourceAccessQueryString(params))).toEqual(
                    normalize(params),
                );
            },
        );

        test.prop([paramsArb])(
            'then every emitted value is well formed for the endpoint validator',
            (params) => {
                const parsed = new URLSearchParams(
                    buildResourceAccessQueryString(params),
                );

                // The bug class: `page=undefined` / `page=NaN` reaching the API
                for (const key of ['page', 'pageSize']) {
                    const value = parsed.get(key);
                    if (value !== null) expect(value).toMatch(/^\d+$/);
                }

                // Only ever sent to turn the filter on -- never `directOnly=false`
                const directOnly = parsed.get('directOnly');
                if (directOnly !== null) expect(directOnly).toBe('true');
            },
        );

        test.prop([paramsArb, paramsArb])(
            'then two different questions never collapse into one request',
            (a, b) => {
                if (
                    buildResourceAccessQueryString(a) ===
                    buildResourceAccessQueryString(b)
                ) {
                    expect(normalize(a)).toEqual(normalize(b));
                }
            },
        );
    });

    describe('when they are turned into a cache key', () => {
        test.prop([fc.uuid(), resourceTypeArb, fc.uuid(), paramsArb])(
            'then every page of one resource shares a single invalidation prefix',
            (projectUuid, resourceType, resourceUuid, params) => {
                const key = getResourceAccessQueryKey(
                    projectUuid,
                    resourceType,
                    resourceUuid,
                    params,
                );

                // What makes invalidateQueries([...4-element prefix]) reach every
                // cached page. Put a param ahead of the identity and invalidation
                // silently misses pages.
                expect(key.slice(0, 4)).toEqual([
                    RESOURCE_ACCESS_QUERY_KEY,
                    projectUuid,
                    resourceType,
                    resourceUuid,
                ]);
            },
        );

        test.prop([
            fc.uuid(),
            resourceTypeArb,
            fc.uuid(),
            paramsArb,
            paramsArb,
        ])(
            'then two different questions never share a cache entry',
            (projectUuid, resourceType, resourceUuid, a, b) => {
                const keyA = getResourceAccessQueryKey(
                    projectUuid,
                    resourceType,
                    resourceUuid,
                    a,
                );
                const keyB = getResourceAccessQueryKey(
                    projectUuid,
                    resourceType,
                    resourceUuid,
                    b,
                );

                if (JSON.stringify(keyA) === JSON.stringify(keyB)) {
                    expect(normalize(a)).toEqual(normalize(b));
                }
            },
        );
    });
});
