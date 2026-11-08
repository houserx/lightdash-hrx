/**
 * Mints CONTRACTS §3 identity tokens for a Lightdash user running a query on a Federation
 * Engine project. The token's `attrs` are read from the user's Lightdash user attributes.
 */
import type { IdentityTokenProvider } from '@lightdash/warehouses';
import type { UserAttributesModel } from '../../models/UserAttributesModel';
import { agentExecutionContext } from '../AiAccessService/agentExecutionContext';
import {
    identityAttrsFromUserAttributes,
    mintIdentityToken,
    type IdentityAudit,
} from './identityToken';

export type FederationIdentityUser = {
    userUuid: string;
    email: string;
    organizationUuid: string;
};

export type MintForUserArgs = {
    /** The connection's identity signing secret. */
    secret: string;
    user: FederationIdentityUser;
    projectUuid: string;
    audit: Partial<IdentityAudit> & Pick<IdentityAudit, 'source'>;
    /**
     * Whether the query runs in an AI agent session, as WarehouseClientFactory passes it
     * to PostgresWarehouseClient. When omitted, a live agent execution context means agent.
     */
    agentSession?: boolean;
};

/** Everything a token needs except the agent flag, which the client reports per query. */
export type CreateTokenProviderArgs = Omit<MintForUserArgs, 'agentSession'>;

/** An explicit flag wins; otherwise any live agent execution context is an agent session. */
export const isAgentSession = (agentSession?: boolean): boolean =>
    agentSession ?? agentExecutionContext.getStore() !== undefined;

type FederationIdentityServiceArguments = {
    userAttributesModel: Pick<
        UserAttributesModel,
        'getAttributeValuesForOrgMember'
    >;
    /** Clock; defaults to the current time. */
    clock?: () => Date;
};

export class FederationIdentityService {
    private readonly userAttributesModel: FederationIdentityServiceArguments['userAttributesModel'];

    private readonly clock: () => Date;

    constructor({
        userAttributesModel,
        clock = () => new Date(),
    }: FederationIdentityServiceArguments) {
        this.userAttributesModel = userAttributesModel;
        this.clock = clock;
    }

    /** A fresh token for `user` on `projectUuid`, with attrs from their user attributes. */
    async mintForUser({
        secret,
        user,
        projectUuid,
        audit,
        agentSession,
    }: MintForUserArgs): Promise<string> {
        const userAttributes =
            await this.userAttributesModel.getAttributeValuesForOrgMember({
                organizationUuid: user.organizationUuid,
                userUuid: user.userUuid,
            });
        return mintIdentityToken(
            {
                iss: 'lightdash',
                sub: user.userUuid,
                email: user.email,
                org: user.organizationUuid,
                project: projectUuid,
                agent: isAgentSession(agentSession),
                attrs: identityAttrsFromUserAttributes(userAttributes),
                audit,
            },
            { secret, now: this.clock() },
        );
    }

    /**
     * The `getIdentityToken` option for a federation-flavour warehouse client: every call
     * mints a fresh token (new nonce, iat and exp, current user attributes). The client
     * reports whether it runs in an agent session, and that flag is passed through as is.
     */
    createTokenProvider(args: CreateTokenProviderArgs): IdentityTokenProvider {
        return ({ agent }) =>
            this.mintForUser({ ...args, agentSession: agent });
    }
}
