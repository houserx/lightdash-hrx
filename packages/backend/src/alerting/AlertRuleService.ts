import {
    ALERT_CONDITION_OPERATORS,
    ALERT_ERROR_STATES,
    ALERT_NO_DATA_STATES,
    ALERT_RANGE_OPERATORS,
    ALERT_REDUCERS,
    ALERT_RULE_DEFAULTS,
    ALERT_RULE_MIN_INTERVAL,
    ALERT_RULE_STATE_PRECEDENCE,
    ALERT_THRESHOLD_OPERATORS,
    AlreadyExistsError,
    ForbiddenError,
    generateSlug,
    getAlertRuleState,
    isAlertRuleState,
    NotFoundError,
    ParameterError,
    parsePrometheusDuration,
    type AlertRule,
    type AlertRuleDefinition,
    type AlertRuleListFilters,
    type AlertRulePreview,
    type AlertRuleSummary,
    type AlertRuleVersion,
    type AlertRuleWithInstances,
    type AlertStateHistoryEntry,
    type CreateAlertRule,
    type SessionUser,
    type UpdateAlertRule,
} from '@lightdash/common';
import { type AlertEvaluator } from './AlertEvaluator';
import {
    assertAlertingAbility,
    isUniqueViolation,
    nextFreeSlug,
    SLUG_PATTERN,
    UUID_PATTERN,
    type AlertingAction,
} from './alertingAccess';
import { getAlertRuleDefinition, type AlertRuleModel } from './AlertRuleModel';
import { type AlertStateHistoryModel } from './AlertStateHistoryModel';

const DEFINITION_KEYS = [
    'name',
    'description',
    'spaceUuid',
    'labels',
    'annotations',
    'query',
    'valueColumn',
    'reducer',
    'condition',
    'for',
    'keepFiringFor',
    'interval',
    'timeRange',
    'noDataState',
    'errorState',
    'paused',
    'shadow',
] as const satisfies readonly (keyof AlertRuleDefinition)[];

const STRING_KEYS = [
    'name',
    'description',
    'query',
    'valueColumn',
    'reducer',
    'for',
    'keepFiringFor',
    'interval',
    'timeRange',
    'noDataState',
    'errorState',
] as const;

const REQUIRED_ON_CREATE = [
    'name',
    'description',
    'query',
    'condition',
] as const satisfies readonly (keyof CreateAlertRule)[];

const MAX_SLUG_ATTEMPTS = 5;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringMap = (value: unknown): value is Record<string, string> =>
    isPlainObject(value) &&
    Object.values(value).every((v) => typeof v === 'string');

/**
 * Checks the shape of a rule body: known fields with the right JSON types,
 * and non-blank name, description and query. Value rules (durations,
 * reducers, operators, states, folder) are checked by `validateDefinition`.
 */
const parseRuleBody = (
    body: unknown,
    { allowSlug }: { allowSlug: boolean },
): Partial<AlertRuleDefinition> & { slug?: string } => {
    if (!isPlainObject(body)) {
        throw new ParameterError('The Alert Rule must be a JSON object');
    }
    const allowed: readonly string[] = allowSlug
        ? [...DEFINITION_KEYS, 'slug']
        : DEFINITION_KEYS;
    const unknownKeys = Object.keys(body).filter(
        (key) => !allowed.includes(key),
    );
    if (unknownKeys.length > 0) {
        throw new ParameterError(
            `Unknown Alert Rule field: ${unknownKeys.join(', ')}`,
        );
    }
    STRING_KEYS.forEach((key) => {
        if (key in body && typeof body[key] !== 'string') {
            throw new ParameterError(`${key} must be a string`);
        }
    });
    (['name', 'description', 'query'] as const).forEach((key) => {
        if (key in body && String(body[key]).trim() === '') {
            throw new ParameterError(`${key} must not be blank`);
        }
    });
    if (
        'spaceUuid' in body &&
        body.spaceUuid !== null &&
        typeof body.spaceUuid !== 'string'
    ) {
        throw new ParameterError('spaceUuid must be a string or null');
    }
    (['labels', 'annotations'] as const).forEach((key) => {
        if (key in body && !isStringMap(body[key])) {
            throw new ParameterError(
                `${key} must be an object of string values`,
            );
        }
    });
    if ('condition' in body && !isPlainObject(body.condition)) {
        throw new ParameterError('condition must be an object');
    }
    (['paused', 'shadow'] as const).forEach((key) => {
        if (key in body && typeof body[key] !== 'boolean') {
            throw new ParameterError(`${key} must be true or false`);
        }
    });
    if (
        'slug' in body &&
        (typeof body.slug !== 'string' || !SLUG_PATTERN.test(body.slug))
    ) {
        throw new ParameterError(
            'slug must be lowercase letters, digits and single hyphens',
        );
    }
    // The checks above pin every present field to its declared type.
    return body as Partial<AlertRuleDefinition> & { slug?: string };
};

