/**
 * ENG-1799 importers: Grafana alerting Terraform (`grafana_rule_group`, `grafana_contact_point`,
 * `grafana_notification_policy`) to alerting as code (alert_rule, contact_point and
 * notification_routes documents). Pure: `lightdash import grafana-alerts` reads the files and
 * writes what this returns.
 *
 * Every rule is imported in Shadow Run (`shadow: true`). A rule whose query or condition the
 * importer can't translate is still emitted, valid and paused, with a `rule-needs-review` warning.
 */
import type {
    AlertRuleAsCode,
    ContactPointAsCode,
    ContactPointIntegrationAsCode,
    NotificationRoutesAsCode,
} from '../alerting/asCode';
import type {
    AlertCondition,
    AlertRangeOperator,
    AlertThresholdOperator,
} from '../alerting/conditions';
import type { AlertReducer } from '../alerting/reducers';
import {
    isAlertLabelMatcherOperator,
    type AlertLabelMatcher,
} from '../alerting/routingMatchers';
import type { NotificationRoute } from '../alerting/routingTree';
import {
    telemetrySourceName,
    translateGrafanaTarget,
    type GrafanaDatasource,
    type GrafanaTarget,
} from './grafanaQuery';
import type { ImportWarning } from './importWarnings';
import {
    evaluateHcl,
    getHclAttribute,
    getHclBlocks,
    hclHasUnknown,
    isHclObject,
    isHclUnknown,
    parseHcl,
    traverseHclValue,
    type HclBlock,
    type HclBody,
    type HclFile,
    type HclStep,
    type HclValue,
} from './terraformHcl';

/** One Terraform file: its path (for messages) and its text. */
export type TerraformSourceFile = { file: string; text: string };

export type GrafanaAlertingImportInput = {
    /** Files with `resource "grafana_rule_group"` blocks. */
    rules: TerraformSourceFile[];
    /** The file with the `resource "grafana_contact_point"` blocks. */
    contactPoints: TerraformSourceFile;
    /** The file with the `resource "grafana_notification_policy"` block. */
    policy: TerraformSourceFile;
    /** Files with `locals` blocks the others reference. */
    locals?: TerraformSourceFile[];
    /** grafana_folders.tf. */
    folders?: TerraformSourceFile;
    /** From grafana_data_sources.tf: `grafana_data_source.<name>.uid` resolves through these. */
    datasources?: GrafanaDatasource[];
};

export type GrafanaAlertingImport = {
    alertRules: AlertRuleAsCode[];
    contactPoints: ContactPointAsCode[];
    notificationRoutes: NotificationRoutesAsCode;
    warnings: ImportWarning[];
};

/** Thrown for input the importer can't use at all; the message names the file. */
export class GrafanaAlertingImportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GrafanaAlertingImportError';
    }
}

/** Grafana `reduce` expression reducers the alert rule reducer covers. */
const REDUCE_REDUCERS: Record<string, AlertReducer> = {
    last: 'last',
    mean: 'mean',
    max: 'max',
    min: 'min',
    sum: 'sum',
    count: 'count',
};

/** Grafana classic condition reducers the alert rule reducer covers. */
const CLASSIC_REDUCERS: Record<string, AlertReducer> = {
    last: 'last',
    avg: 'mean',
    max: 'max',
    min: 'min',
    sum: 'sum',
    count: 'count',
    count_non_null: 'count',
};

const THRESHOLD_OPERATORS: Record<string, AlertThresholdOperator> = {
    gt: '>',
    lt: '<',
};

/** Exclusive ranges only: the `_included` variants have no alert rule operator. */
const RANGE_OPERATORS: Record<string, AlertRangeOperator> = {
    within_range: 'within_range',
    outside_range: 'outside_range',
};

