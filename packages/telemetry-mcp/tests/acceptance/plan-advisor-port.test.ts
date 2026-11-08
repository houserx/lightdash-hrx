import { describe } from 'vitest';
import { portedTestsPass } from './helpers/port';

// Portal api/src/services/plan-advisor.service.test.ts has 4 cases.
describe('plan-advisor port', () => {
    portedTestsPass('plan-advisor.service.test.ts', 4);
});
