/* eslint-disable */
// @ts-nocheck
// int-identity-agent-restricted: Restricted Telemetry is hidden from agent = true. A person with
// telemetry_restricted reads the restricted source (audited); the same user inside an AI agent
// execution context (the backend's FederationIdentityService decides agent) is refused with a
// 42501 naming agent, and so is an agent token that claims telemetry_restricted.
import { disposeAll, harness, IDENTITY_SECRET, load, mintBackendToken, ORG_UUID, pgRun, PROJECT_UUID, setIdentity, track, USER_EMAIL, USER_UUID, windowSql } from './support';

afterAll(disposeAll);

const restrictedSql = `SELECT count(*) AS n FROM promql('up', ${windowSql(1)}, '1m', 'prometheus-restricted')`;

describe('int-identity-agent-restricted', () => {
    it('allows people with the claim, refuses agents', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'up', instance: 'phi-host' }, value: 1 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const { FederationIdentityService } = await load('packages/backend/src/services/FederationIdentity/FederationIdentityService.ts');
        const { agentExecutionContext } = await load('packages/backend/src/services/AiAccessService/agentExecutionContext.ts');
        const service = new FederationIdentityService({
            userAttributesModel: { getAttributeValuesForOrgMember: async () => ({ telemetry_restricted: ['true'] }) },
        });
        const args = {
            secret: IDENTITY_SECRET,
            user: { userUuid: USER_UUID, email: USER_EMAIL, organizationUuid: ORG_UUID },
            projectUuid: PROJECT_UUID,
            audit: { source: 'tile', description: 'Restricted Telemetry tile' },
        };

        const person = await service.mintForUser(args);
        const ok = await pgRun(engine, [setIdentity(person), restrictedSql]);
        expect(ok.error).toBeUndefined();
        expect(Number(ok.rows[0].n)).toBe(2);
        expect(engine.auditStore.items()).toHaveLength(1);
        expect(engine.auditStore.items()[0]).toMatchObject({ executedBySub: USER_UUID, database: 'prometheus-restricted', action: 'query' });

        const agentToken = await agentExecutionContext.run({ agentUuid: 'agent-e2e', threadUuid: 'thread-e2e', promptUuid: 'prompt-e2e' } as any, () => service.mintForUser(args));
        const refused = await pgRun(engine, [setIdentity(agentToken), restrictedSql]);
        expect(refused.error?.code).toBe('42501');
        expect(refused.error?.message).toMatch(/agent/);

        const explicitAgent = await mintBackendToken({ agent: true, attrs: { telemetry_restricted: true }, audit: { description: 'x', source: 'investigate' } });
        expect((await pgRun(engine, [setIdentity(explicitAgent), restrictedSql])).error?.code).toBe('42501');

        // The unrestricted source stays readable for the agent.
        const open = await pgRun(engine, [setIdentity(agentToken), `SELECT count(*) AS n FROM promql('up', ${windowSql(1)}, '1m')`]);
        expect(open.error).toBeUndefined();
        expect(engine.auditStore.items()).toHaveLength(1);
    });
});