const DURATION_PATTERN =
    /^(?:0|(?=\d)(?:\d+y)?(?:\d+w)?(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?(?:\d+ms)?)$/;
const LABEL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GROUP_BY_PATTERN = /^(?:\.\.\.|[A-Za-z_][A-Za-z0-9_]*)$/;

/** What a rule that needs review runs until someone fixes it: valid SQL that never fires. */
export const PLACEHOLDER_ALERT_QUERY = 'SELECT CAST(NULL AS DOUBLE) AS value';

/** A slug for the as-code documents; never random (generateSlug is, for empty input). */
const toSlug = (name: string, fallback: string): string => {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug === '' ? fallback : slug;
};

/** `slug`, or `slug-2`, `slug-3`, ... when it is taken; records the result. */
const uniqueSlug = (slug: string, taken: Set<string>): string => {
    let candidate = slug;
    for (let n = 2; taken.has(candidate); n += 1) candidate = `${slug}-${n}`;
    taken.add(candidate);
    return candidate;
};

const asString = (value: HclValue | undefined): string | undefined =>
    typeof value === 'string' ? value : undefined;

type Warn = (warning: ImportWarning) => void;

/** A block body with the variables (each, dynamic iterators) it is evaluated with. */
type ExpandedBlock = { body: HclBody; variables: Record<string, HclValue> };

/**
 * The `{key, value}` instances of a for_each: a map gives one per key in lexical order; a list
 * gives one per element. Sets and lists are both arrays once evaluated, so `listKey` says which
 * Terraform means: a resource for_each only takes sets (key = value), a dynamic block is usually
 * given a list (key = index). Undefined when the value can't be iterated or holds unknowns.
 */
const forEachInstances = (
    value: HclValue,
    listKey: 'value' | 'index',
): { key: HclValue; value: HclValue }[] | undefined => {
    if (hclHasUnknown(value)) return undefined;
    if (Array.isArray(value)) {
        return value.map((v, i) => ({
            key: listKey === 'value' ? v : i,
            value: v,
        }));
    }
    if (isHclObject(value)) {
        return Object.keys(value)
            .sort()
            .map((key) => ({ key, value: value[key] }));
    }
    return undefined;
};

/** Seconds as the shortest whole duration: 60 -> 1m, 300 -> 5m, 90 -> 90s. */
const secondsToDuration = (seconds: number): string => {
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    if (seconds % 60 === 0) return `${seconds / 60}m`;
    return `${seconds}s`;
};

// The import's own error type sits next to the Terraform context it reads with.
/* eslint-disable max-classes-per-file */

/**
 * The Terraform the import reads: every file parsed once, its resources and locals indexed, and
 * references between them resolved (locals, resource attributes, datasource uids).
 */
class TerraformContext {
    private readonly resources = new Map<
        string,
        { block: HclBlock; hcl: HclFile }
    >();

    private readonly locals = new Map<
        string,
        { expr: HclFile['body']['attributes'][number]['expr']; hcl: HclFile }
    >();

    private readonly localValues = new Map<string, HclValue>();

    private readonly evaluating = new Set<string>();

    readonly files = new Map<string, HclFile>();

    constructor(
        sources: TerraformSourceFile[],
        private readonly datasources: GrafanaDatasource[] | undefined,
    ) {
        sources.forEach(({ file, text }) => {
            if (this.files.has(file)) return;
            const hcl = parseHcl(text, file);
            this.files.set(file, hcl);
            hcl.body.blocks.forEach((block) => {
                if (block.type === 'resource' && block.labels.length === 2) {
                    const key = block.labels.join('.');
                    if (!this.resources.has(key)) {
                        this.resources.set(key, { block, hcl });
                    }
                }
                if (block.type === 'locals') {
                    block.body.attributes.forEach((attribute) => {
                        if (!this.locals.has(attribute.name)) {
                            this.locals.set(attribute.name, {
                                expr: attribute.expr,
                                hcl,
                            });
                        }
                    });
                }
            });
        });
    }

    private local(name: string): HclValue | undefined {
        if (this.localValues.has(name)) return this.localValues.get(name);
        const local = this.locals.get(name);
        if (local === undefined || this.evaluating.has(name)) return undefined;
        this.evaluating.add(name);
        const value = this.evaluate(local.expr, local.hcl);
        this.evaluating.delete(name);
        this.localValues.set(name, value);
        return value;
    }

    private resolve(root: string, steps: HclStep[]): HclValue | undefined {
        const text = [root, ...steps].join('.');
        if (root === 'local' && typeof steps[0] === 'string') {
            const value = this.local(steps[0]);
            return value === undefined
                ? undefined
                : traverseHclValue(value, steps.slice(1), text);
        }
        if (
            root === 'grafana_data_source' &&
            typeof steps[0] === 'string' &&
            this.datasources
        ) {
            const wanted = telemetrySourceName(steps[0]);
            const found = this.datasources.find(
                (ds) =>
                    ds.uid !== '' && telemetrySourceName(ds.name) === wanted,
            );
            // `grafana_data_source.x` alone (e.g. a local map of them) is the resource object.
            if (found) {
                return traverseHclValue(
                    { uid: found.uid, name: found.name, type: found.type },
                    steps.slice(1),
                    text,
                );
            }
        }
        // An attribute of a resource in the files read (`grafana_contact_point.x.name`).
        if (typeof steps[0] === 'string' && typeof steps[1] === 'string') {
            const resource = this.resources.get(`${root}.${steps[0]}`);
            if (
                resource &&
                getHclAttribute(resource.block.body, 'for_each') === undefined
            ) {
                const value = this.attribute(
                    resource.block.body,
                    steps[1],
                    resource.hcl,
                );
                if (value !== undefined) {
                    return traverseHclValue(value, steps.slice(2), text);
                }
            }
        }
        return undefined;
    }

    evaluate(
        expr: HclFile['body']['attributes'][number]['expr'],
        hcl: HclFile,
        variables: Record<string, HclValue> = {},
    ): HclValue {
        return evaluateHcl(expr, hcl.text, {
            variables,
            resolve: (root, steps) => this.resolve(root, steps),
        });
    }

    /** An attribute's value, or `undefined` when the body doesn't set it. */
    attribute(
        body: HclBody,
        name: string,
        hcl: HclFile,
        variables: Record<string, HclValue> = {},
    ): HclValue | undefined {
        const attribute = getHclAttribute(body, name);
        return attribute === undefined
            ? undefined
            : this.evaluate(attribute.expr, hcl, variables);
    }

    /**
     * The `type` blocks of `body` in source order, with `dynamic "<type>"` blocks expanded: each
     * element of the dynamic block's for_each gives its `content` body, with the iterator (the
     * `iterator` attribute, else the block type) bound to `{key, value}`. A for_each the importer
     * can't evaluate is warned and gives no blocks.
     */
    blocks(
        body: HclBody,
        type: string,
        hcl: HclFile,
        variables: Record<string, HclValue>,
        warn: Warn,
        where: Partial<ImportWarning>,
    ): ExpandedBlock[] {
        const out: ExpandedBlock[] = [];
        body.blocks.forEach((block) => {
            if (block.type === type) {
                out.push({ body: block.body, variables });
                return;
            }
            if (block.type !== 'dynamic' || block.labels[0] !== type) return;
            const content = getHclBlocks(block.body, 'content')[0];
            const forEach = this.attribute(
                block.body,
                'for_each',
                hcl,
                variables,
            );
            const instances =
                forEach === undefined
                    ? undefined
                    : forEachInstances(forEach, 'index');
            if (content === undefined || instances === undefined) {
                warn({
                    code: 'terraform-unresolved',
                    message: `A dynamic "${type}" block can't be expanded: ${
                        content === undefined
                            ? 'it has no content block'
                            : `its for_each ${
                                  isHclUnknown(forEach)
                                      ? `(${forEach.text}) is unknown: ${forEach.reason}`
                                      : 'is not a list or map'
                              }`
                    }. Its blocks are not imported.`,
                    ...where,
                });
                return;
            }
            const iteratorExpr = getHclAttribute(block.body, 'iterator')?.expr;
            const iterator =
                iteratorExpr?.kind === 'variable' ? iteratorExpr.name : type;
            instances.forEach((instance) =>
                out.push({
                    body: content.body,
                    variables: { ...variables, [iterator]: instance },
                }),
            );
        });
        return out;
    }

    /** `resource "<type>" "<name>"` blocks of one file, in order. */
    resourcesOf(file: string, type: string): HclBlock[] {
        const hcl = this.files.get(file);
        return (hcl?.body.blocks ?? []).filter(
            (b) => b.type === 'resource' && b.labels[0] === type,
        );
    }
}

/** Warns once for the attributes and blocks of `body` the importer doesn't read. */
const warnDropped = (
    body: HclBody,
    handled: string[],
    warn: Warn,
    what: string,
    extra: Partial<ImportWarning>,
) => {
    const dropped = [
        ...body.attributes.map((a) => a.name),
        ...body.blocks.map((b) => b.type),
    ].filter(
        (name, i, all) => !handled.includes(name) && all.indexOf(name) === i,
    );
    if (dropped.length > 0) {
        warn({
            code: 'option-dropped',
            message: `${what}: ${dropped.join(', ')} ${
                dropped.length === 1 ? 'is' : 'are'
            } not imported.`,
            ...extra,
        });
    }
};

/** A string map (labels, annotations); entries that aren't known strings are warned and left out. */
const stringMap = (
    value: HclValue | undefined,
    what: string,
    warn: Warn,
    rule: string,
    keyPattern?: RegExp,
): Record<string, string> | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!isHclObject(value)) {
        warn({
            code: 'terraform-unresolved',
            message: `The ${what} can't be read: ${
                isHclUnknown(value) ? value.reason : 'it is not a map'
            }. They are not imported.`,
            rule,
        });
        return undefined;
    }
    const out: Record<string, string> = {};
    Object.keys(value)
        .sort()
        .forEach((key) => {
            const v = value[key];
            if (keyPattern && !keyPattern.test(key)) {
                warn({
                    code: 'label-invalid',
                    message: `The ${what} key ${JSON.stringify(key)} is not a valid name; it is not imported.`,
                    rule,
                });
            } else if (
                typeof v === 'string' ||
                typeof v === 'number' ||
                typeof v === 'boolean'
            ) {
                out[key] = String(v);
            } else {
                warn({
                    code: 'terraform-unresolved',
                    message: `The ${what} ${JSON.stringify(key)} can't be read${
                        isHclUnknown(v) ? `: ${v.reason}` : ''
                    }; it is not imported.`,
                    rule,
                });
            }
        });
    return Object.keys(out).length > 0 ? out : undefined;
};

