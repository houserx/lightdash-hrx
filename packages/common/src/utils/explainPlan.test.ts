import { formatExplainPlanAsText } from './explainPlan';

describe('formatExplainPlanAsText', () => {
    it('names joins, aggregates and index scans the way Postgres prints them', () => {
        const plan = {
            'Node Type': 'Aggregate',
            Strategy: 'Hashed',
            'Partial Mode': 'Simple',
            'Group Key': ['o.status'],
            'Startup Cost': 10.5,
            'Total Cost': 12,
            'Plan Rows': 3,
            'Plan Width': 40,
            Plans: [
                {
                    'Node Type': 'Nested Loop',
                    'Join Type': 'Left',
                    'Join Filter': '(o.customer_id = c.id)',
                    'Startup Cost': 0.15,
                    'Total Cost': 9.75,
                    'Plan Rows': 20,
                    'Plan Width': 32,
                    Plans: [
                        {
                            'Node Type': 'Seq Scan',
                            'Parallel Aware': true,
                            'Relation Name': 'orders',
                            Alias: 'o',
                            Filter: "(status <> 'void'::text)",
                            'Startup Cost': 0,
                            'Total Cost': 1.5,
                            'Plan Rows': 20,
                            'Plan Width': 16,
                        },
                        {
                            'Node Type': 'Index Scan',
                            'Scan Direction': 'Backward',
                            'Index Name': 'customers_pkey',
                            'Relation Name': 'customers',
                            Alias: 'customers',
                            'Index Cond': '(id = o.customer_id)',
                            'Startup Cost': 0.15,
                            'Total Cost': 0.4,
                            'Plan Rows': 1,
                            'Plan Width': 16,
                        },
                    ],
                },
            ],
        };
        expect(formatExplainPlanAsText(plan)).toBe(
            [
                'HashAggregate  (cost=10.50..12.00 rows=3 width=40)',
                '  Group Key: o.status',
                '  ->  Nested Loop Left Join  (cost=0.15..9.75 rows=20 width=32)',
                '        Join Filter: (o.customer_id = c.id)',
                '        ->  Parallel Seq Scan on orders o  (cost=0.00..1.50 rows=20 width=16)',
                "              Filter: (status <> 'void'::text)",
                '        ->  Index Scan Backward using customers_pkey on customers  (cost=0.15..0.40 rows=1 width=16)',
                '              Index Cond: (id = o.customer_id)',
            ].join('\n'),
        );
    });

    it('prints a subplan name above its node', () => {
        const plan = [
            {
                Plan: {
                    'Node Type': 'Result',
                    'Startup Cost': 0.01,
                    'Total Cost': 0.02,
                    'Plan Rows': 1,
                    'Plan Width': 8,
                    Plans: [
                        {
                            'Node Type': 'Result',
                            'Parent Relationship': 'InitPlan',
                            'Subplan Name': 'InitPlan 1 (returns $0)',
                            'Startup Cost': 0,
                            'Total Cost': 0.01,
                            'Plan Rows': 1,
                            'Plan Width': 4,
                        },
                    ],
                },
            },
        ];
        expect(formatExplainPlanAsText(plan)).toBe(
            [
                'Result  (cost=0.01..0.02 rows=1 width=8)',
                '  InitPlan 1 (returns $0)',
                '    ->  Result  (cost=0.00..0.01 rows=1 width=4)',
            ].join('\n'),
        );
    });

    it('throws on input that is not a plan', () => {
        expect(() => formatExplainPlanAsText('[]')).toThrow(
            'Not a Postgres JSON explain plan',
        );
        expect(() => formatExplainPlanAsText('not json')).toThrow();
    });
});
