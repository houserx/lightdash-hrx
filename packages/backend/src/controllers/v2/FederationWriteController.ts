import {
    assertRegisteredAccount,
    type ApiErrorPayload,
    type ApiWriteConfirmationRequest,
    type ApiWriteConfirmationResponse,
    type ApiWriteRequest,
    type ApiWriteResponse,
} from '@lightdash/common';
import {
    Body,
    Middlewares,
    OperationId,
    Path,
    Post,
    Request,
    Response,
    Route,
    SuccessResponse,
    Tags,
} from '@tsoa/runtime';
import express from 'express';
import {
    allowApiKeyAuthentication,
    isAuthenticated,
    unauthorisedInDemo,
} from '../authentication';
import { BaseController } from '../baseController';

/**
 * Write Mode on Federation Engine projects (CONTRACTS §4.2). These routes never go through
 * AsyncQueryService; they only use the FederationService.
 */
@Route('/api/v2/projects/{projectUuid}/write')
@Response<ApiErrorPayload>('default', 'Error')
@Tags('v2', 'Federation')
export class FederationWriteController extends BaseController {
    /**
     * Returns a single-use confirmation token bound to this statement, the current user and
     * the project, expiring within 120 seconds. Requires the platform_write user attribute.
     * @summary Create a Write Mode confirmation
     */
    @Middlewares([
        allowApiKeyAuthentication,
        isAuthenticated,
        unauthorisedInDemo,
    ])
    @SuccessResponse('200', 'Success')
    @Post('/confirmations')
    @OperationId('createWriteConfirmation')
    async createWriteConfirmation(
        @Path() projectUuid: string,
        @Body() body: ApiWriteConfirmationRequest,
        @Request() req: express.Request,
    ): Promise<ApiWriteConfirmationResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        return {
            status: 'ok',
            results: await this.services
                .getFederationService()
                .createWriteConfirmation(
                    req.account,
                    projectUuid,
                    body.statement,
                ),
        };
    }

    /**
     * Previews a Write Mode statement: forwards it to the Federation Engine's POST /v1/write
     * with a fresh identity token, and returns the engine's result. A description is
     * required. Requires the platform_write user attribute.
     * @summary Run a Write Mode statement
     */
    @Middlewares([
        allowApiKeyAuthentication,
        isAuthenticated,
        unauthorisedInDemo,
    ])
    @SuccessResponse('200', 'Success')
    @Post('/')
    @OperationId('runWrite')
    async runWrite(
        @Path() projectUuid: string,
        @Body() body: ApiWriteRequest,
        @Request() req: express.Request,
    ): Promise<ApiWriteResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        return {
            status: 'ok',
            results: await this.services
                .getFederationService()
                .write(req.account, projectUuid, body),
        };
    }
}
