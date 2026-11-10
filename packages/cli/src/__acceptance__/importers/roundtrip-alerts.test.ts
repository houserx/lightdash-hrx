/* eslint-disable */
// @ts-nocheck
// imp-roundtrip-alerts: the full rule set, contact points and notification tree import with no
// crash, every document validates with validateAlertingAsCode (the alerting JSON schemas the
// upload uses), the tree names only contact points that exist, and no rule has broken SQL.
import { expectValidAlerting } from './support';
import { expectSoundSql, importAllAlerts } from './roundtripsupport';

let run: any;
beforeAll(async () => {
    run = await importAllAlerts();
});
afterAll(() => run?.cleanup());

const contactPointsIn = (route) => [
    ...(route.contactPoint ? [route.contactPoint] : []),
    ...(route.routes ?? []).flatMap(contactPointsIn),
];

describe('full alerting import', () => {
    it('emits only valid documents', () => {
        for (const { doc } of [...run.alertRules(), ...run.contactPoints()]) expectValidAlerting(doc);
        expectValidAlerting(run.routes());
    });

    it('names only existing contact points', () => {
        const slugs = new Set(run.contactPoints().map((c) => c.doc.slug));
        for (const cp of contactPointsIn(run.routes())) expect(slugs.has(cp), cp).toBe(true);
        for (const { doc } of run.alertRules()) {
            if (doc.labels?.notify) expect(slugs.has(doc.labels.notify)).toBe(true);
        }
    });

    it('writes no broken SQL', () => {
        for (const { doc, file } of run.alertRules()) expectSoundSql(doc.query, file);
    });
});
