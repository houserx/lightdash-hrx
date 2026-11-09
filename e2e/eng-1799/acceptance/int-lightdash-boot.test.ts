/* eslint-disable */
// @ts-nocheck
// int-lightdash-boot: the harness boots the Lightdash backend once (migrations on a throwaway
// Postgres, minimal env) with an Operations Project on the federation flavour pointing at the real
// engine, and a user with a personal access token. If a full boot is impossible locally the
// harness may boot a service-layer app instead, and docs/eng-1799/integration.md must say why.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { disposeAll, harness, isAlive, ld, REPO_ROOT, track } from './support';

afterAll(disposeAll);

describe('int-lightdash-boot', () => {
    it('serves the API with a federation-flavour Operations Project', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'up' }, value: 1 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const lightdash = track(await h.startLightdash({ engine }));
        expect(lightdash.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(['full-boot', 'service-layer']).toContain(lightdash.mode);
        if (lightdash.mode === 'service-layer') {
            const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/eng-1799/integration.md'), 'utf8');
            expect(doc).toMatch(/service[- ]layer/i);
        }

        const health = await ld(lightdash, 'GET', '/api/v1/health');
        expect(health.status).toBe(200);

        const project = await ld(lightdash, 'GET', `/api/v1/projects/${lightdash.projectUuid}`);
        expect(project.status).toBe(200);
        const connection = project.json.results.warehouseConnection;
        expect(connection.type).toBe('postgres');
        expect(connection.flavor).toBe('federation');
        expect(connection.port).toBe(engine.pgPort);
        expect(connection.password).toBeUndefined();
        expect(connection.identitySigningSecret).toBeUndefined();
        expect(JSON.stringify(project.json)).not.toContain('test-identity-secret-not-real');

        const access = await ld(lightdash, 'GET', `/api/v2/projects/${lightdash.projectUuid}/federation/access`);
        expect(access.status).toBe(200);
        expect(access.json.results.isFederation).toBe(true);

        const alertingHealth = await ld(lightdash, 'GET', '/api/v1/alerting/health');
        expect(alertingHealth.status).toBe(200);

        const unauthenticated = await fetch(`${lightdash.baseUrl}/api/v1/projects/${lightdash.projectUuid}`);
        expect(unauthenticated.status).toBe(401);

        await lightdash.close();
        if (lightdash.pid) expect(isAlive(lightdash.pid)).toBe(false);
    });
});
