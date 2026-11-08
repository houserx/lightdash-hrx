// ldq-platform-explain-sql: Explain runs platform_explain (estimate-only) and the plan can be
// rendered as Postgres-style text for download.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

const plan = [
    {
        Plan: {
            'Node Type': 'Hash Join',
            'Startup Cost': 1.09,
            'Total Cost': 2.21,
            'Plan Rows': 4,
            'Plan Width': 72,
            Plans: [
                {
                    'Node Type': 'Seq Scan',
                    'Relation Name': 'orders',
                    'Startup Cost': 0,
                    'Total Cost': 1.04,
                    'Plan Rows': 4,
                    'Plan Width': 40,
                },
                {
                    'Node Type': 'Hash',
                    'Startup Cost': 1.04,
                    'Total Cost': 1.04,
                    'Plan Rows': 4,
                    'Plan Width': 36,
                    Plans: [
                        {
                            'Node Type': 'Seq Scan',
                            'Relation Name': 'customers',
                            'Startup Cost': 0,
                            'Total Cost': 1.04,
                            'Plan Rows': 4,
                            'Plan Width': 36,
                        },
                    ],
                },
            ],
        },
    },
];

describe('Platform Database Explain', () => {
    it('builds estimate-only explain SQL', () => {
        expect(
            common.buildPlatformExplainSql(
                "select * from orders where status = 'open'",
            ),
        ).toBe(
            "SELECT plan FROM platform_explain('select * from orders where status = ''open''')",
        );
    });

    it('renders a JSON plan as Postgres-style text', () => {
        expect(common.formatExplainPlanAsText(plan)).toBe(
            [
                'Hash Join  (cost=1.09..2.21 rows=4 width=72)',
                '  ->  Seq Scan on orders  (cost=0.00..1.04 rows=4 width=40)',
                '  ->  Hash  (cost=1.04..1.04 rows=4 width=36)',
                '        ->  Seq Scan on customers  (cost=0.00..1.04 rows=4 width=36)',
            ].join('\n'),
        );
    });

    it('accepts the plan as a JSON string or a bare Plan object', () => {
        const text = common.formatExplainPlanAsText(plan);
        expect(common.formatExplainPlanAsText(JSON.stringify(plan))).toBe(text);
        expect(common.formatExplainPlanAsText(plan[0])).toBe(text);
    });
});
