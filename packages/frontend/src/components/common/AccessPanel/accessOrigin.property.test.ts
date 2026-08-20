import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
    ACCESS_ORIGIN_LABELS,
    getAccessOriginLabel,
    type AccessOrigin,
} from './accessOrigin';

/**
 * A frozen copy of the implementation this replaces, lifted verbatim from
 * `ShareSpaceModalContent.tsx`. It is the oracle for the refactor: the new
 * function must agree with it on every input a space can produce, and disagree
 * on exactly one input -- the resource grant it was never written to handle.
 *
 * Kept as a literal copy rather than an import so deleting the original cannot
 * quietly weaken this file into comparing the new code against itself.
 */
const legacyGetOriginLabel = (share: AccessOrigin): string => {
    if (share.inheritedFrom === 'parent_space') return 'Parent';
    if (share.hasDirectAccess) {
        return share.inheritedFrom === 'space_group' ? 'Group' : 'Direct';
    }
    if (share.inheritedFrom === 'space_group') return 'Group';
    if (share.inheritedFrom === 'project' || share.inheritedFrom === 'group') {
        return 'Project';
    }
    if (share.inheritedFrom === 'organization') return 'Organization';
    return 'Direct';
};

/** Every origin a space can resolve to. `direct_resource` is deliberately absent. */
const SPACE_ORIGINS: AccessOrigin['inheritedFrom'][] = [
    'organization',
    'project',
    'group',
    'space_group',
    'parent_space',
    undefined,
];

const spaceOriginArb: fc.Arbitrary<AccessOrigin> = fc.record({
    inheritedFrom: fc.constantFrom(...SPACE_ORIGINS),
    hasDirectAccess: fc.boolean(),
});

const anyOriginArb: fc.Arbitrary<AccessOrigin> = fc.record({
    inheritedFrom: fc.constantFrom(
        ...SPACE_ORIGINS,
        'direct_resource' as const,
    ),
    hasDirectAccess: fc.boolean(),
});

describe('given access that a space resolved', () => {
    describe('when it is labelled with where it came from', () => {
        it.each([
            {
                inheritedFrom: 'parent_space' as const,
                hasDirectAccess: false,
                label: 'Parent',
            },
            {
                inheritedFrom: 'space_group' as const,
                hasDirectAccess: false,
                label: 'Group',
            },
            {
                inheritedFrom: 'project' as const,
                hasDirectAccess: false,
                label: 'Project',
            },
            {
                inheritedFrom: 'group' as const,
                hasDirectAccess: false,
                label: 'Project',
            },
            {
                inheritedFrom: 'organization' as const,
                hasDirectAccess: false,
                label: 'Organization',
            },
            // A share on the space itself outranks whatever role got them there
            {
                inheritedFrom: 'project' as const,
                hasDirectAccess: true,
                label: 'Direct',
            },
            {
                inheritedFrom: 'organization' as const,
                hasDirectAccess: true,
                label: 'Direct',
            },
            {
                inheritedFrom: undefined,
                hasDirectAccess: true,
                label: 'Direct',
            },
        ])(
            'then $inheritedFrom with direct access $hasDirectAccess reads $label',
            ({ label, ...origin }) => {
                expect(getAccessOriginLabel(origin)).toBe(label);
            },
        );

        test.prop([spaceOriginArb])(
            'then it reads exactly as it did before this was extracted',
            (origin) => {
                expect(getAccessOriginLabel(origin)).toBe(
                    legacyGetOriginLabel(origin),
                );
            },
        );
    });
});

describe('given access granted directly on a dashboard or chart', () => {
    describe('when it is labelled with where it came from', () => {
        it('then it is not passed off as a share on the space', () => {
            const grant: AccessOrigin = {
                inheritedFrom: 'direct_resource',
                hasDirectAccess: true,
            };

            // The defect: the space vocabulary has no word for a grant on the
            // resource, so every one of them arrived here reading "Direct" --
            // indistinguishable from a share on the surrounding space.
            expect(legacyGetOriginLabel(grant)).toBe('Direct');
            expect(getAccessOriginLabel(grant)).toBe('Granted');
        });

        test.prop([fc.boolean()])(
            'then it reads the same however the resolver attributed the role',
            (hasDirectAccess) => {
                expect(
                    getAccessOriginLabel({
                        inheritedFrom: 'direct_resource',
                        hasDirectAccess,
                    }),
                ).toBe('Granted');
            },
        );

        test.prop([anyOriginArb])(
            'then nothing else can read as granted',
            (origin) => {
                if (getAccessOriginLabel(origin) === 'Granted') {
                    expect(origin.inheritedFrom).toBe('direct_resource');
                }
            },
        );
    });
});

describe('given any access at all', () => {
    describe('when it is labelled with where it came from', () => {
        test.prop([anyOriginArb])(
            'then the label is one the surface knows how to render',
            (origin) => {
                expect(ACCESS_ORIGIN_LABELS).toContain(
                    getAccessOriginLabel(origin),
                );
            },
        );

        test.prop([anyOriginArb])(
            'then holding a direct share only ever changes an inherited label',
            (origin) => {
                const asShared = getAccessOriginLabel({
                    ...origin,
                    hasDirectAccess: true,
                });
                const asInherited = getAccessOriginLabel({
                    ...origin,
                    hasDirectAccess: false,
                });

                // Access attributed to the project or the organization is the
                // only kind a direct share can relabel. Anything else names a
                // specific source, and a share elsewhere cannot rename it.
                if (asShared !== asInherited) {
                    expect(['Project', 'Organization']).toContain(asInherited);
                    expect(asShared).toBe('Direct');
                }
            },
        );
    });
});
