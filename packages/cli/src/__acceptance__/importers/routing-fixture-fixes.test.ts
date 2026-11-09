/* eslint-disable */
// @ts-nocheck
// imp-routing-fixes-deterministic: on today's full Grafana alerting (the fixtures),
// ROUTING-FIXES.md lists the known defects from ADR 0003 (team=Support and pg_cron's
// team=engineering fall through to #infra-alerts; slack-sec receives nothing), the fixes are
// applied, and two runs give byte-identical output.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importFixtureAlerts, routeAlert } from './support';

let first: any;
let second: any;
beforeAll(async () => {
    first = await importFixtureAlerts();
    second = await importFixtureAlerts();
});
afterAll(async () => {
    await first?.cleanup();
    await second?.cleanup();
});

const slugOf = (name) => first.contactPoints().map((c) => c.doc).find((d) => d.name === name).slug;

describe('routing fixes on the fixtures', () => {
    it('lists the known defects', () => {
        const md = first.text('ROUTING-FIXES.md');
        expect(md).toContain('pg_cron Job Duration');
        expect(md).toContain('pg_cron Job Failures');
        expect(md).toContain('channel = #alerts');
        expect(md).toContain('team = Support');
        expect(md).toContain(slugOf('slack-sec'));
        expect(md).toMatch(/severity/i);
    });

    it('applies them: pg_cron now reaches #alerts, slack-sec is reachable', () => {
        const pgCron = first.alertRules().map((r) => r.doc).filter((d) => d.name.startsWith('pg_cron'));
        expect(pgCron).toHaveLength(2);
        for (const doc of pgCron) {
            const routed = routeAlert(first.routes(), { ...doc.labels, alertname: doc.name }).map((r) => r.contactPoint);
            expect(routed).toContain(slugOf('slack-alerts'));
        }
        expect(routeAlert(first.routes(), { notify: slugOf('slack-sec') }).map((r) => r.contactPoint)).toContain(slugOf('slack-sec'));
    });

    it('is deterministic', () => {
        expect(second.files).toEqual(first.files);
        for (const f of first.files) {
            expect(readFileSync(path.join(second.out, f), 'utf8')).toBe(readFileSync(path.join(first.out, f), 'utf8'));
        }
    });
});
