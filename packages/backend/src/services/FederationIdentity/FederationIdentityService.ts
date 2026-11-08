/**
 * Mints CONTRACTS §3 identity tokens for a Lightdash user running a query on a Federation
 * Engine project. The token's `attrs` are read from the user's Lightdash user attributes.
 */
import type { UserAttributesModel } from '../../models/UserAttributesModel';
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
};

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
                attrs: identityAttrsFromUserAttributes(userAttributes),
                audit,
            },
            { secret, now: this.clock() },
        );
    }
}
