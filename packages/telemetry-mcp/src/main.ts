import { loadConfig } from './config.js';
import { startServer } from './http/server.js';

async function main(): Promise<void> {
    let config;
    try {
        config = loadConfig(process.env);
    } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    }
    const server = await startServer({ config });
    process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'telemetry-mcp listening', url: server.url })}\n`);
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
    process.stderr.write(`telemetry-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
