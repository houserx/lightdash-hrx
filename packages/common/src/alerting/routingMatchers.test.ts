import { describe, expect, it } from 'vitest';
import {
    getAlertLabelMatcherError,
    isAlertLabelMatcherOperator,
    matchAlertLabelMatcher,
    matchAlertLabelMatchers,
    type AlertLabelMatcher,
    type AlertLabelMatcherOperator,
} from './routingMatchers';

const m = (
    label: string,
    operator: AlertLabelMatcherOperator,
    value: string,
): AlertLabelMatcher => ({ label, operator, value });

describe('matchAlertLabelMatcher', () => {
    const labels = { team: 'frontend', severity: 'critical' };

    it('compares strings with = and !=', () => {
        expect(matchAlertLabelMatcher(labels, m('team', '=', 'frontend'))).toBe(
            true,
        );
        expect(matchAlertLabelMatcher(labels, m('team', '=', 'Frontend'))).toBe(
            false,
        );
        expect(
            matchAlertLabelMatcher(labels, m('team', '!=', 'frontend')),
        ).toBe(false);
        expect(matchAlertLabelMatcher(labels, m('team', '!=', 'backend'))).toBe(
            true,
        );
    });

    it('anchors regexes at both ends', () => {
        expect(matchAlertLabelMatcher(labels, m('team', '=~', 'front.*'))).toBe(
            true,
        );
        expect(matchAlertLabelMatcher(labels, m('team', '=~', 'front'))).toBe(
            false,
        );
        expect(matchAlertLabelMatcher(labels, m('team', '=~', 'end'))).toBe(
            false,
        );
        expect(matchAlertLabelMatcher(labels, m('team', '!~', 'front'))).toBe(
            true,
        );
        expect(matchAlertLabelMatcher(labels, m('team', '!~', 'back.*'))).toBe(
            true,
        );
        // alternation is grouped before anchoring
        expect(
            matchAlertLabelMatcher(
                labels,
                m('severity', '=~', 'critical|high'),
            ),
        ).toBe(true);
        expect(
            matchAlertLabelMatcher(labels, m('severity', '=~', 'crit|high')),
        ).toBe(false);
    });

    it('treats a missing or null label as the empty string', () => {
        expect(matchAlertLabelMatcher({}, m('team', '=', ''))).toBe(true);
        expect(matchAlertLabelMatcher({ team: null }, m('team', '=', ''))).toBe(
            true,
        );
        expect(matchAlertLabelMatcher({}, m('team', '!=', 'infra'))).toBe(true);
        expect(matchAlertLabelMatcher({}, m('team', '=~', '.*'))).toBe(true);
        expect(matchAlertLabelMatcher({}, m('team', '=~', '.+'))).toBe(false);
        expect(matchAlertLabelMatcher({}, m('team', '!~', '.+'))).toBe(true);
    });

    it('never holds for an invalid regex', () => {
        expect(matchAlertLabelMatcher(labels, m('team', '=~', '('))).toBe(
            false,
        );
        expect(matchAlertLabelMatcher(labels, m('team', '!~', '('))).toBe(
            false,
        );
        // an unbalanced pattern cannot escape the anchoring group
        expect(
            matchAlertLabelMatcher(labels, m('team', '=~', 'xx)|(front')),
        ).toBe(false);
    });
});

describe('matchAlertLabelMatchers', () => {
    const labels = { team: 'frontend', severity: 'critical' };

    it('requires every matcher to hold', () => {
        expect(
            matchAlertLabelMatchers(labels, [
                m('team', '=', 'frontend'),
                m('severity', '=~', 'critical|high'),
            ]),
        ).toBe(true);
        expect(
            matchAlertLabelMatchers(labels, [
                m('team', '=', 'frontend'),
                m('severity', '=', 'low'),
            ]),
        ).toBe(false);
    });

    it('matches everything with no matchers', () => {
        expect(matchAlertLabelMatchers(labels, [])).toBe(true);
        expect(matchAlertLabelMatchers({}, [])).toBe(true);
    });
});

describe('matcher validation', () => {
    it('recognises the four operators', () => {
        expect(isAlertLabelMatcherOperator('=~')).toBe(true);
        expect(isAlertLabelMatcherOperator('==')).toBe(false);
        expect(isAlertLabelMatcherOperator(undefined)).toBe(false);
    });

    it('reports empty labels, unknown operators and invalid regexes', () => {
        expect(getAlertLabelMatcherError(m('team', '=~', 'front.*'))).toBe(
            undefined,
        );
        expect(getAlertLabelMatcherError(m('', '=', 'x'))).toMatch(/label/);
        expect(
            getAlertLabelMatcherError({
                label: 'team',
                operator: '==' as AlertLabelMatcherOperator,
                value: 'x',
            }),
        ).toMatch(/operator/);
        expect(getAlertLabelMatcherError(m('team', '=~', '('))).toMatch(
            /Invalid regex/,
        );
        // an unbalanced paren is only a regex problem for regex operators
        expect(getAlertLabelMatcherError(m('team', '=', '('))).toBe(undefined);
    });
});
