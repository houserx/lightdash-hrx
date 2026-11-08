/**
 * Federation Engine (ldq) features of a project that never go through the async query path
 * (CONTRACTS §4.2). It reads the project with its credentials, so nothing it returns may
 * carry a credential field.
 */
import { subject } from '@casl/ability';
import {
    ForbiddenError,
    isFederationCredentials,
    isFederationProject,
    NotSupportedError,
    ParameterError,
    type FederationAccess,
    type RegisteredAccount,
    type WriteConfirmation,
} from '@lightdash/common';
import type { ProjectModel } from '../../models/ProjectModel/ProjectModel';
import type { UserAttributesModel } from '../../models/UserAttributesModel';
import { BaseService } from '../BaseService';
import { identityAttrsFromUserAttributes } from '../FederationIdentity/identityToken';
import { mintWriteConfirmationToken } from './writeConfirmationToken';

type FederationServiceArguments = {
    projectModel: Pick<ProjectModel, 'getWithSensitiveFields'>;
    userAttributesModel: Pick<
        UserAttributesModel,
        'getAttributeValuesForOrgMember'
    >;
};

export class FederationService extends BaseService {
    private readonly projectModel: FederationServiceArguments['projectModel'];

    private readonly userAttributesModel: FederationServiceArguments['userAttributesModel'];

    constructor({
        projectModel,
        userAttributesModel,
    }: FederationServiceArguments) {
        super();
        this.projectModel = projectModel;
        this.userAttributesModel = userAttributesModel;
    }

    /** Loads the project (with credentials) after checking the account may view it. */
    private async getViewableProject(
        account: RegisteredAccount,
        projectUuid: string,
    ) {
        const project =
            await this.projectModel.getWithSensitiveFields(projectUuid);
        const { organizationUuid } = project;
        if (
            this.createAuditedAbility(account).cannot(
                'view',
                subject('Project', {
                    organizationUuid,
                    projectUuid,
                    metadata: { projectUuid, projectName: project.name },
                }),
            )
        ) {
            throw new ForbiddenError();
        }
        return project;
    }

    private async getAttrs(
        account: RegisteredAccount,
        organizationUuid: string,
    ) {
        const userAttributes =
            await this.userAttributesModel.getAttributeValuesForOrgMember({
                organizationUuid,
                userUuid: account.user.userUuid,
            });
        return identityAttrsFromUserAttributes(userAttributes);
    }

    /**
     * Whether the project is a federation project, and which ldq claims the account's user
     * holds in the project's organization. Requires view access to the project.
     */
    async getAccess(
        account: RegisteredAccount,
        projectUuid: string,
    ): Promise<FederationAccess> {
        const project = await this.getViewableProject(account, projectUuid);
        return {
            isFederation: isFederationProject(project),
            attrs: await this.getAttrs(account, project.organizationUuid),
        };
    }

    /**
     * CONTRACTS §4.2: a single-statement Write Mode confirmation token for the account's user
     * on a federation project. Requires view access and the platform_write user attribute.
     * Nothing is sent to the engine; the engine verifies the token when the write runs.
     */
    async createWriteConfirmation(
        account: RegisteredAccount,
        projectUuid: string,
        statement: unknown,
    ): Promise<WriteConfirmation> {
        if (typeof statement !== 'string' || statement.trim() === '') {
            throw new ParameterError('A statement is required');
        }
        const project = await this.getViewableProject(account, projectUuid);
        const credentials = project.warehouseConnection;
        if (!isFederationCredentials(credentials)) {
            throw new NotSupportedError(
                'Write Mode is only available on Federation Engine projects',
            );
        }
        const attrs = await this.getAttrs(account, project.organizationUuid);
        if (!attrs.platform_write) {
            throw new ForbiddenError(
                'Write Mode requires the platform_write user attribute',
            );
        }
        if (!credentials.identitySigningSecret) {
            throw new NotSupportedError(
                'This Federation Engine connection has no identity signing secret',
            );
        }
        const { token, payload } = mintWriteConfirmationToken({
            statement,
            userUuid: account.user.userUuid,
            projectUuid,
            secret: credentials.identitySigningSecret,
        });
        return {
            confirmationToken: token,
            expiresAt: new Date(payload.exp * 1000).toISOString(),
        };
    }
}
