import { describe, expect, it } from 'vitest';
import { getAlertRuleState } from './alertRules';

describe('getAlertRuleState', () => {
    it('is normal for a rule that was never evaluated', () => {
        expect(getAlertRuleState([])).toBe('normal');
    });

    it('takes the highest state: firing > error > nodata > pending > normal', () => {
        expect(getAlertRuleState(['normal', 'pending', 'firing'])).toBe(
            'firing',
        );
        expect(getAlertRuleState(['nodata', 'error', 'pending'])).toBe('error');
        expect(getAlertRuleState(['pending', 'nodata'])).toBe('nodata');
        expect(getAlertRuleState(['normal', 'pending'])).toBe('pending');
    });

    it('counts a resolved series as normal', () => {
        expect(getAlertRuleState(['resolved'])).toBe('normal');
    });
});
