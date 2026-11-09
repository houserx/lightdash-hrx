// ENG-1799 demo: `pnpm -F eng-1799-demo ask [--json] "<question>"` (see ./client.ts). Needs the stack from up.sh.
//
//   --json   print ONE JSON object {question, tool, arguments, query, result: {columns, rows}, answer} on stdout
//   --list   print the questions the scripted client knows
// Without --json it prints the tool call, the query, the result table and the answer for a person to read.
import { parseArgs } from 'node:util';
import { ask, EXAMPLE_QUESTIONS, type AskResult } from './client';

function printHuman(out: AskResult): void {
    const lines = [
        `Question: ${out.question}`,
        `Tool:     ${out.tool} ${JSON.stringify(out.arguments)}`,
        `Query:    ${out.query}`,
        '',
        out.result.columns.join('\t'),
        ...out.result.rows.map((r) => r.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join('\t')),
        '',
        `Answer:   ${out.answer}`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: { json: { type: 'boolean', default: false }, list: { type: 'boolean', default: false } },
    });
    if (values.list) {
        process.stdout.write(`${EXAMPLE_QUESTIONS.join('\n')}\n`);
        return;
    }
    const question = positionals.join(' ').trim();
    if (!question) throw new Error('usage: ask [--json] "<question>" (or --list)');
    const out = await ask(question);
    if (values.json) process.stdout.write(`${JSON.stringify(out)}\n`);
    else printHuman(out);
}

main().catch((err: unknown) => {
    process.stderr.write(`eng-1799-demo ask: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
