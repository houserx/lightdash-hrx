import {
    AddResourceGroupAccess,
    AddResourceUserAccess,
    ApiErrorPayload,
    ApiResourceAccessListResponse,
    ApiSuccessEmpty,
    assertRegisteredAccount,
} from '@lightdash/common';
import {
    Body,
    Delete,
    Get,
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
import { toSessionUser } from '../auth/account';
import {
    allowApiKeyAuthentication,
    isAuthenticated,
    unauthorisedInDemo,
} from './authentication';
import { BaseController } from './baseController';

/**
 * Direct, per-resource access grants for a Dashboard or SavedChart,
 * without requiring a dedicated Space. Mirrors spaceController's
 * AddSpaceUserAccess/AddSpaceGroupAccess shape, but scoped to one resource
 * instead of one space, and confused-deputy-checked per grant (see
 * ResourceAccessService): the granter must already hold the exact action
 * they are granting on this resource.
 */
@Route('/api/v1/projects/{projectUuid}/resource-access')
@Response<ApiErrorPayload>('default', 'Error')
@Tags('Roles & Permissions')
export class ResourceAccessController extends BaseController {
    /**
     * Grant a user direct access to a resource
     * @summary Grant user access to a resource
     * @param projectUuid The uuid of the resource's parent project
     * @param resourceType The type of resource to grant access to
     * @param resourceUuid The uuid of the resource to grant access to
     * @param body
     * @param req
     */
    @Middlewares([
        allowApiKeyAuthentication,
        isAuthenticated,
        unauthorisedInDemo,
    ])
    @SuccessResponse('200', 'Success')
    @Post('{resourceType}/{resourceUuid}/user')
    @OperationId('AddResourceUserAccess')
    async addResourceUserAccess(
        @Path() projectUuid: string,
        @Path() resourceType: 'Dashboard' | 'SavedChart',
        @Path() resourceUuid: string,
        @Body() body: AddResourceUserAccess,
        @Request() req: express.Request,
    ): Promise<ApiSuccessEmpty> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        await this.services
            .getResourceAccessService()
            .grantUserAccess(
                toSessionUser(req.account),
                resourceType,
                resourceUuid,
                body.userUuid,
                body.action,
            );
        return { status: 'ok', results: undefined };
    }

    /**
     * Grant a group direct access to a resource
     * @summary Grant group access to a resource
     * @param projectUuid The uuid of the resource's parent project
     * @param resourceType The type of resource to grant access to
     * @param resourceUuid The uuid of the resource to grant access to
     * @param body
     * @param req
     */
    @Middlewares([
        allowApiKeyAuthentication,
        isAuthenticated,
        unauthorisedInDemo,
    ])
    @SuccessResponse('200', 'Success')
    @Post('{resourceType}/{resourceUuid}/group')
    @OperationId('AddResourceGroupAccess')
    async addResourceGroupAccess(
        @Path() projectUuid: string,
        @Path() resourceType: 'Dashboard' | 'SavedChart',
        @Path() resourceUuid: string,
        @Body() body: AddResourceGroupAccess,
        @Request() req: express.Request,
    ): Promise<ApiSuccessEmpty> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        await this.services
            .getResourceAccessService()
            .grantGroupAccess(
                toSessionUser(req.account),
                resourceType,
                resourceUuid,
                body.groupUuid,
                body.action,
            );
        return { status: 'ok', results: undefined };
    }

    /**
     * Remove a user's direct access to a resource
     * @summary Revoke user access to a resource
     * @param projectUuid The uuid of the resource's parent project
     * @param resourceType The type of resource to revoke access from
     * @param resourceUuid The uuid of the resource to revoke access from
     * @param userUuid The uuid of the user to revoke access from
     * @param action The action to revoke
     * @param req
     */
    @Middlewares([
        allowApiKeyAuthentication,
        isAuthenticated,
        unauthorisedInDemo,
    ])
    @SuccessResponse('200', 'Success')
    @Delete('{resourceType}/{resourceUuid}/user/{userUuid}/{action}')
    @OperationId('RevokeResourceUserAccess')
    async revokeResourceUserAccess(
        @Path() projectUuid: string,
        @Path() resourceType: 'Dashboard' | 'SavedChart',
        @Path() resourceUuid: string,
        @Path() userUuid: string,
        @Path() action: 'view' | 'manage',
        @Request() req: express.Request,
    ): Promise<ApiSuccessEmpty> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        await this.services
            .getResourceAccessService()
            .revokeUserAccess(
                toSessionUser(req.account),
                resourceType,
                resourceUuid,
                userUuid,
                action,
            );
        return { status: 'ok', results: undefined };
    }

    /**
     * Remove a group's direct access to a resource
     * @summary Revoke group access to a resource
     * @param projectUuid The uuid of the resource's parent project
     * @param resourceType The type of resource to revoke access from
     * @param resourceUuid The uuid of the resource to revoke access from
     * @param groupUuid The uuid of the group to revoke access from
     * @param action The action to revoke
     * @param req
     */
    @Middlewares([
        allowApiKeyAuthentication,
        isAuthenticated,
        unauthorisedInDemo,
    ])
    @SuccessResponse('200', 'Success')
    @Delete('{resourceType}/{resourceUuid}/group/{groupUuid}/{action}')
    @OperationId('RevokeResourceGroupAccess')
    async revokeResourceGroupAccess(
        @Path() projectUuid: string,
        @Path() resourceType: 'Dashboard' | 'SavedChart',
        @Path() resourceUuid: string,
        @Path() groupUuid: string,
        @Path() action: 'view' | 'manage',
        @Request() req: express.Request,
    ): Promise<ApiSuccessEmpty> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        await this.services
            .getResourceAccessService()
            .revokeGroupAccess(
                toSessionUser(req.account),
                resourceType,
                resourceUuid,
                groupUuid,
                action,
            );
        return { status: 'ok', results: undefined };
    }

    /**
     * List everyone with direct access to a resource
     * @summary List direct access grants for a resource
     * @param projectUuid The uuid of the resource's parent project
     * @param resourceType The type of resource to list access for
     * @param resourceUuid The uuid of the resource to list access for
     * @param req
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('{resourceType}/{resourceUuid}')
    @OperationId('ListResourceAccess')
    async listResourceAccess(
        @Path() projectUuid: string,
        @Path() resourceType: 'Dashboard' | 'SavedChart',
        @Path() resourceUuid: string,
        @Request() req: express.Request,
    ): Promise<ApiResourceAccessListResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        const results = await this.services
            .getResourceAccessService()
            .listAccessForResource(
                toSessionUser(req.account),
                resourceType,
                resourceUuid,
            );
        return { status: 'ok', results };
    }
}
