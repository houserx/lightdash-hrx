/**
 * File-system and unit-test helpers for acceptance tests. PROTECTED: do not edit.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const REPO_ROOT = path.resolve(PKG_DIR, '../..');

export function read(rel: string, base = PKG_DIR): string {
    return fs.readFileSync(path.join(base, rel), 'utf8');
}

export function exists(rel: string, base = PKG_DIR): boolean {
    return fs.existsSync(path.join(base, rel));
}

/** All files under `dir` (relative to the package), skipping node_modules and dist. */
export function walk(dir: string): string[] {
    const root = path.join(PKG_DIR, dir);
    if (!fs.existsSync(root)) return [];
    const out: string[] = [];
    const stack = [root];
    while (stack.length) {
        const d = stack.pop() as string;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === 'dist') continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) stack.push(p);
            else out.push(p);
        }
    }
    return out;
}

/** Finds the one unit-test file under src/ with this basename (e.g. "plan-advisor.service.test.ts"). */
export function findUnitTest(basename: string): string {
    const hits = walk('src').filter((f) => path.basename(f) === basename);
    if (hits.length !== 1) {
        throw new Error(`expected exactly one src/**/${basename}, found ${hits.length}`);
    }
    return hits[0] as string;
}

/** Runs one unit-test file with vitest (outside the acceptance folder) and returns pass/fail counts. */
export function runUnitTestFile(file: string): { passed: number; failed: number; total: number; output: string } {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmcp-unit-')), 'report.json');
    const res = spawnSync('pnpm', ['exec', 'vitest', 'run', file, '--reporter=json', `--outputFile=${outFile}`], {
        cwd: PKG_DIR,
        encoding: 'utf8',
        timeout: 150_000,
        env: { ...process.env, VITEST: undefined, VITEST_POOL_ID: undefined, VITEST_WORKER_ID: undefined, NODE_ENV: 'test' },
    });
    const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.slice(-4000);
    if (!fs.existsSync(outFile)) return { passed: 0, failed: 0, total: 0, output };
    const report = JSON.parse(fs.readFileSync(outFile, 'utf8')) as {
        numPassedTests: number;
        numFailedTests: number;
        numTotalTests: number;
    };
    return { passed: report.numPassedTests, failed: report.numFailedTests, total: report.numTotalTests, output };
}

/** Terms from CONTEXT.md `_Avoid_` lists that must not appear in user-facing docs. */
export const AVOID_TERMS = [
    'datasource',
    'data source',
    'dry run',
    'dry-run',
    'prod db',
    'platform-rds',
    'logged query',
    'tracked query',
    'elevated mode',
    'dml mode',
    'sensitive logs',
    'phi logs',
    'private source',
    'time picker',
];