type RuleData = {
    refId: string;
    datasourceUid: HclValue | undefined;
    model: Record<string, unknown> | undefined;
};

const readModel = (
    value: HclValue | undefined,
): Record<string, unknown> | undefined => {
    if (typeof value === 'string') {
        try {
            const parsed: unknown = JSON.parse(value);
            return typeof parsed === 'object' &&
                parsed !== null &&
                !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : undefined;
        } catch {
            return undefined;
        }
    }
    return isHclObject(value) && !hclHasUnknown(value)
        ? (value as Record<string, unknown>)
        : undefined;
};

const isExpression = (data: RuleData) =>
    data.datasourceUid === '__expr__' ||
    (data.model?.datasource as { type?: unknown } | undefined)?.type ===
        '__expr__';

/** The query text of a model, for messages and generated descriptions. */
const queryText = (
    model: Record<string, unknown> | undefined,
): string | undefined =>
    [model?.expr, model?.expression, model?.queryText, model?.rawSql].find(
        (q): q is string => typeof q === 'string' && q.trim() !== '',
    );

/** A warning the imported condition carries: it runs, but not exactly as in Grafana. */
type ConditionNote = { code: ImportWarning['code']; message: string };

type ConvertedCondition =
    | {
          reducer: AlertReducer;
          condition: AlertCondition;
          notes: ConditionNote[];
      }
    | { review: string };

