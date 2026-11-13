import { loadConfig } from './config.js';
import { startServer } from './http/server.js';

async function main(): Promise<void> {
    let config;
    try {
        config = loadConfig(process.env);
    } catch (err) {
        // Config errors name the variable and never echo a secret value.
        process.stderr.write(`${JSON.stringify({ level: 'error', msg: err instanceof Error ? err.message : String(err) })}\n`);
        process.exit(1);
    }
    const server = await startServer({ config });
    const shutdown = () => {
        server.close().then(
            () => process.exit(0),
            () => process.exit(1),
        );
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}

main().catch((err: unknown) => {
    const msg = `telemetry-mcp failed to start: ${err instanceof Error ? err.message : String(err)}`;
    process.stderr.write(`${JSON.stringify({ level: 'error', msg })}\n`);
    process.exit(1);
});
