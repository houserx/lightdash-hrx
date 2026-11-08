/**
 * Federation Engine (ldq) features of a project that never go through the async query path
 * (CONTRACTS §4.2). It reads the project with its credentials, so nothing it returns may
 * carry a credential field.
 */
import { subject } from '@casl/ability';
import {
    ForbiddenError,
    isFederationProject,
    type FederationAccess,
    type RegisteredAccount,
} from '@lightdash/common';
import type { ProjectModel } from '../../models/ProjectModel/ProjectModel';
import type { UserAttributesModel } from '../../models/UserAttributesModel';
import { BaseService } from '../BaseService';
import { identityAttrsFromUserAttributes } from '../FederationIdentity/identityToken';

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

    /**
     * Whether the project is a federation project, and which ldq claims the account's user
     * holds in the project's organization. Requires view access to the project.
     */
    async getAccess(
        account: RegisteredAccount,
        projectUuid: string,
    ): Promise<FederationAccess> {
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
        const userAttributes =
            await this.userAttributesModel.getAttributeValuesForOrgMember({
                organizationUuid,
                userUuid: account.user.userUuid,
            });
        return {
            isFederation: isFederationProject(project),
            attrs: identityAttrsFromUserAttributes(userAttributes),
        };
    }
}