type GrafanaEvaluator = { type?: unknown; params?: unknown };

/** A Grafana evaluator: gt/lt with one param, within_range/outside_range with two. */
const convertEvaluator = (
    evaluator: GrafanaEvaluator | undefined,
): AlertCondition | { review: string } => {
    const type =
        typeof evaluator?.type === 'string' ? evaluator.type : undefined;
    const params = Array.isArray(evaluator?.params)
        ? (evaluator.params as unknown[])
        : [];
    const [first, second] = params;
    const thresholdOperator =
        type === undefined ? undefined : THRESHOLD_OPERATORS[type];
    if (thresholdOperator !== undefined && typeof first === 'number') {
        return { operator: thresholdOperator, threshold: first };
    }
    const rangeOperator =
        type === undefined ? undefined : RANGE_OPERATORS[type];
    if (
        rangeOperator !== undefined &&
        typeof first === 'number' &&
        typeof second === 'number'
    ) {
        return { operator: rangeOperator, min: first, max: second };
    }
    return { review: `its threshold ${type ?? '(none)'} is not imported yet` };
};

/** A classic_conditions expression with one condition: reducer and evaluator of the rule's query. */
const convertClassicConditions = (
    ref: string,
    expr: Record<string, unknown>,
    queryRef: string | undefined,
): ConvertedCondition => {
    const conditions = Array.isArray(expr.conditions)
        ? (expr.conditions as Array<{
              evaluator?: GrafanaEvaluator;
              query?: { params?: unknown };
              reducer?: { type?: unknown };
          }>)
        : [];
    if (conditions.length !== 1) {
        return {
            review: `its classic condition ${ref} has ${conditions.length} conditions, which is not imported yet`,
        };
    }
    const [classic] = conditions;
    const input = Array.isArray(classic.query?.params)
        ? (classic.query.params as unknown[])[0]
        : undefined;
    if (input === undefined || input !== queryRef) {
        return {
            review: `its classic condition ${ref} reads ${String(input)}, not the rule's query`,
        };
    }
    const reducerType =
        typeof classic.reducer?.type === 'string'
            ? classic.reducer.type
            : undefined;
    const reducer =
        reducerType === undefined ? undefined : CLASSIC_REDUCERS[reducerType];
    if (reducer === undefined) {
        return {
            review: `its classic condition reducer ${reducerType ?? '(none)'} is not imported yet`,
        };
    }
    const condition = convertEvaluator(classic.evaluator);
    if ('review' in condition) return condition;
    const notes: ConditionNote[] =
        reducerType === 'count'
            ? [
                  {
                      code: 'rule-null-handling-changed',
                      message: `The classic condition ${ref} counts null values too; the imported count reducer ignores null values.`,
                  },
              ]
            : [];
    return { reducer, condition, notes };
};

/** Null handling of a reduce expression: strict and dropNN match the reducer closely; replaceNN does not. */
const reduceModeNotes = (
    ref: string,
    reduce: Record<string, unknown>,
    reducer: AlertReducer,
): ConditionNote[] => {
    const settings = (reduce.settings ?? {}) as {
        mode?: unknown;
        replaceWithValue?: unknown;
    };
    if (settings.mode !== 'replaceNN') return [];
    return [
        {
            code: 'rule-null-handling-changed',
            message: `The reduce expression ${ref} uses mode replaceNN (null values replaced with ${String(
                settings.replaceWithValue ?? 0,
            )}); the imported ${reducer} reducer ignores null values instead.`,
        },
    ];
};

/**
 * The rule's condition expression: reduce + threshold, a threshold on an instant query, or
 * classic conditions. Thresholds are gt/lt or within/outside range.
 */
const convertCondition = (
    conditionRef: string | undefined,
    expressions: Map<string, Record<string, unknown>>,
    queryRef: string | undefined,
): ConvertedCondition => {
    if (conditionRef === undefined) return { review: 'it has no condition' };
    const expr = expressions.get(conditionRef);
    if (expr === undefined) {
        return {
            review: `its condition ${conditionRef} is not a threshold expression`,
        };
    }
    if (expr.type === 'classic_conditions') {
        return convertClassicConditions(conditionRef, expr, queryRef);
    }
    if (expr.type !== 'threshold') {
        return {
            review: `its condition is a ${String(expr.type)} expression, which is not imported yet`,
        };
    }
    const first = (
        expr.conditions as
            | Array<{ evaluator?: GrafanaEvaluator; unloadEvaluator?: unknown }>
            | undefined
    )?.[0];
    const condition = convertEvaluator(first?.evaluator);
    if ('review' in condition) return condition;
    const notes: ConditionNote[] =
        first?.unloadEvaluator !== undefined && first.unloadEvaluator !== null
            ? [
                  {
                      code: 'expression-hysteresis-dropped',
                      message: `The threshold ${conditionRef} has a recovery threshold (unloadEvaluator); the imported rule resolves when the condition is no longer met.`,
                  },
              ]
            : [];
    const input =
        typeof expr.expression === 'string' ? expr.expression : undefined;
    if (input !== undefined && input === queryRef) {
        return { reducer: 'last', condition, notes };
    }
    const reduce = input === undefined ? undefined : expressions.get(input);
    const reducer =
        reduce?.type === 'reduce' &&
        reduce.expression === queryRef &&
        typeof reduce.reducer === 'string'
            ? REDUCE_REDUCERS[reduce.reducer]
            : undefined;
    if (reduce !== undefined && input !== undefined && reducer !== undefined) {
        return {
            reducer,
            condition,
            notes: [...reduceModeNotes(input, reduce, reducer), ...notes],
        };
    }
    return {
        review: `the threshold's input ${String(input)} is not a supported reduce of the query`,
    };
};

