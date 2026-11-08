// Notification Route label matchers (ENG-1799). Semantics follow Grafana /
// Alertmanager matchers: `=` and `!=` compare strings, `=~` and `!~` use a
// regex anchored at both ends, a missing label counts as the empty string,
// and a route matches only when every matcher holds.

export const ALERT_LABEL_MATCHER_OPERATORS = ['=', '!=', '=~', '!~'] as const;

export type AlertLabelMatcherOperator =
    (typeof ALERT_LABEL_MATCHER_OPERATORS)[number];

export type AlertLabelMatcher = {
    label: string;
    operator: AlertLabelMatcherOperator;
    value: string;
};

export type AlertLabels = Record<string, string | null | undefined>;

export const isAlertLabelMatcherOperator = (
    value: unknown,
): value is AlertLabelMatcherOperator =>
    typeof value === 'string' &&
    (ALERT_LABEL_MATCHER_OPERATORS as readonly string[]).includes(value);

/**
 * Compiles a matcher regex anchored at both ends, the way Alertmanager does
 * (`^(?:value)$`). Throws a SyntaxError for an invalid pattern.
 */
export const compileAlertLabelMatcherRegex = (pattern: string): RegExp => {
    // Compile the bare pattern first so an unbalanced one such as `a)|(b`
    // is rejected instead of escaping the anchoring group.
    const bare = new RegExp(pattern);
    return new RegExp(`^(?:${bare.source})$`);
};

/**
 * Why a matcher is invalid, or undefined when it is valid. A matcher needs a
 * non-empty label name, a known operator and, for `=~`/`!~`, a valid regex.
 */
export const getAlertLabelMatcherError = (
    matcher: AlertLabelMatcher,
): string | undefined => {
    if (typeof matcher.label !== 'string' || matcher.label.length === 0) {
        return 'Matcher label must not be empty';
    }
    if (!isAlertLabelMatcherOperator(matcher.operator)) {
        return `Unknown matcher operator "${String(matcher.operator)}"`;
    }
    if (typeof matcher.value !== 'string') {
        return 'Matcher value must be a string';
    }
    if (matcher.operator === '=~' || matcher.operator === '!~') {
        try {
            compileAlertLabelMatcherRegex(matcher.value);
        } catch {
            return `Invalid regex "${matcher.value}" for label "${matcher.label}"`;
        }
    }
    return undefined;
};

/**
 * Whether one matcher holds for the labels. A missing (or null) label is
 * treated as ''. An invalid regex or unknown operator never holds.
 */
export const matchAlertLabelMatcher = (
    labels: AlertLabels,
    matcher: AlertLabelMatcher,
): boolean => {
    const actual = labels[matcher.label] ?? '';
    switch (matcher.operator) {
        case '=':
            return actual === matcher.value;
        case '!=':
            return actual !== matcher.value;
        case '=~':
        case '!~': {
            let regex: RegExp;
            try {
                regex = compileAlertLabelMatcherRegex(matcher.value);
            } catch {
                return false;
            }
            const matched = regex.test(actual);
            return matcher.operator === '=~' ? matched : !matched;
        }
        default:
            return false;
    }
};

/** Whether every matcher holds for the labels (an empty list matches all). */
export const matchAlertLabelMatchers = (
    labels: AlertLabels,
    matchers: readonly AlertLabelMatcher[],
): boolean =>
    matchers.every((matcher) => matchAlertLabelMatcher(labels, matcher));
