import { subject } from '@casl/ability';
import {
    ALERT_RULE_DEFAULTS,
    AlreadyExistsError,
    ForbiddenError,
    generateSlug,
    getAlertRuleState,
    NotFoundError,
    ParameterError,
    type AlertRule,
    type AlertRuleDefinition,
    type AlertRuleSummary,
    type AlertRuleWithInstances,
    type CreateAlertRule,
    type SessionUser,
    type UpdateAlertRule,
} from '@lightdash/common';
import {
    getAlertRuleDefinition,
    isUniqueViolation,
    type AlertRuleModel,
} from './AlertRuleModel';

type AlertRuleAction = 'view' | 'manage';

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

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

/**
 * Value checks for a complete definition. Kept as one seam so the rule
 * validation (durations, minimum interval, reducers, operators, states,
 * folder) lives in one place for create, update and upload.
 */
const validateDefinition = (definition: AlertRuleDefinition) => {
    if (
        definition.spaceUuid !== null &&
        !UUID_PATTERN.test(definition.spaceUuid)
    ) {
        throw new ParameterError('spaceUuid must be a uuid');
    }
};

export class AlertRuleService {
    constructor(
        private readonly deps: {
            alertRuleModel: AlertRuleModel;
            clock: { now(): Date };
        },
    ) {}

    /** 404 for an unknown project, 403 without the ability on it. */
    private async assertAbility(
        user: SessionUser,
        action: AlertRuleAction,
        projectUuid: string,
    ) {
        const organizationUuid = UUID_PATTERN.test(projectUuid)
            ? await this.deps.alertRuleModel.findProjectOrganizationUuid(
                  projectUuid,
              )
            : undefined;
        if (!organizationUuid) {
            throw new NotFoundError('Project not found');
        }
        if (
            user.ability.cannot(
                action,
                subject('AlertRule', { organizationUuid, projectUuid }),
            )
        ) {
            throw new ForbiddenError();
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
    ): Promise<AlertRuleSummary[]> {
        await this.assertAbility(user, 'view', projectUuid);
        const rules = await this.deps.alertRuleModel.list(projectUuid);
        const withInstances = await this.withInstances(rules);
        return withInstances.map(({ instances: _instances, ...rule }) => rule);
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

    private async nextFreeSlug(
        projectUuid: string,
        name: string,
    ): Promise<string> {
        const base = generateSlug(name);
        const taken = new Set(
            await this.deps.alertRuleModel.getSlugs(projectUuid, base),
        );
        if (!taken.has(base)) return base;
        let suffix = 2;
        while (taken.has(`${base}-${suffix}`)) suffix += 1;
        return `${base}-${suffix}`;
    }

    async create(
        user: SessionUser,
        projectUuid: string,
        body: unknown,
    ): Promise<AlertRuleWithInstances> {
        await this.assertAbility(user, 'manage', projectUuid);
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