const convertRule = (
    tf: TerraformContext,
    hcl: HclFile,
    group: string,
    index: number,
    rule: ExpandedBlock,
    interval: string | undefined,
    datasources: GrafanaDatasource[] | undefined,
    takenSlugs: Set<string>,
    warn: Warn,
): AlertRuleAsCode => {
    const { body, variables } = rule;
    const read = (key: string) => tf.attribute(body, key, hcl, variables);
    const nameValue = read('name');
    const readable = typeof nameValue === 'string' && nameValue.trim() !== '';
    const name = readable ? nameValue.trim() : `${group} rule ${index + 1}`;
    if (!readable) {
        warn({
            code: 'terraform-unresolved',
            message: `A rule in group ${group} has no name the importer can read; it is imported as "${name}".`,
            rule: name,
        });
    }
    const ruleWarn: Warn = (w) => warn({ ...w, rule: w.rule ?? name });
    const review: string[] = [];

    const data: RuleData[] = tf
        .blocks(body, 'data', hcl, variables, ruleWarn, {})
        .map((d) => {
            const readData = (key: string) =>
                tf.attribute(d.body, key, hcl, d.variables);
            return {
                refId: asString(readData('ref_id')) ?? '',
                datasourceUid: readData('datasource_uid'),
                model: readModel(readData('model')),
            };
        });
    data.filter((d) => d.model === undefined).forEach((d) =>
        review.push(
            `the model of query ${d.refId || '(no ref_id)'} can't be read`,
        ),
    );
    const queries = data.filter(
        (d) => d.model !== undefined && !isExpression(d),
    );
    const expressions = new Map(
        data
            .filter((d) => d.model !== undefined && isExpression(d))
            .map((d) => [d.refId, d.model as Record<string, unknown>]),
    );

    let query: string | undefined;
    const queryRef = queries.length === 1 ? queries[0].refId : undefined;
    if (queries.length === 1) {
        const [only] = queries;
        const model = only.model as Record<string, unknown>;
        const datasource = (model.datasource ?? {}) as {
            type?: string;
            uid?: unknown;
        };
        const target = {
            ...model,
            refId: only.refId,
            datasource: {
                ...datasource,
                uid:
                    typeof datasource.uid === 'string'
                        ? datasource.uid
                        : asString(only.datasourceUid),
            },
        } as GrafanaTarget;
        const translated = translateGrafanaTarget(target, { datasources });
        translated.warnings.forEach((w) => ruleWarn({ ...w, rule: name }));
        if (translated.sql) {
            query = translated.sql;
        } else {
            review.push(
                translated.todo ?? `query ${only.refId} can't be translated`,
            );
        }
    } else if (queries.length === 0) {
        review.push('it has no query');
    } else {
        review.push(
            `it combines ${queries.length} queries, which is not imported yet`,
        );
    }

    const conditionRef = asString(read('condition'));
    const converted = convertCondition(conditionRef, expressions, queryRef);
    if ('review' in converted) review.push(converted.review);
    else converted.notes.forEach((note) => ruleWarn(note));

    const labels = stringMap(
        read('labels'),
        'label',
        ruleWarn,
        name,
        LABEL_NAME_PATTERN,
    );
    const annotations = stringMap(
        read('annotations'),
        'annotation',
        ruleWarn,
        name,
    );

    let description = annotations?.summary?.trim();
    if (!description) {
        const text = queryText(queries[0]?.model);
        description = `Imported from the Grafana alert rule "${name}"${
            text ? `, which queries ${text.replace(/\s+/g, ' ').trim()}` : ''
        }.`;
        ruleWarn({
            code: 'rule-description-generated',
            message: `The rule has no summary annotation; its description was generated: ${description}`,
        });
    }

    const isPaused = read('is_paused') === true;
    if (review.length > 0) {
        ruleWarn({
            code: 'rule-needs-review',
            message: `The rule is imported paused because ${review.join('; ')}. Write its query and condition by hand, then unpause it.`,
        });
    }

    return {
        version: 1,
        type: 'alert_rule',
        slug: uniqueSlug(toSlug(name, 'alert-rule'), takenSlugs),
        name,
        description,
        ...(labels ? { labels } : {}),
        ...(annotations ? { annotations } : {}),
        query: query ?? PLACEHOLDER_ALERT_QUERY,
        ...(interval !== undefined ? { interval } : {}),
        ...('review' in converted
            ? { condition: { operator: '>', threshold: 0 } }
            : { reducer: converted.reducer, condition: converted.condition }),
        paused: isPaused || review.length > 0,
        shadow: true,
    };
};

