/* eslint-disable */
// @ts-nocheck
// int-fix-attr-truthiness: Lightdash (ldq identityAttrsFromUserAttributes) and the MCP server
// (resolveAttrs over the Lightdash attributes API) turn the same resolved user attribute values
// into the same §3 claims, so a person gets the same access through Lightdash and through MCP.
import { load } from './support';

const CASES: [string[], boolean | 'agree'][] = [
    [['true'], true],
    [['true', 'true'], true],
    [['false'], false],
    [[], false],
    [['TRUE'], false],
    [[' true'], false],
    [['yes'], false],
    [['true', 'false'], 'agree'],
    [['false', 'true'], 'agree'],
    [['true', 'x'], 'agree'],
];

describe('int-fix-attr-truthiness', () => {
    it('both sides derive identical claims from identical attribute values', async () => {
        const { identityAttrsFromUserAttributes } = await load('packages/backend/src/services/FederationIdentity/identityToken.ts');
        const { resolveAttrs } = await load('packages/telemetry-mcp/src/auth/userMapping.ts');
        for (const [values, expected] of CASES) {
            for (const name of ['telemetry_restricted', 'platform_read', 'platform_write', 'platform_explain']) {
                const lightdash = identityAttrsFromUserAttributes({ [name]: values })[name];
                // The same values arriving through the attributes API: half direct, half from a group.
                const direct = values.slice(0, Math.ceil(values.length / 2));
                const grouped = values.slice(Math.ceil(values.length / 2));
                const mcp = resolveAttrs(
                    [
                        {
                            name,
                            users: direct.length ? [{ userUuid: 'u-1', values: direct }] : [],
                            groups: grouped.length ? [{ groupUuid: 'g-1', values: grouped }] : [],
                            attributeDefaults: [],
                        },
                    ],
                    'u-1',
                    new Set(['g-1']),
                )[name];
                expect(mcp, `${name} ${JSON.stringify(values)}`).toBe(lightdash);
                if (expected !== 'agree') expect(lightdash, `${name} ${JSON.stringify(values)}`).toBe(expected);
            }
        }
    });
});
