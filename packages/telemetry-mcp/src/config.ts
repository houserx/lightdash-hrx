/**
 * Server settings read from env. Skeleton scope: listen address only. Full validation of every variable
 * (required Okta, Lightdash, engine and identity settings) lands with the config-validation feature.
 */
export interface Config {
    host: string;
    port: number;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
    const host = env.MCP_HOST?.trim() || '0.0.0.0';
    const rawPort = env.MCP_PORT?.trim() || '8080';
    const port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('Invalid configuration: MCP_PORT must be an integer between 0 and 65535');
    }
    return { host, port };
}