const convertContactPoint = (
    tf: TerraformContext,
    hcl: HclFile,
    block: HclBlock,
    name: string,
    slug: string,
    warn: Warn,
): ContactPointIntegrationAsCode[] => {
    const where = { path: `grafana_contact_point.${block.labels[1]}` };
    const integrations: ContactPointIntegrationAsCode[] = [];
    block.body.blocks.forEach((integration) => {
        const { body } = integration;
        const read = (key: string) => tf.attribute(body, key, hcl);
        const disable = read('disable_resolve_message');
        const disableResolveMessage =
            typeof disable === 'boolean'
                ? { disableResolveMessage: disable }
                : {};
        const what = `${integration.type} integration of the contact point "${name}"`;
        if (integration.type === 'slack') {
            const title = asString(read('title'));
            const text = asString(read('text'));
            integrations.push({
                type: 'slack_webhook',
                url: { secretRef: `${slug}-webhook` },
                ...(title !== undefined ? { title } : {}),
                ...(text !== undefined ? { text } : {}),
                ...disableResolveMessage,
            });
            warnDropped(
                body,
                ['url', 'title', 'text', 'disable_resolve_message'],
                warn,
                `The ${what}`,
                where,
            );
            return;
        }
        if (integration.type === 'webhook') {
            const url = asString(read('url'));
            if (url === undefined) {
                warn({
                    code: 'terraform-unresolved',
                    message: `The ${what} has a url the importer can't read; the integration is not imported.`,
                    ...where,
                });
                return;
            }
            let host = '';
            try {
                host = new URL(url).hostname;
            } catch {
                host = '';
            }
            const hasCredentials =
                getHclAttribute(body, 'authorization_credentials') !==
                undefined;
            if (host === 'api.incident.io') {
                integrations.push({
                    type: 'incident_io',
                    url,
                    token: { secretRef: `${slug}-token` },
                    ...disableResolveMessage,
                });
            } else {
                const maxAlerts = read('max_alerts');
                integrations.push({
                    type: 'webhook',
                    url,
                    ...(hasCredentials
                        ? {
                              authorization: {
                                  secretRef: `${slug}-authorization`,
                              },
                          }
                        : {}),
                    ...(typeof maxAlerts === 'number' ? { maxAlerts } : {}),
                    ...disableResolveMessage,
                });
            }
            const method = asString(read('http_method'));
            warnDropped(
                body,
                [
                    'url',
                    'authorization_credentials',
                    'disable_resolve_message',
                    'max_alerts',
                    ...(method === undefined || method.toUpperCase() === 'POST'
                        ? ['http_method']
                        : []),
                ],
                warn,
                `The ${what}`,
                where,
            );
            return;
        }
        if (integration.type === 'email') {
            const addresses = read('addresses');
            const list = Array.isArray(addresses)
                ? addresses.filter((a): a is string => typeof a === 'string')
                : [];
            if (list.length === 0) {
                warn({
                    code: 'terraform-unresolved',
                    message: `The ${what} has no addresses the importer can read; the integration is not imported.`,
                    ...where,
                });
                return;
            }
            integrations.push({
                type: 'email',
                addresses: list,
                ...disableResolveMessage,
            });
            warnDropped(
                body,
                ['addresses', 'disable_resolve_message'],
                warn,
                `The ${what}`,
                where,
            );
            return;
        }
        warn({
            code: 'contact-point-integration-unsupported',
            message: `The ${what} is not imported: Lightdash Contact Points support Slack, incident.io, email and webhooks.`,
            ...where,
        });
    });
    return integrations;
};

const readDuration = (
    value: HclValue | undefined,
    what: string,
    warn: Warn,
    where: Partial<ImportWarning>,
): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string' && DURATION_PATTERN.test(value)) return value;
    warn({
        code: 'option-dropped',
        message: `${what} ${isHclUnknown(value) ? value.text : JSON.stringify(value)} is not a duration the importer can read; it is not imported.`,
        ...where,
    });
    return undefined;
};

const readGroupBy = (
    value: HclValue | undefined,
    warn: Warn,
    where: Partial<ImportWarning>,
): string[] | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
        warn({
            code: 'option-dropped',
            message: 'group_by is not a list; it is not imported.',
            ...where,
        });
        return undefined;
    }
    const labels = value.filter(
        (v): v is string => typeof v === 'string' && GROUP_BY_PATTERN.test(v),
    );
    if (labels.length !== value.length) {
        warn({
            code: 'option-dropped',
            message:
                'Some group_by labels are not label names; they are not imported.',
            ...where,
        });
    }
    return [...new Set(labels)];
};

