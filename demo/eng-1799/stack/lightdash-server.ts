// ENG-1799 demo: the Lightdash backend process (started by up.sh, stopped by down.sh).
//
//   cd packages/backend && node --import tsx ../../demo/eng-1799/stack/lightdash-server.ts [ignored args]
//
// It starts the backend's App exactly as packages/backend/src/index.ts does (config parsed from the environment
// up.sh gives it: .state/lightdash/lightdash.env), minus index.ts's Sentry/OpenTelemetry bootstrap: Sentry is
// unconfigured in the demo, and @sentry/profiling-node's native addon has no build for every Node version, so
// loading it would stop the backend before it starts. The e2e harness (e2e/eng-1799/harness/lightdashServer.ts)
// boots the App the same way. With SCHEDULER_ENABLED=true the App runs the scheduler worker in-process, and with
// it the alerting module's tick.
//
// The working directory must be packages/backend so tsx compiles the backend with its own tsconfig (decorators,
// paths), as `pnpm -F backend dev` does. SIGTERM/SIGINT stop the App and exit.
import path from 'node:path';

const BACKEND_SRC = path.resolve(__dirname, '../../../packages/backend/src');

async function main(): Promise<void> {
    const { lightdashConfig } = await import(path.join(BACKEND_SRC, 'config/lightdashConfig.ts'));
    const { default: knexConfig } = await import(path.join(BACKEND_SRC, 'knexfile.ts'));
    const { default: App } = await import(path.join(BACKEND_SRC, 'App.ts'));
    const app = new App({
        lightdashConfig,
        port: process.env.PORT,
        environment: process.env.NODE_ENV === 'development' ? 'development' : 'production',
        knexConfig,
    });

    let stopping = false;
    const stop = (signal: string) => {
        if (stopping) return;
        stopping = true;
        console.log(`lightdash-server: ${signal}, stopping`);
        app.stop()
            .catch((e: unknown) => console.error('lightdash-server: error while stopping:', e))
            .finally(() => process.exit(0));
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));

    await app.start();
    console.log(`lightdash-server: listening on port ${process.env.PORT}`);
}

main().catch((e: unknown) => {
    console.error('lightdash-server: failed to start:', e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
});
