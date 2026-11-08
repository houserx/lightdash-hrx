/**
 * The engine session of one authenticated `/mcp` request: every query runs as the caller's Lightdash user.
 *
 * The Okta claims are mapped to the Lightdash user on the first query of the request (so `initialize`, `ping` and
 * `tools/list` cost no Lightdash call), and every query then gets its own §3 identity token: `iss telemetry-mcp`,
 * `agent true`, a fresh `iat` from the server clock and a fresh nonce.
 */
import type { JWTPayload } from 'jose';
import type { MappedUser, UserResolver } from '../auth/userMapping.js';
import type { Config } from '../config.js';
import { mintIdentityToken } from '../identity/token.js';
import type { EngineSession } from './client.js';

export function createIdentitySession(
    config: Pick<Config, 'identitySecret' | 'statementTimeoutMs' | 'lightdash'>,
    resolver: UserResolver,
    claims: JWTPayload,
    now: () => number,
): EngineSession {
    let user: Promise<MappedUser> | undefined;
    return {
        statementTimeoutMs: config.statementTimeoutMs,
        async identityToken(audit) {
            user ??= resolver.resolve(claims);
            const { userUuid, email, organizationUuid, attrs } = await user;
            return mintIdentityToken({
                secret: config.identitySecret,
                sub: userUuid,
                email,
                org: organizationUuid,
                project: config.lightdash.projectUuid,
                attrs,
                audit,
                nowSeconds: Math.floor(now() / 1000),
            });
        },
    };
}
