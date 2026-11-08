import { describe, expect, it } from 'vitest';
import { evaluateAlertCondition, isAlertConditionOperator } from './conditions';

describe('evaluateAlertCondition', () => {
    it('checks each threshold operator', () => {
        expect(evaluateAlertCondition(6, { operator: '>', threshold: 5 })).toBe(
            true,
        );
        expect(evaluateAlertCondition(5, { operator: '>', threshold: 5 })).toBe(
            false,
        );
        expect(evaluateAlertCondition(4, { operator: '<', threshold: 5 })).toBe(
            true,
        );
        expect(
            evaluateAlertCondition(5, { operator: '>=', threshold: 5 }),
        ).toBe(true);
        expect(
            evaluateAlertCondition(6, { operator: '<=', threshold: 5 }),
        ).toBe(false);
        expect(
            evaluateAlertCondition(5, { operator: '==', threshold: 5 }),
        ).toBe(true);
        expect(
            evaluateAlertCondition(4, { operator: '!=', threshold: 5 }),
        ).toBe(true);
    });

    it('treats ranges as exclusive at both ends', () => {
        const within = { operator: 'within_range', min: 10, max: 20 } as const;
        const outside = {
            operator: 'outside_range',
            min: 10,
            max: 20,
        } as const;
        expect(evaluateAlertCondition(15, within)).toBe(true);
        expect(evaluateAlertCondition(10, within)).toBe(false);
        expect(evaluateAlertCondition(20, within)).toBe(false);
        expect(evaluateAlertCondition(9, outside)).toBe(true);
        expect(evaluateAlertCondition(10, outside)).toBe(false);
        expect(evaluateAlertCondition(20, outside)).toBe(false);
        expect(evaluateAlertCondition(21, outside)).toBe(true);
    });

    it('normalises a reversed range', () => {
        expect(
            evaluateAlertCondition(15, {
                operator: 'within_range',
                min: 20,
                max: 10,
            }),
        ).toBe(true);
    });

    it('never fires on a missing value', () => {
        expect(
            evaluateAlertCondition(null, { operator: '!=', threshold: 0 }),
        ).toBe(false);
        expect(
            evaluateAlertCondition(undefined, {
                operator: 'outside_range',
                min: 10,
                max: 20,
            }),
        ).toBe(false);
    });
});

describe('isAlertConditionOperator', () => {
    it('accepts known operators only', () => {
        expect(isAlertConditionOperator('>=')).toBe(true);
        expect(isAlertConditionOperator('within_range')).toBe(true);
        expect(isAlertConditionOperator('=>')).toBe(false);
        expect(isAlertConditionOperator(5)).toBe(false);
    });
});