const isOneOf = <T extends string>(
    values: readonly T[],
    value: unknown,
): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value);

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

/** Milliseconds of a Prometheus duration, or a 400 naming the field. */
const parseDurationField = (key: string, value: string): number => {
    try {
        return parsePrometheusDuration(value);
    } catch {
        throw new ParameterError(
            `${key} must be a duration such as 30s, 5m or 1h30m`,
        );
    }
};

const validateCondition = (condition: Record<string, unknown>) => {
    const { operator } = condition;
    const expectKeys = (keys: readonly string[]) => {
        const extra = Object.keys(condition).filter((k) => !keys.includes(k));
        if (extra.length > 0) {
            throw new ParameterError(
                `Unknown condition field for operator ${String(operator)}: ${extra.join(', ')}`,
            );
        }
    };
    if (isOneOf(ALERT_THRESHOLD_OPERATORS, operator)) {
        expectKeys(['operator', 'threshold']);
        if (!isFiniteNumber(condition.threshold)) {
            throw new ParameterError('condition.threshold must be a number');
        }
        return;
    }
    if (isOneOf(ALERT_RANGE_OPERATORS, operator)) {
        expectKeys(['operator', 'min', 'max']);
        if (!isFiniteNumber(condition.min) || !isFiniteNumber(condition.max)) {
            throw new ParameterError(
                'condition.min and condition.max must be numbers',
            );
        }
        if (condition.min > condition.max) {
            throw new ParameterError(
                'condition.min must not be greater than condition.max',
            );
        }
        return;
    }
    throw new ParameterError(
        `condition.operator must be one of ${ALERT_CONDITION_OPERATORS.join(', ')}`,
    );
};

/**
 * Value checks for a complete definition (create, and the merged
 * definition of an update): durations, minimum interval, reducer,
 * condition, no-data and error states, and the folder's uuid shape. That
 * the folder is a space of the project needs the database; see
 * `assertFolder`.
 */
const validateDefinition = (definition: AlertRuleDefinition) => {
    if (
        definition.spaceUuid !== null &&
        !UUID_PATTERN.test(definition.spaceUuid)
    ) {
        throw new ParameterError('spaceUuid must be a uuid');
    }
    if (definition.valueColumn.trim() === '') {
        throw new ParameterError('valueColumn must not be blank');
    }
    parseDurationField('for', definition.for);
    parseDurationField('keepFiringFor', definition.keepFiringFor);
    if (parseDurationField('timeRange', definition.timeRange) <= 0) {
        throw new ParameterError('timeRange must be longer than 0s');
    }
    if (
        parseDurationField('interval', definition.interval) <
        parsePrometheusDuration(ALERT_RULE_MIN_INTERVAL)
    ) {
        throw new ParameterError(
            `interval must be at least ${ALERT_RULE_MIN_INTERVAL}`,
        );
    }
    if (!isOneOf(ALERT_REDUCERS, definition.reducer)) {
        throw new ParameterError(
            `reducer must be one of ${ALERT_REDUCERS.join(', ')}`,
        );
    }
    validateCondition(definition.condition);
    if (!isOneOf(ALERT_NO_DATA_STATES, definition.noDataState)) {
        throw new ParameterError(
            `noDataState must be one of ${ALERT_NO_DATA_STATES.join(', ')}`,
        );
    }
    if (!isOneOf(ALERT_ERROR_STATES, definition.errorState)) {
        throw new ParameterError(
            `errorState must be one of ${ALERT_ERROR_STATES.join(', ')}`,
        );
    }
};

