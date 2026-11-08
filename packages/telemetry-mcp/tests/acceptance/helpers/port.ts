/**
 * Shared check for "port the portal's X and its tests": the ported unit-test file exists under src/
 * and runs green with at least `minPassing` cases. PROTECTED: do not edit.
 */
import { expect, it } from 'vitest';
import { findUnitTest, runUnitTestFile } from './files';

export function portedTestsPass(basename: string, minPassing: number): void {
    it(`ports ${basename} with at least ${minPassing} passing cases`, () => {
        const file = findUnitTest(basename);
        const res = runUnitTestFile(file);
        expect(res.failed, res.output).toBe(0);
        expect(res.passed, res.output).toBeGreaterThanOrEqual(minPassing);
    }, 180_000);
}
