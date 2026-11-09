import {
    ALERT_EVALUATOR_SUBJECT,
    buildAlertEvaluatorQueryContext,
} from './evaluatorIdentity';

const args = {
    ruleUuid: 'rule-uuid',
    projectUuid: 'project-uuid',
    description: 'Pages when disk is almost full',
};

describe('buildAlertEvaluatorQueryContext', () => {
    it('uses the system identity with the rule as the audit resource', () => {
        expect(buildAlertEvaluatorQueryContext(args)).toEqual({
            sub: ALERT_EVALUATOR_SUBJECT,
            sys: true,
            agent: false,
            projectUuid: 'project-uuid',
            audit: {
                description: 'Pages when disk is almost full',
                ticket: null,
                source: 'alert_rule',
                resource_uuid: 'rule-uuid',
            },
        });
    });

    it.each(['', '   ', '\n\t'])(
        'rejects a blank description (%j)',
        (description) => {
            expect(() =>
                buildAlertEvaluatorQueryContext({ ...args, description }),
            ).toThrow(/description/);
        },
    );

    it('rejects a blank rule or project uuid', () => {
        expect(() =>
            buildAlertEvaluatorQueryContext({ ...args, ruleUuid: ' ' }),
        ).toThrow(/ruleUuid/);
        expect(() =>
            buildAlertEvaluatorQueryContext({ ...args, projectUuid: '' }),
        ).toThrow(/projectUuid/);
    });
});
