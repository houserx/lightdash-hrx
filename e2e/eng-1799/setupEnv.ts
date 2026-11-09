// Setup file for the ENG-1799 e2e checks (wired in by vitest.base.ts).
//
// Some backend modules the checks import by path (e.g. FederationIdentityService) reach
// packages/backend/src/config/lightdashConfig.ts through logging/winston, and that module runs
// parseConfig() at import. parseConfig() throws unless a few variables are set, so give it
// harmless local placeholders here. Nothing in the checks talks to S3 or uses the secret: these
// values only let the config parse. Variables already set in the environment win.
const placeholders: Record<string, string> = {
    LIGHTDASH_SECRET: 'eng-1799-e2e-not-a-secret',
    SITE_URL: 'http://localhost:8080',
    S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_BUCKET: 'eng-1799-e2e',
    S3_REGION: 'us-east-1',
    LIGHTDASH_LOG_LEVEL: 'error',
};

for (const [name, value] of Object.entries(placeholders)) {
    if (process.env[name] === undefined) {
        process.env[name] = value;
    }
}
