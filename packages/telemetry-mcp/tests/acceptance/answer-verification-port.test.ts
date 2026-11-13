import { describe } from 'vitest';
import { portedTestsPass } from './helpers/port';

// Portal api/src/services/answer-verification.test.ts has 7 cases.
describe('answer-verification port', () => {
    portedTestsPass('answer-verification.test.ts', 7);
});