/** The query parameter's values; repeated parameters arrive as an array. */
const queryValues = (key: string, value: unknown): string[] => {
    if (value === undefined) return [];
    const values = Array.isArray(value) ? value : [value];
    if (!values.every((v): v is string => typeof v === 'string')) {
        throw new ParameterError(`${key} must be a string`);
    }
    return values;
};

const singleQueryValue = (key: string, value: unknown): string | undefined => {
    const values = queryValues(key, value);
    if (values.length > 1) {
        throw new ParameterError(`${key} must be given at most once`);
    }
    return values[0];
};

/**
 * Reads the filters of the rule list from its query string:
 * `state=<rule state>`, `spaceUuid=<uuid>` and any number of
 * `label=<key>=<value>`. Other parameters are ignored.
 */
export const parseAlertRuleListFilters = (
    query: Record<string, unknown>,
): AlertRuleListFilters => {
    const filters: AlertRuleListFilters = {};
    const state = singleQueryValue('state', query.state);
    if (state !== undefined) {
        if (!isAlertRuleState(state)) {
            throw new ParameterError(
                `state must be one of ${ALERT_RULE_STATE_PRECEDENCE.join(', ')}`,
            );
        }
        filters.state = state;
    }
    const spaceUuid = singleQueryValue('spaceUuid', query.spaceUuid);
    if (spaceUuid !== undefined) {
        if (!UUID_PATTERN.test(spaceUuid)) {
            throw new ParameterError('spaceUuid must be a uuid');
        }
        filters.spaceUuid = spaceUuid;
    }
    const labels = queryValues('label', query.label);
    if (labels.length > 0) {
        filters.labels = {};
        for (const label of labels) {
            const separator = label.indexOf('=');
            if (separator <= 0) {
                throw new ParameterError('label must be key=value');
            }
            const key = label.slice(0, separator);
            const value = label.slice(separator + 1);
            if (key in filters.labels && filters.labels[key] !== value) {
                throw new ParameterError(
                    `label ${key} must be given at most once`,
                );
            }
            filters.labels[key] = value;
        }
    }
    return filters;
};

const matchesFilters = (
    rule: AlertRuleSummary,
    { state, labels, spaceUuid }: AlertRuleListFilters,
): boolean =>
    (state === undefined || rule.state === state) &&
    (spaceUuid === undefined || rule.spaceUuid === spaceUuid) &&
    Object.entries(labels ?? {}).every(
        ([key, value]) => rule.labels[key] === value,
    );

export class AlertRuleService {
    constructor(
        private readonly deps: {
            alertRuleModel: AlertRuleModel;
            alertStateHistoryModel: AlertStateHistoryModel;
            rulePreviewer: Pick<AlertEvaluator, 'previewRule'>;
            clock: { now(): Date };
        },
    ) {}

    /** 404 for an unknown project, 403 without the ability on it. */
    private async assertAbility(
        user: SessionUser,
        action: AlertingAction,
        projectUuid: string,
    ) {
        await assertAlertingAbility(
            this.deps.alertRuleModel,
            user,
            action,
            'AlertRule',
            projectUuid,
        );
    }

    /** 400 unless the folder is null or a space of this project. */
    private async assertFolder(projectUuid: string, spaceUuid: string | null) {
        if (spaceUuid === null) return;
        if (
            !UUID_PATTERN.test(spaceUuid) ||
            !(await this.deps.alertRuleModel.isProjectSpace(
                projectUuid,
                spaceUuid,
            ))
        ) {
            throw new ParameterError(
                'spaceUuid must be a space of this project',
            );
        }
    }

