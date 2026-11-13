import { describe } from 'vitest';
import { portedTestsPass } from './helpers/port';

// Portal api/src/services/example-queries.service.test.ts has 5 cases.
describe('example-queries port', () => {
    portedTestsPass('example-queries.service.test.ts', 5);
});
