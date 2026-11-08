import type { Config } from '../config.js';

/** Path of the MCP endpoint, relative to `MCP_PUBLIC_URL`. */
export const MCP_PATH = '/mcp';

/**
 * Paths that serve the OAuth 2.1 protected-resource metadata (RFC 9728 §3). The bare well-known path is what
 * most MCP clients probe first; the path-suffixed form is the RFC's location for the `/mcp` resource.
 */
export const PROTECTED_RESOURCE_METADATA_PATHS: readonly string[] = [
    '/.well-known/oauth-protected-resource',
    `/.well-known/oauth-protected-resource${MCP_PATH}`,
];

export interface ProtectedResourceMetadata {
    resource: string;
    authorization_servers: string[];
    bearer_methods_supported: string[];
    resource_name: string;
}

/** RFC 9728 metadata for this server: the `/mcp` resource, protected by the configured Okta issuer. */
export function protectedResourceMetadata(config: Config): ProtectedResourceMetadata {
    return {
        resource: `${config.publicUrl}${MCP_PATH}`,
        authorization_servers: [config.okta.issuer],
        bearer_methods_supported: ['header'],
        resource_name: 'HouseRx telemetry MCP',
    };
}
