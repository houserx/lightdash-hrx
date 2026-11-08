/**
 * Okta access-token verification for `/mcp`.
 *
 * Tokens are compact JWS signed by Okta with RS256. A token is accepted only when its signature verifies against a key
 * in Okta's JWKS (`OKTA_JWKS_URI`) and its claims hold: `iss` equals `OKTA_ISSUER` exactly, `aud` is (or contains)
 * `OKTA_AUDIENCE`, `exp` is present and in the future, and `nbf`, when present, is not in the future. Every other
 * algorithm (including `none` and HMAC) is refused before any key is looked up.
 *
 * The JWKS is fetched lazily on the first verification, never at startup, and cached by jose's remote key set.
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';
import type { Config } from '../config.js';

/** Okta signs access tokens with RS256 only. */
export const ACCEPTED_ALGORITHMS = ['RS256'] as const;

/** Allowed clock skew between Okta and this server when checking `exp` and `nbf`. */
export const CLOCK_TOLERANCE_SECONDS = 30;

/** Minimum time between two JWKS fetches triggered by an unknown `kid`. */
export const JWKS_COOLDOWN_MS = 1000;

export interface VerifiedAccessToken {
    /** The raw bearer token, as sent. */
    token: string;
    /** The verified claims. */
    claims: JWTPayload;
}

export interface AccessTokenVerifier {
    /** Resolves with the verified claims, or rejects with `AccessTokenError`. */
    verify(token: string): Promise<VerifiedAccessToken>;
}

/**
 * A rejected token. `description` is a fixed sentence chosen by the verifier: it never contains anything taken from the
 * token, so it is safe to put in a `WWW-Authenticate` challenge or a response body.
 */
export class AccessTokenError extends Error {
    readonly description: string;

    constructor(description: string, options?: { cause?: unknown }) {
        super(description, options);
        this.name = 'AccessTokenError';
        this.description = description;
    }
}

function describeFailure(err: unknown): string {
    if (err instanceof errors.JWTExpired) return 'The access token has expired';
    if (err instanceof errors.JWTClaimValidationFailed) {
        if (err.claim === 'nbf') return 'The access token is not valid yet';
        if (err.claim === 'exp') return 'The access token has no expiry';
        if (err.claim === 'iss') return 'The access token was not issued by the expected authorization server';
        if (err.claim === 'aud') return 'The access token is not intended for this resource';
    }
    if (err instanceof errors.JOSEAlgNotAllowed) return 'The access token is not signed with an accepted algorithm';
    return 'The access token could not be verified';
}

export function createOktaVerifier(okta: Config['okta']): AccessTokenVerifier {
    const jwks = createRemoteJWKSet(new URL(okta.jwksUri), { cooldownDuration: JWKS_COOLDOWN_MS });
    return {
        async verify(token) {
            try {
                const { payload } = await jwtVerify(token, jwks, {
                    algorithms: [...ACCEPTED_ALGORITHMS],
                    issuer: okta.issuer,
                    audience: okta.audience,
                    requiredClaims: ['exp'],
                    clockTolerance: CLOCK_TOLERANCE_SECONDS,
                });
                return { token, claims: payload };
            } catch (err) {
                throw new AccessTokenError(describeFailure(err), { cause: err });
            }
        },
    };
}
