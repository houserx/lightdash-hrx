import {
    assertRegisteredAccount,
    type ApiAuditPageResponse,
    type ApiErrorPayload,
    type ApiFederationAccessResponse,
} from '@lightdash/common';
import {
    Get,
    Middlewares,
    OperationId,
    Path,
    Query,
    Request,
    Response,
    Route,
    SuccessResponse,
    Tags,
} from '@tsoa/runtime';
import express from 'express';
import { allowApiKeyAuthentication, isAuthenticated } from '../authentication';
import { BaseController } from '../baseController';

@Route('/api/v2/projects/{projectUuid}/federation')
@Response<ApiErrorPayload>('default', 'Error')
@Tags('v2', 'Federation')
export class FederationController extends BaseController {
    /**
     * Whether the project is a Federation Engine project, and which ldq claims
     * (telemetry_restricted, platform_read, platform_write, platform_explain) the current
     * user holds through their user attributes.
     * @summary Get federation access
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('/access')
    @OperationId('getFederationAccess')
    async getFederationAccess(
        @Path() projectUuid: string,
        @Request() req: express.Request,
    ): Promise<ApiFederationAccessResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        return {
            status: 'ok',
            results: await this.services
                .getFederationService()
                .getAccess(req.account, projectUuid),
        };
    }

    /**
     * Lists executions from the Federation Engine's audit store (GET /v1/audit), filtered by
     * Linear ticket, user and month (YYYY-MM), one page at a time from `cursor`. Requires the
     * platform_read user attribute.
     * @summary List federation audit executions
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('/audit')
    @OperationId('listFederationAudit')
    async listFederationAudit(
        @Path() projectUuid: string,
        @Request() req: express.Request,
        @Query() ticket?: string,
        @Query() user?: string,
        @Query() month?: string,
        @Query() cursor?: string,
    ): Promise<ApiAuditPageResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        return {
            status: 'ok',
            results: await this.services
                .getFederationService()
                .listAudit(req.account, projectUuid, {
                    ticket,
                    user,
                    month,
                    cursor,
                }),
        };
    }
}
