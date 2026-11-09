import {
    evaluateHcl,
    getHclAttribute,
    getHclBlocks,
    HclSyntaxError,
    isHclUnknown,
    parseHcl,
    type HclScope,
    type HclUnknown,
} from './terraformHcl';

/** Evaluates `value = <expr>` with the given scope. */
const evaluate = (expr: string, scope: HclScope = {}) => {
    const text = `value = ${expr}\n`;
    const { body } = parseHcl(text, 'test.tf');
    return evaluateHcl(getHclAttribute(body, 'value')!.expr, text, scope);
};

describe('parseHcl', () => {
    it('reads blocks, labels, attributes and comments', () => {
        const { body } = parseHcl(
            [
                '# a comment',
                'resource "grafana_rule_group" "api" {',
                '  name = "api" // trailing comment',
                '  /* block',
                '     comment */',
                '  rule {',
                '    for = "5m"',
                '  }',
                '  rule {',
                '    for = "1m"',
                '  }',
                '}',
            ].join('\n'),
            'rules.tf',
        );
        expect(body.blocks).toHaveLength(1);
        const [group] = body.blocks;
        expect(group.type).toBe('resource');
        expect(group.labels).toEqual(['grafana_rule_group', 'api']);
        expect(group.line).toBe(2);
        expect(getHclAttribute(group.body, 'name')).toBeDefined();
        expect(getHclBlocks(group.body, 'rule')).toHaveLength(2);
    });

    it.each([
        [
            'an unterminated string',
            'a = "open\n',
            'rules.tf:1:5: unterminated string',
        ],
        [
            'an unterminated block',
            'x {\n  a = 1\n',
            'rules.tf:3:1: expected "}" closing the block',
        ],
        [
            'two attributes on one line',
            'x {\n  a = 1 b = 2\n}\n',
            'rules.tf:2:9: expected a newline',
        ],
        [
            'an unterminated heredoc',
            'a = <<EOT\nhello\n',
            'rules.tf:1:5: unterminated heredoc',
        ],
        [
            'a template directive',
            'a = "%{ if x }y%{ endif }"\n',
            'template directives',
        ],
        ['a splat', 'a = x[*].y\n', 'splat expressions'],
    ])('rejects %s with the file and position', (_name, text, message) => {
        expect(() => parseHcl(text, 'rules.tf')).toThrow(HclSyntaxError);
        expect(() => parseHcl(text, 'rules.tf')).toThrow(message);
    });
});

describe('evaluateHcl', () => {
    it('evaluates literals, collections and operators', () => {
        expect(evaluate('[1, "a", true, null]')).toEqual([1, 'a', true, null]);
        expect(evaluate('{ a = 1, "b" : 2\n c = 3 }')).toEqual({
            a: 1,
            b: 2,
            c: 3,
        });
        expect(evaluate('2000 * 5 + 1')).toBe(10001);
        expect(evaluate('!(1 < 2) || 3 >= 3')).toBe(true);
        expect(evaluate('"a" == "a" ? "yes" : "no"')).toBe('yes');
        expect(evaluate('-3 % 2')).toBe(-1);
    });

    it('interpolates templates and strips heredoc indentation', () => {
        expect(evaluate('"rate of ${"x"} is ${1 + 1}"')).toBe('rate of x is 2');
        expect(evaluate('"$${literal}"')).toBe('${literal}');
        expect(evaluate('"${[1, 2]}"')).toEqual([1, 2]);
        expect(evaluate('<<-EOT\n    one ${"two"}\n      three\n    EOT')).toBe(
            'one two\n  three\n',
        );
    });

    it('evaluates for expressions, filters and grouping', () => {
        expect(
            evaluate(
                '[for e in ["prod", "staging"] : upper(e) if e != "staging"]',
            ),
        ).toEqual(['PROD']);
        expect(
            evaluate('{ for k, v in { b = 2, a = 1 } : k => v * 10 }'),
        ).toEqual({
            a: 10,
            b: 20,
        });
        expect(evaluate('{ for v in ["a", "b", "a"] : v => v... }')).toEqual({
            a: ['a', 'a'],
            b: ['b'],
        });
    });

    it('calls the supported functions', () => {
        expect(evaluate('jsonencode({ expr = "up", n = [1] })')).toBe(
            '{"expr":"up","n":[1]}',
        );
        expect(evaluate('jsondecode("{\\"a\\": [1]}")')).toEqual({ a: [1] });
        expect(evaluate('merge({ a = 1 }, { b = 2 }, { a = 3 })')).toEqual({
            a: 3,
            b: 2,
        });
        expect(evaluate('toset(["b", "a", "b"])')).toEqual(['a', 'b']);
        expect(evaluate('contains(tolist(["x"]), "x")')).toBe(true);
        expect(evaluate('sensitive("s")')).toBe('s');
        expect(evaluate('format("%s-%d", "a", 2)')).toBe('a-2');
    });

    it('keeps what it cannot know symbolic instead of throwing', () => {
        const unknown = evaluate(
            'data.aws_secretsmanager_secret_version.x.secret_string',
        );
        expect(isHclUnknown(unknown)).toBe(true);
        expect((unknown as HclUnknown).text).toBe(
            'data.aws_secretsmanager_secret_version.x.secret_string',
        );
        expect(isHclUnknown(evaluate('jsondecode(data.x.y.z).alerts'))).toBe(
            true,
        );
        expect(isHclUnknown(evaluate('nosuchfunction(1)'))).toBe(true);
        expect(isHclUnknown(evaluate('"${var.x} suffix"'))).toBe(true);
        expect(isHclUnknown(evaluate('{ a = 1 }.b'))).toBe(true);
        // jsonencode writes an unknown as null, so the rest of the model stays readable.
        expect(
            evaluate('jsonencode({ uid = data.x.y.uid, expr = "up" })'),
        ).toBe('{"uid":null,"expr":"up"}');
    });

    it('uses scope variables and the resolver for references', () => {
        const scope: HclScope = {
            variables: { each: { key: 'prod', value: 'prod' } },
            resolve: (root, steps) =>
                root === 'grafana_folder' &&
                steps[0] === 'this' &&
                steps[2] === 'uid'
                    ? `folder:${String(steps[1])}`
                    : undefined,
        };
        expect(evaluate('"env ${each.key}"', scope)).toBe('env prod');
        expect(evaluate('grafana_folder.this["Platform"].uid', scope)).toBe(
            'folder:Platform',
        );
    });
});