    private async getRuleOrThrow(
        projectUuid: string,
        ruleUuid: string,
    ): Promise<AlertRule> {
        const rule = UUID_PATTERN.test(ruleUuid)
            ? await this.deps.alertRuleModel.find(projectUuid, ruleUuid)
            : undefined;
        if (!rule) {
            throw new NotFoundError('Alert Rule not found');
        }
        return rule;
    }

    private async withInstances(
        rules: AlertRule[],
    ): Promise<AlertRuleWithInstances[]> {
        const instances = await this.deps.alertRuleModel.getInstances(
            rules.map((rule) => rule.uuid),
        );
        return rules.map((rule) => {
            const ruleInstances = instances.get(rule.uuid) ?? [];
            return {
                ...rule,
                state: getAlertRuleState(ruleInstances.map((i) => i.state)),
                instances: ruleInstances,
            };
        });
    }

    async list(
        user: SessionUser,
        projectUuid: string,
        filters: AlertRuleListFilters = {},
    ): Promise<AlertRuleSummary[]> {
        await this.assertAbility(user, 'view', projectUuid);
        const rules = await this.deps.alertRuleModel.list(projectUuid);
        const withInstances = await this.withInstances(rules);
        return withInstances
            .map(({ instances: _instances, ...rule }) => rule)
            .filter((rule) => matchesFilters(rule, filters));
    }

    async get(
        user: SessionUser,
        projectUuid: string,
        ruleUuid: string,
    ): Promise<AlertRuleWithInstances> {
        await this.assertAbility(user, 'view', projectUuid);
        const rule = await this.getRuleOrThrow(projectUuid, ruleUuid);
        const [withInstances] = await this.withInstances([rule]);
        return withInstances;
    }

    async listVersions(
        user: SessionUser,
        projectUuid: string,
        ruleUuid: string,
    ): Promise<AlertRuleVersion[]> {
        await this.assertAbility(user, 'view', projectUuid);
        const rule = await this.getRuleOrThrow(projectUuid, ruleUuid);
        return this.deps.alertRuleModel.listVersions(rule.uuid);
    }

    /** The rule's state history, newest first. */
    async listHistory(
        user: SessionUser,
        projectUuid: string,
        ruleUuid: string,
    ): Promise<AlertStateHistoryEntry[]> {
        await this.assertAbility(user, 'view', projectUuid);
        const rule = await this.getRuleOrThrow(projectUuid, ruleUuid);
        return this.deps.alertStateHistoryModel.listForRule(rule.uuid);
    }

    private async nextFreeSlug(
        projectUuid: string,
        name: string,
    ): Promise<string> {
        const base = generateSlug(name);
        return nextFreeSlug(
            base,
            await this.deps.alertRuleModel.getSlugs(projectUuid, base),
        );
    }

    /**
     * A new rule's body, checked as on create: required fields, defaults,
     * value rules and the folder.
     */
    private async parseNewRule(
        projectUuid: string,
        body: unknown,
    ): Promise<{
        requestedSlug: string | undefined;
        definition: AlertRuleDefinition;
    }> {
        const input = parseRuleBody(body, { allowSlug: true });
        const missing = REQUIRED_ON_CREATE.filter(
            (key) => input[key] === undefined,
        );
        if (missing.length > 0) {
            throw new ParameterError(
                `Missing required Alert Rule field: ${missing.join(', ')}`,
            );
        }
        const { slug: requestedSlug, ...fields } = input as CreateAlertRule;
        const definition = getAlertRuleDefinition({
            ...ALERT_RULE_DEFAULTS,
            spaceUuid: null,
            labels: {},
            annotations: {},
            ...fields,
        });
        validateDefinition(definition);
        await this.assertFolder(projectUuid, definition.spaceUuid);
        return { requestedSlug, definition };
    }

