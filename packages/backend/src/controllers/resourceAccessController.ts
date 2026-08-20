import {
    assertRegisteredAccount,
    type AddResourceGroupAccess,
    type AddResourceUserAccess,
    type ApiErrorPayload,
    type ApiResourceAccessListResponse,
    type ApiResourceShareListResponse,
    type ApiSuccessEmpty,
    type ResourceAccessAction,
    type ResourceAccessResourceType,
    type UUID,
} from '@lightdash/common';
import {
    Body,
    Delete,
    Get,
    Middlewares,
    OperationId,
    Path,
    Post,
    Query,
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
 * Direct, per-resource access grants for a Dashboard or SavedChart, without
 * requiring a dedicated Space. Mirrors spaceController's
 * AddSpaceUserAccess/AddSpaceGroupAccess shape, but scoped to one resource
 * instead of one space, and confused-deputy-checked per grant: the granter must
 * already hold the exact action they are granting on this resource.
 *
 * Every path uuid is typed `UUID` rather than `string`, so TSOA emits the uuid
 * pattern validator and rejects malformed values at the request boundary. These
 * are all resolved uuids -- none of them accept a slug.
 */
@Route('/api/v1/projects/{projectUuid}/resource-access')
@Response<ApiErrorPayload>('default', 'Error')
@Tags('Roles & Permissions')
export class ResourceAccessController extends BaseController {
    /**
     * Grant a user direct access to a resource
     * @summary Grant user access to a resource
     * @param projectUuid The uuid of the project that owns the resource
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
        @Path() projectUuid: UUID,
        @Path() resourceType: ResourceAccessResourceType,
        @Path() resourceUuid: UUID,
        @Body() body: AddResourceUserAccess,
        @Request() req: express.Request,
    ): Promise<ApiSuccessEmpty> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        await this.services
            .getResourceAccessService()
            .grantUserAccess(toSessionUser(req.account), {
                projectUuid,
                resourceType,
                resourceUuid,
                targetUserUuid: body.userUuid,
                action: body.action,
            });
        return { status: 'ok', results: undefined };
    }

    /**
     * Grant a group direct access to a resource
     * @summary Grant group access to a resource
     * @param projectUuid The uuid of the project that owns the resource
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
        @Path() projectUuid: UUID,
        @Path() resourceType: ResourceAccessResourceType,
        @Path() resourceUuid: UUID,
        @Body() body: AddResourceGroupAccess,
        @Request() req: express.Request,
    ): Promise<ApiSuccessEmpty> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        await this.services
            .getResourceAccessService()
            .grantGroupAccess(toSessionUser(req.account), {
                projectUuid,
                resourceType,
                resourceUuid,
                targetGroupUuid: body.groupUuid,
                action: body.action,
            });
        return { status: 'ok', results: undefined };
    }

    /**
     * Revoke a user's direct access to a resource
     * @summary Revoke user access to a resource
     * @param projectUuid The uuid of the project that owns the resource
     * @param resourceType The type of resource
     * @param resourceUuid The uuid of the resource
     * @param userUuid The uuid of the user whose grant is being revoked
     * @param action The action being revoked
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
        @Path() projectUuid: UUID,
        @Path() resourceType: ResourceAccessResourceType,
        @Path() resourceUuid: UUID,
        @Path() userUuid: UUID,
        @Path() action: ResourceAccessAction,
        @Request() req: express.Request,
    ): Promise<ApiSuccessEmpty> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        await this.services
            .getResourceAccessService()
            .revokeUserAccess(toSessionUser(req.account), {
                projectUuid,
                resourceType,
                resourceUuid,
                targetUserUuid: userUuid,
                action,
            });
        return { status: 'ok', results: undefined };
    }

    /**
     * Revoke a group's direct access to a resource
     * @summary Revoke group access to a resource
     * @param projectUuid The uuid of the project that owns the resource
     * @param resourceType The type of resource
     * @param resourceUuid The uuid of the resource
     * @param groupUuid The uuid of the group whose grant is being revoked
     * @param action The action being revoked
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
        @Path() projectUuid: UUID,
        @Path() resourceType: ResourceAccessResourceType,
        @Path() resourceUuid: UUID,
        @Path() groupUuid: UUID,
        @Path() action: ResourceAccessAction,
        @Request() req: express.Request,
    ): Promise<ApiSuccessEmpty> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        await this.services
            .getResourceAccessService()
            .revokeGroupAccess(toSessionUser(req.account), {
                projectUuid,
                resourceType,
                resourceUuid,
                targetGroupUuid: groupUuid,
                action,
            });
        return { status: 'ok', results: undefined };
    }

    /**
     * List the direct grants held on a resource
     * @summary List resource access
     * @param projectUuid The uuid of the project that owns the resource
     * @param resourceType The type of resource
     * @param resourceUuid The uuid of the resource
     * @param req
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('{resourceType}/{resourceUuid}')
    @OperationId('GetResourceAccess')
    async getResourceAccess(
        @Path() projectUuid: UUID,
        @Path() resourceType: ResourceAccessResourceType,
        @Path() resourceUuid: UUID,
        @Request() req: express.Request,
    ): Promise<ApiResourceAccessListResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);
        const results = await this.services
            .getResourceAccessService()
            .listResourceAccess(
                toSessionUser(req.account),
                projectUuid,
                resourceType,
                resourceUuid,
            );
        return { status: 'ok', results };
    }

    /**
     * Get the resolved user access list for a resource
     *
     * Everyone who can reach the resource, at what role, and where that came
     * from -- a direct grant, its space, an ancestor space, the project or the
     * organization. The sibling endpoint above returns the persisted grant rows
     * alone, which is enough to reconcile state but not to draw a people list.
     *
     * @summary List resolved resource access
     * @param projectUuid The uuid of the project that owns the resource
     * @param resourceType The type of resource
     * @param resourceUuid The uuid of the resource
     * @param req
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('{resourceType}/{resourceUuid}/access')
    @OperationId('GetResourceAccessList')
    async getResourceAccessList(
        @Path() projectUuid: UUID,
        @Path() resourceType: ResourceAccessResourceType,
        @Path() resourceUuid: UUID,
        @Request() req: express.Request,
        @Query() page?: number,
        @Query() pageSize?: number,
        @Query() searchQuery?: string,
        @Query() userUuids?: string[],
        @Query() directOnly?: boolean,
    ): Promise<ApiResourceShareListResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await this.services
                .getResourceAccessService()
                .getResourceAccessList(toSessionUser(req.account), {
                    projectUuid,
                    resourceType,
                    resourceUuid,
                    paginateArgs:
                        page && pageSize ? { page, pageSize } : undefined,
                    filters: { searchQuery, userUuids, directOnly },
                }),
        };
    }
}
