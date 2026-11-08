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
    type AuditFilters,
    type AuditPage,
    type FederationAccess,
    type RegisteredAccount,
    type WriteConfirmation,
    type WriteResult,
} from '@lightdash/common';
import type { ProjectModel } from '../../models/ProjectModel/ProjectModel';
import type { UserAttributesModel } from '../../models/UserAttributesModel';
import { BaseService } from '../BaseService';
import {
    FederationIdentityService,
    isAgentSession,
} from '../FederationIdentity/FederationIdentityService';
import { identityAttrsFromUserAttributes } from '../FederationIdentity/identityToken';
import { getEngineAudit, parseAuditFilters } from './engineAudit';
import { parseWriteRequest, postEngineWrite } from './engineWrite';
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

    private readonly federationIdentityService: FederationIdentityService;

    constructor({
        projectModel,
        userAttributesModel,
    }: FederationServiceArguments) {
        super();
        this.projectModel = projectModel;
        this.userAttributesModel = userAttributesModel;
        this.federationIdentityService = new FederationIdentityService({
            userAttributesModel,
        });
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

    /**
     * CONTRACTS §4.2: runs a Write Mode statement through the engine's POST /v1/write, with a
     * fresh identity token (audit source write_mode) for the account's user. Never goes
     * through AsyncQueryService. Requires view access and the platform_write user attribute;
     * a missing description is refused before anything else. Mode "preview" runs inside a
     * transaction the engine rolls back; mode "commit" is forwarded the same way, and the
     * engine's refusals (409 reused confirmation, 403 guard) come back with their status.
     * Inside an AI agent execution context, commit is refused with 403 before anything is
     * loaded or sent; preview still runs, with the identity token's agent flag set.
     */
    async write(
        account: RegisteredAccount,
        projectUuid: string,
        body: unknown,
    ): Promise<WriteResult> {
        const request = parseWriteRequest(body);
        // ADR 0004: an AI agent may Preview (its identity token says agent) but never commit.
        if (request.mode === 'commit' && isAgentSession()) {
            throw new ForbiddenError(
                'AI agents may preview writes but cannot commit them',
            );
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
        if (!credentials.httpBaseUrl) {
            throw new NotSupportedError(
                'This Federation Engine connection has no HTTP base URL',
            );
        }
        const { email } = account.user;
        if (!email) {
            throw new ForbiddenError(
                'Write Mode requires a user with an email address',
            );
        }
        const identityToken = await this.federationIdentityService.mintForUser({
            secret: credentials.identitySigningSecret,
            user: {
                userUuid: account.user.userUuid,
                email,
                organizationUuid: project.organizationUuid,
            },
            projectUuid,
            audit: {
                description: request.description,
                ticket: request.ticket,
                source: 'write_mode',
                resource_uuid: null,
            },
        });
        return postEngineWrite(credentials.httpBaseUrl, identityToken, {
            statement: request.statement,
            mode: request.mode,
            confirmation_token: request.confirmationToken,
            description: request.description,
            ticket: request.ticket,
        });
    }

    /**
     * CONTRACTS §4.2 audit browser: a page of executions from the engine's GET /v1/audit,
     * filtered by ticket, user and month (YYYY-MM), from `cursor`. Only the filters given are
     * sent. Requires view access and the platform_read user attribute; a malformed month is
     * refused before anything is loaded. The identity token carries audit source
     * `investigate` and no description: listing the audit store is not an Audited Query
     * (Contract assumption 12).
     */
    async listAudit(
        account: RegisteredAccount,
        projectUuid: string,
        filters: AuditFilters,
    ): Promise<AuditPage> {
        const parsedFilters = parseAuditFilters(filters);
        const project = await this.getViewableProject(account, projectUuid);
        const credentials = project.warehouseConnection;
        if (!isFederationCredentials(credentials)) {
            throw new NotSupportedError(
                'The audit browser is only available on Federation Engine projects',
            );
        }
        const attrs = await this.getAttrs(account, project.organizationUuid);
        if (!attrs.platform_read) {
            throw new ForbiddenError(
                'The audit browser requires the platform_read user attribute',
            );
        }
        if (!credentials.identitySigningSecret) {
            throw new NotSupportedError(
                'This Federation Engine connection has no identity signing secret',
            );
        }
        if (!credentials.httpBaseUrl) {
            throw new NotSupportedError(
                'This Federation Engine connection has no HTTP base URL',
            );
        }
        const { email } = account.user;
        if (!email) {
            throw new ForbiddenError(
                'The audit browser requires a user with an email address',
            );
        }
        const identityToken = await this.federationIdentityService.mintForUser({
            secret: credentials.identitySigningSecret,
            user: {
                userUuid: account.user.userUuid,
                email,
                organizationUuid: project.organizationUuid,
            },
            projectUuid,
            audit: { source: 'investigate' },
        });
        return getEngineAudit(
            credentials.httpBaseUrl,
            identityToken,
            parsedFilters,
        );
    }
}
