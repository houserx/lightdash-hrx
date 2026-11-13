/**
 * Okta user -> Lightdash user, through the Lightdash REST API with the service-account token (Contract assumption 1).
 *
 * The Okta `email` claim (or an email-shaped `sub` when there is no email claim) is looked up with
 * `GET /api/v1/org/users?searchQuery=<email>&includeGroups=<n>`. Lightdash's search is a substring match, so only
 * the active user whose email equals the claim (case-insensitively) counts. The four §3 attrs come from
 * `GET /api/v1/org/attributes`, resolved like Lightdash does (the user's direct and group values, else the attribute
 * defaults); an attr is true only when that resolves to exactly `"true"` (see `resolveAttrs`).
 *
 * A caller that does not map gets no tools at all (see `serveMcpRequest`). The server puts the per-user TTL cache
 * (`createCachedUserResolver`) in front of this resolver.
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

interface LightdashAttributeValue {
    values?: unknown;
    /** Deprecated by Lightdash in favour of `values`; still sent. */
    value?: unknown;
}

interface LightdashAttribute {
    name?: unknown;
    users?: (LightdashAttributeValue & { userUuid?: unknown })[];
    groups?: (LightdashAttributeValue & { groupUuid?: unknown })[];
    attributeDefaults?: unknown;
    /** Deprecated by Lightdash in favour of `attributeDefaults`; still sent. */
    attributeDefault?: unknown;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

/** A user or group entry's values, like Lightdash's `getUserAttributeValues`: `values`, else a non-empty `value`. */
function entryValues(entry: LightdashAttributeValue): string[] {
    const values = strings(entry.values);
    if (values.length > 0) return values;
    return typeof entry.value === 'string' && entry.value !== '' ? [entry.value] : [];
}

/** An attribute's defaults, like Lightdash's `getAttributeDefaultValues`: `attributeDefaults`, else the legacy field. */
function defaultValues(attribute: LightdashAttribute): string[] {
    if (attribute.attributeDefaults !== undefined) return strings(attribute.attributeDefaults);
    const legacy = attribute.attributeDefault;
    if (Array.isArray(legacy)) return strings(legacy);
    return typeof legacy === 'string' && legacy !== '' ? [legacy] : [];
}

/**
 * Resolves the four §3 attrs for a user from Lightdash's attribute list.
 *
 * The values are resolved the way Lightdash resolves them for its own queries
 * (`UserAttributesModel.getAttributeValuesForOrgMember`): the user's direct values together with the values of every
 * group the user is in, or, only when there are none, the attribute's defaults. An attr is true only when that
 * resolves to the single value `"true"` (Contract assumption: CONTRACTS §3 "the value `"true"` is true; anything
 * else is false", so a conflicting set such as `["false", "true"]` is false).
 */
export function resolveAttrs(
    attributes: readonly LightdashAttribute[],
    userUuid: string,
    groupUuids: ReadonlySet<string>,
): IdentityAttrs {
    const value = (name: string): boolean => {
        const attribute = attributes.find((a) => a.name === name);
        if (!attribute) return false;
        const assigned = [
            ...(attribute.users ?? []).filter((u) => u.userUuid === userUuid).flatMap(entryValues),
            ...(attribute.groups ?? [])
                .filter((g) => typeof g.groupUuid === 'string' && groupUuids.has(g.groupUuid))
                .flatMap(entryValues),
        ];
        const resolved = new Set(assigned.length > 0 ? assigned : defaultValues(attribute));
        return resolved.size === 1 && resolved.has('true');
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