export const convertGrafanaAlerting = (
    input: GrafanaAlertingImportInput,
): GrafanaAlertingImport => {
    const warnings: ImportWarning[] = [];
    const warn: Warn = (w) => warnings.push(w);
    const tf = new TerraformContext(
        [
            ...input.rules,
            input.contactPoints,
            input.policy,
            ...(input.locals ?? []),
            ...(input.folders ? [input.folders] : []),
        ],
        input.datasources,
    );
    const hclOf = (source: TerraformSourceFile) =>
        tf.files.get(source.file) as HclFile;

    // Contact Points first: routes name them by slug.
    const cpHcl = hclOf(input.contactPoints);
    const cpSlugs = new Set<string>();
    const slugByName = new Map<string, string>();
    const contactPoints: ContactPointAsCode[] = [];
    tf.resourcesOf(input.contactPoints.file, 'grafana_contact_point').forEach(
        (block) => {
            const name = asString(
                tf.attribute(block.body, 'name', cpHcl),
            )?.trim();
            const where = { path: `grafana_contact_point.${block.labels[1]}` };
            if (!name) {
                warn({
                    code: 'terraform-unresolved',
                    message: `grafana_contact_point.${block.labels[1]} has no name the importer can read; it is not imported.`,
                    ...where,
                });
                return;
            }
            const slug = uniqueSlug(toSlug(name, 'contact-point'), cpSlugs);
            slugByName.set(name, slug);
            const integrations = convertContactPoint(
                tf,
                cpHcl,
                block,
                name,
                slug,
                warn,
            );
            if (integrations.length === 0) {
                warn({
                    code: 'contact-point-skipped',
                    message: `The contact point "${name}" has no integration the importer can import; it is not imported.`,
                    ...where,
                });
                return;
            }
            contactPoints.push({
                version: 1,
                type: 'contact_point',
                slug,
                name,
                integrations,
            });
        },
    );

    // The notification policy becomes the route tree.
    const policyHcl = hclOf(input.policy);
    const policies = tf.resourcesOf(
        input.policy.file,
        'grafana_notification_policy',
    );
    if (policies.length === 0) {
        throw new GrafanaAlertingImportError(
            `${input.policy.file} defines no resource "grafana_notification_policy". Pass the Terraform file with the notification policy (grafana_notification_policy.tf).`,
        );
    }
    if (policies.length > 1) {
        warn({
            code: 'terraform-unsupported',
            message: `${input.policy.file} defines ${policies.length} notification policies; only the first, grafana_notification_policy.${policies[0].labels[1]}, is imported.`,
        });
    }
    const contactPointSlug = (
        value: HclValue | undefined,
    ): string | undefined => {
        const name = asString(value)?.trim();
        if (!name) return undefined;
        return slugByName.get(name) ?? toSlug(name, 'contact-point');
    };
    const route = (body: HclBody, path: string): NotificationRoute => {
        const where = { path };
        const read = (key: string) => tf.attribute(body, key, policyHcl);
        const matchers: AlertLabelMatcher[] = [];
        getHclBlocks(body, 'matcher').forEach((m) => {
            const label = asString(tf.attribute(m.body, 'label', policyHcl));
            const operator = asString(tf.attribute(m.body, 'match', policyHcl));
            const value = tf.attribute(m.body, 'value', policyHcl);
            if (
                label === undefined ||
                !isAlertLabelMatcherOperator(operator) ||
                (typeof value !== 'string' && typeof value !== 'number')
            ) {
                warn({
                    code: 'option-dropped',
                    message: `A matcher the importer can't read (label ${String(label)}, match ${String(operator)}) is not imported.`,
                    ...where,
                });
                return;
            }
            matchers.push({ label, operator, value: String(value) });
        });
        const contactValue = read('contact_point');
        const contactPoint = contactPointSlug(contactValue);
        if (contactValue !== undefined && contactPoint === undefined) {
            warn({
                code: 'terraform-unresolved',
                message: `The contact point of ${path} can't be resolved${
                    isHclUnknown(contactValue) ? ` (${contactValue.text})` : ''
                }; the route uses its parent's.`,
                ...where,
            });
        }
        const cont = read('continue');
        const groupBy = readGroupBy(read('group_by'), warn, where);
        const groupWait = readDuration(
            read('group_wait'),
            'group_wait',
            warn,
            where,
        );
        const groupInterval = readDuration(
            read('group_interval'),
            'group_interval',
            warn,
            where,
        );
        const repeatInterval = readDuration(
            read('repeat_interval'),
            'repeat_interval',
            warn,
            where,
        );
        const children = getHclBlocks(body, 'policy').map((child, i) =>
            route(child.body, `${path}.policy[${i}]`),
        );
        warnDropped(
            body,
            [
                'matcher',
                'contact_point',
                'continue',
                'group_by',
                'group_wait',
                'group_interval',
                'repeat_interval',
                'policy',
            ],
            warn,
            `The notification policy ${path}`,
            where,
        );
        return {
            ...(matchers.length > 0 ? { matchers } : {}),
            ...(contactPoint !== undefined ? { contactPoint } : {}),
            ...(cont === true ? { continue: true } : {}),
            ...(groupBy !== undefined ? { groupBy } : {}),
            ...(groupWait !== undefined ? { groupWait } : {}),
            ...(groupInterval !== undefined ? { groupInterval } : {}),
            ...(repeatInterval !== undefined ? { repeatInterval } : {}),
            ...(children.length > 0 ? { routes: children } : {}),
        };
    };
    const policy = policies[0];
    const rootPath = `grafana_notification_policy.${policy.labels[1]}`;
    const root = route(policy.body, rootPath);
    if (root.contactPoint === undefined) {
        throw new GrafanaAlertingImportError(
            `${input.policy.file}: the contact_point of ${rootPath} can't be resolved. Pass the contact points file that defines it with --contact-points.`,
        );
    }
    const rootRoute = { ...root };
    delete rootRoute.continue;
    delete rootRoute.matchers;
    if (root.matchers) {
        warn({
            code: 'option-dropped',
            message:
                'The root notification policy has matchers; the default route matches every alert, so they are not imported.',
            path: rootPath,
        });
    }
    const notificationRoutes: NotificationRoutesAsCode = {
        version: 1,
        type: 'notification_routes',
        ...rootRoute,
        contactPoint: root.contactPoint,
    };

    // Rule groups, in file and block order.
    const ruleSlugs = new Set<string>();
    const alertRules: AlertRuleAsCode[] = [];
    input.rules.forEach((source) => {
        const hcl = hclOf(source);
        tf.resourcesOf(source.file, 'grafana_rule_group').forEach((group) => {
            const label = `grafana_rule_group.${group.labels[1]}`;
            const where = { path: label };
            // for_each: one rule group per instance, with `each` bound to it.
            let instances: Record<string, HclValue>[] = [{}];
            const forEach = tf.attribute(group.body, 'for_each', hcl);
            if (forEach !== undefined) {
                const each = forEachInstances(forEach, 'value');
                if (each === undefined) {
                    warn({
                        code: 'terraform-unresolved',
                        message: `The for_each of ${label} can't be evaluated${
                            isHclUnknown(forEach)
                                ? ` (${forEach.text}: ${forEach.reason})`
                                : ': it is not a set or map'
                        }; its rules are not imported.`,
                        ...where,
                    });
                    return;
                }
                instances = each.map((instance) => ({ each: instance }));
            }
            getHclBlocks(group.body, 'dynamic')
                .filter((dynamic) => dynamic.labels[0] !== 'rule')
                .forEach((dynamic) =>
                    warn({
                        code: 'terraform-unsupported',
                        message: `${label} has a dynamic "${dynamic.labels[0] ?? ''}" block, which is not a rule; it is not imported.`,
                        ...where,
                    }),
                );
            instances.forEach((variables) => {
                const groupName =
                    asString(
                        tf.attribute(group.body, 'name', hcl, variables),
                    ) ?? group.labels[1];
                const intervalSeconds = tf.attribute(
                    group.body,
                    'interval_seconds',
                    hcl,
                    variables,
                );
                let interval: string | undefined;
                if (
                    typeof intervalSeconds === 'number' &&
                    Number.isInteger(intervalSeconds) &&
                    intervalSeconds > 0
                ) {
                    interval = secondsToDuration(intervalSeconds);
                } else if (intervalSeconds !== undefined) {
                    warn({
                        code: 'option-dropped',
                        message: `The interval_seconds of the rule group ${groupName} ${
                            isHclUnknown(intervalSeconds)
                                ? `(${intervalSeconds.text})`
                                : JSON.stringify(intervalSeconds)
                        } is not a whole number of seconds the importer can read; its rules use the default interval.`,
                        ...where,
                    });
                }
                tf.blocks(
                    group.body,
                    'rule',
                    hcl,
                    variables,
                    warn,
                    where,
                ).forEach((rule, index) =>
                    alertRules.push(
                        convertRule(
                            tf,
                            hcl,
                            groupName,
                            index,
                            rule,
                            interval,
                            input.datasources,
                            ruleSlugs,
                            warn,
                        ),
                    ),
                );
            });
        });
    });

    return { alertRules, contactPoints, notificationRoutes, warnings };
};

