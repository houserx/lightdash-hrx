/**
 * Okta user -> Lightdash user, through the Lightdash REST API with the service-account token (Contract assumption 1).
 *
 * The Okta `email` claim (or an email-shaped `sub` when there is no email claim) is looked up with
 * `GET /api/v1/org/users?searchQuery=<email>&includeGroups=<n>`. Lightdash's search is a substring match, so only
 * the active user whose email equals the claim (case-insensitively) counts. The four §3 attrs come from
 * `GET /api/v1/org/attributes`: the user's direct value, else a `"true"` value from one of the user's groups, else
 * the attribute default. Only the exact string `"true"` is true.
 *
 * Not here yet: the per-user TTL cache (`mcp-user-mapping-cache`) and the empty tool list for unknown users
 * (`mcp-unknown-user-no-tools`).
 */
import type { JWTPayload } from 'jose';
import type { Config } from '../config.js';
import type { IdentityAttrs } from '../identity/token.js';

/** How many groups per member Lightdash includes in the user lookup; groups beyond this are not seen. */
export const LIGHTDASH_GROUPS_PER_USER = 1000;

/** Gives up on a Lightdash call after this long. */
export const LIGHTDASH_TIMEOUT_MS = 10_000;

export interface MappedUser {
    /** Lightdash user uuid. */
    userUuid: string;
    /** The Lightdash user's email. */
    email: string;
    organizationUuid: string;
    attrs: IdentityAttrs;
}

export interface UserResolver {
    /** The Lightdash user for verified Okta claims, or rejects with `UserMappingError`. */
    resolve(claims: JWTPayload): Promise<MappedUser>;
}

/** A user that could not be mapped. The message is a fixed sentence, safe to show to the MCP client. */
export class UserMappingError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'UserMappingError';
    }
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The email to map: the `email` claim, else an email-shaped `sub`. */
export function emailFromClaims(claims: JWTPayload): string | undefined {
    const email = (claims as { email?: unknown }).email;
    if (typeof email === 'string' && email.trim() !== '') return email.trim();
    if (typeof claims.sub === 'string' && EMAIL_SHAPE.test(claims.sub)) return claims.sub;
    return undefined;
}

interface LightdashMember {
    userUuid?: unknown;
    email?: unknown;
    organizationUuid?: unknown;
    isActive?: unknown;
    groups?: { uuid?: unknown }[];
}

interface LightdashAttribute {
    name?: unknown;
    users?: { userUuid?: unknown; value?: unknown }[];
    groups?: { groupUuid?: unknown; value?: unknown }[];
    attributeDefault?: unknown;
}

/** Resolves the four §3 attrs for a user from Lightdash's attribute list. */
export function resolveAttrs(
    attributes: readonly LightdashAttribute[],
    userUuid: string,
    groupUuids: ReadonlySet<string>,
): IdentityAttrs {
    const value = (name: string): boolean => {
        const attribute = attributes.find((a) => a.name === name);
        if (!attribute) return false;
        const direct = attribute.users?.find((u) => u.userUuid === userUuid);
        if (direct) return direct.value === 'true';
        const viaGroup = attribute.groups?.some(
            (g) => typeof g.groupUuid === 'string' && groupUuids.has(g.groupUuid) && g.value === 'true',
        );
        if (viaGroup) return true;
        return attribute.attributeDefault === 'true';
    };
    return {
        telemetry_restricted: value('telemetry_restricted'),
        platform_read: value('platform_read'),
        platform_write: value('platform_write'),
        platform_explain: value('platform_explain'),
    };
}

export function createLightdashUserResolver(lightdash: Config['lightdash']): UserResolver {
    const get = async (path: string): Promise<unknown> => {
        let response: Response;
        try {
            response = await fetch(`${lightdash.url}${path}`, {
                headers: { Authorization: `ApiKey ${lightdash.apiToken}`, Accept: 'application/json' },
                signal: AbortSignal.timeout(LIGHTDASH_TIMEOUT_MS),
            });
        } catch (err) {
            throw new UserMappingError('Could not reach Lightdash to look up your user', { cause: err });
        }
        if (!response.ok) {
            throw new UserMappingError(`Lightdash refused the user lookup (HTTP ${response.status})`);
        }
        const body = (await response.json().catch(() => null)) as { results?: unknown } | null;
        return body?.results;
    };

    return {
        async resolve(claims) {
            const email = emailFromClaims(claims);
            if (!email) throw new UserMappingError('Your access token has no email to match a Lightdash user');
            const query = new URLSearchParams({ searchQuery: email, includeGroups: String(LIGHTDASH_GROUPS_PER_USER) });
            const users = (await get(`/api/v1/org/users?${query.toString()}`)) as { data?: unknown } | undefined;
            const members = Array.isArray(users?.data) ? (users.data as LightdashMember[]) : [];
            const wanted = email.toLowerCase();
            const member = members.find(
                (m) =>
                    typeof m.email === 'string' &&
                    m.email.toLowerCase() === wanted &&
                    m.isActive === true &&
                    typeof m.userUuid === 'string' &&
                    typeof m.organizationUuid === 'string',
            );
            if (!member) throw new UserMappingError('Your Okta user has no active Lightdash user with the same email');
            const userUuid = member.userUuid as string;
            const groupUuids = new Set(
                (member.groups ?? []).map((g) => g.uuid).filter((u): u is string => typeof u === 'string'),
            );
            const attributes = await get('/api/v1/org/attributes');
            return {
                userUuid,
                email: member.email as string,
                organizationUuid: member.organizationUuid as string,
                attrs: resolveAttrs(Array.isArray(attributes) ? attributes : [], userUuid, groupUuids),
            };
        },
    };
}
