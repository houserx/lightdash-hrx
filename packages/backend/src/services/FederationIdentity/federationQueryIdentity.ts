/**
 * Who a query on Lightdash's async query path runs as, for the Federation Engine (CONTRACTS §3).
 *
 * Warehouse clients are cached and shared by every user of a project, so the identity can't be
 * bound when a client is built. The query path runs each warehouse query inside
 * `withFederationQueryIdentity`, and the token provider a federation-flavour client is built with
 * (`FederationIdentityService.createScopedTokenProvider`) reads the scope of the query it is about
 * to run. Outside a scope there is no identity.
 */
import {
    QuerySurface,
    type ExecuteAsyncQueryRequestParams,
    type QueryAudit,
} from '@lightdash/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IdentityAttrs, IdentityAudit } from './identityToken';

export type FederationQueryAudit = Partial<IdentityAudit> &
    Pick<IdentityAudit, 'source'>;

/** A Lightdash user: the token carries their email and current user attributes. */
export type FederationUserQueryIdentity = {
    userUuid: string;
    organizationUuid: string;
    /** The project the query runs on; a token is only minted for this project's connection. */
    projectUuid: string;
    audit: FederationQueryAudit;
};

/**
 * A system identity (`sys = true`, never an agent), such as the alert evaluator
 * (CONTRACTS §4.3). It has no Lightdash user, so its subject, email and attrs are given.
 */
export type FederationSystemQueryIdentity = {
    system: {
        sub: string;
        email: string;
        attrs: IdentityAttrs;
    };
    organizationUuid: string;
    /** The project the query runs on; a token is only minted for this project's connection. */
    projectUuid: string;
    audit: FederationQueryAudit;
};

export type FederationQueryIdentity =
    | FederationUserQueryIdentity
    | FederationSystemQueryIdentity;

export const isFederationSystemQueryIdentity = (
    identity: FederationQueryIdentity,
): identity is FederationSystemQueryIdentity => 'system' in identity;

const scope = new AsyncLocalStorage<FederationQueryIdentity>();

/** Runs `fn` with `identity` as the identity of every federation query it starts. */
export const withFederationQueryIdentity = <T>(
    identity: FederationQueryIdentity,
    fn: () => T,
): T => scope.run(identity, fn);

/** The identity of the query being run, if any. */
export const getFederationQueryIdentity = ():
    | FederationQueryIdentity
    | undefined => scope.getStore();

/**
 * The token's `audit` block for an async query, from its persisted request parameters:
 *   - a dashboard tile: source `tile`, `resource_uuid` = the tile uuid;
 *   - a query from Lightdash's MCP surface: source `mcp`;
 *   - anything else (SQL Runner / Investigate, Explore, charts): source `investigate`.
 * The description and ticket come from the request's Audited Query `audit`, when it has one.
 */
export const federationQueryAudit = (
    requestParameters:
        | ExecuteAsyncQueryRequestParams
        | { audit?: QueryAudit }
        | undefined,
    querySurface: QuerySurface | undefined,
): FederationQueryAudit => {
    const audit =
        requestParameters && 'audit' in requestParameters
            ? requestParameters.audit
            : undefined;
    const tileUuid =
        requestParameters && 'tileUuid' in requestParameters
            ? requestParameters.tileUuid
            : undefined;
    const fromRequest = {
        description: audit?.description ?? null,
        ticket: audit?.ticket ?? null,
    };
    if (tileUuid) {
        return { ...fromRequest, source: 'tile', resource_uuid: tileUuid };
    }
    return {
        ...fromRequest,
        source: querySurface === QuerySurface.MCP ? 'mcp' : 'investigate',
        resource_uuid: null,
    };
};