const cell = (text: string | undefined) =>
    (text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** IMPORT-REPORT.md: every warning with its code, the rule or Terraform resource, and the message. */
export const renderGrafanaAlertsImportReport = (
    result: GrafanaAlertingImport,
): string => {
    const lines = [
        '# Import report: Grafana alerting',
        '',
        `${plural(result.alertRules.length, 'alert rule')}, ${plural(
            result.contactPoints.length,
            'contact point',
        )}, ${plural(result.warnings.length, 'warning')}. Every rule is imported in Shadow Run (shadow: true).`,
        '',
        '## Warnings',
        '',
    ];
    if (result.warnings.length === 0) {
        lines.push('No warnings.');
    } else {
        lines.push(
            '| Code | Rule or resource | Message |',
            '| --- | --- | --- |',
        );
        result.warnings.forEach((w) =>
            lines.push(
                `| ${cell(w.code)} | ${cell(w.rule ?? w.path)} | ${cell(w.message)} |`,
            ),
        );
    }
    return `${lines.join('\n')}\n`;
};

/**
 * ROUTING-FIXES.md. Routing defect detection and fixes come with the routing features of the
 * importer; until then the file says that the routes are imported as Grafana has them.
 */
export const renderGrafanaRoutingFixes = (): string =>
    [
        '# Routing fixes',
        '',
        'The notification routes are imported as the Grafana notification policy has them.',
        'This version of the importer does not check them for routing defects yet.',
        '',
    ].join('\n');
