import { describe } from 'vitest';
import { portedTestsPass } from './helpers/port';

// Portal api/src/services/ask-memory.service.test.ts has 8 cases; dynamo/askMemory.test.ts has 6,
// which become tests of the in-memory store implementation.
describe('ask-memory port', () => {
    portedTestsPass('ask-memory.service.test.ts', 8);
    portedTestsPass('ask-memory-store.test.ts', 6);
});