    /**
     * "Test rule": checks the body as create does (editors and above only),
     * then runs its query once and returns every series' value, whether the
     * condition holds and the state it would enter. Nothing is saved; a
     * failing query is reported in the result, not as an HTTP error.
     */
    async preview(
        user: SessionUser,
        projectUuid: string,
        body: unknown,
    ): Promise<AlertRulePreview> {
        await this.assertAbility(user, 'manage', projectUuid);
        const { definition } = await this.parseNewRule(projectUuid, body);
        return this.deps.rulePreviewer.previewRule({
            projectUuid,
            rule: definition,
            at: this.deps.clock.now(),
        });
    }

    async create(
        user: SessionUser,
        projectUuid: string,
        body: unknown,
    ): Promise<AlertRuleWithInstances> {
        await this.assertAbility(user, 'manage', projectUuid);
        const { requestedSlug, definition } = await this.parseNewRule(
            projectUuid,
            body,
        );
        const ruleUuid = await this.insertRule({
            user,
            projectUuid,
            definition,
            requestedSlug,
            attempt: 1,
        });
        return this.get(user, projectUuid, ruleUuid);
    }

    private async insertRule(args: {
        user: SessionUser;
        projectUuid: string;
        definition: AlertRuleDefinition;
        requestedSlug: string | undefined;
        attempt: number;
    }): Promise<string> {
        const slug =
            args.requestedSlug ??
            (await this.nextFreeSlug(args.projectUuid, args.definition.name));
        try {
            return await this.deps.alertRuleModel.create({
                projectUuid: args.projectUuid,
                slug,
                definition: args.definition,
                userUuid: args.user.userUuid,
                now: this.deps.clock.now(),
            });
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            if (args.requestedSlug !== undefined) {
                throw new AlreadyExistsError(
                    `An Alert Rule with slug "${slug}" already exists in this project`,
                );
            }
            // A concurrent create took the generated slug: pick again.
            if (args.attempt >= MAX_SLUG_ATTEMPTS) throw error;
            return this.insertRule({ ...args, attempt: args.attempt + 1 });
        }
    }

    async update(
        user: SessionUser,
        projectUuid: string,
        ruleUuid: string,
        body: unknown,
    ): Promise<AlertRuleWithInstances> {
        await this.assertAbility(user, 'manage', projectUuid);
        const change: UpdateAlertRule = parseRuleBody(body, {
            allowSlug: false,
        });
        await this.getRuleOrThrow(projectUuid, ruleUuid);
        // Only a new folder needs the lookup; the rule's own was checked
        // when it was set.
        if (change.spaceUuid !== undefined) {
            await this.assertFolder(projectUuid, change.spaceUuid);
        }
        const result = await this.deps.alertRuleModel.update({
            projectUuid,
            ruleUuid,
            userUuid: user.userUuid,
            now: this.deps.clock.now(),
            apply: (current) => {
                if (current.managed) {
                    throw new ForbiddenError(
                        'This Alert Rule is managed in git; change it there and upload it again',
                    );
                }
                const next = getAlertRuleDefinition({ ...current, ...change });
                validateDefinition(next);
                return next;
            },
        });
        if (!result) throw new NotFoundError('Alert Rule not found');
        return this.get(user, projectUuid, ruleUuid);
    }

    async delete(
        user: SessionUser,
        projectUuid: string,
        ruleUuid: string,
    ): Promise<void> {
        await this.assertAbility(user, 'manage', projectUuid);
        const rule = await this.getRuleOrThrow(projectUuid, ruleUuid);
        if (rule.managed) {
            throw new ForbiddenError(
                'This Alert Rule is managed in git; remove it there instead',
            );
        }
        const deleted = await this.deps.alertRuleModel.delete(
            projectUuid,
            ruleUuid,
        );
        if (!deleted) throw new NotFoundError('Alert Rule not found');
    }
}
