/**
 * ENG-1799 importers: Grafana dashboard variables → Lightdash parameters. Each custom, query,
 * textbox and interval variable becomes a project parameter (lightdash.config.yml `parameters`)
 * and a dashboard parameter set to the variable's current value. The query translator
 * (grafanaQuery.ts) already writes `${ld.parameters.<name>}` for these; constants are inlined
 * there and datasource variables pick the Telemetry Source, so neither becomes a parameter.
 *
 * Pure: no filesystem, no network.
 */
import type {
    LightdashParameterOption,
    LightdashProjectParameter,
} from '../types/lightdashProjectConfig';
import type { DashboardParameters } from '../types/parameters';
import {
    PARAMETER_VARIABLE_TYPES,
    type GrafanaTemplatingVariable,
} from './grafanaQuery';
import type { ImportWarning } from './importWarnings';

/** Parameter names lightdash.config.yml accepts. */
const PARAMETER_NAME = /^[a-zA-Z0-9_-]+$/;

/** Grafana's "All" value and an interval variable's auto option. */
const isSpecialValue = (value: string): boolean =>
    value === '$__all' || value.startsWith('$__auto_interval_');

const asText = (value: unknown): string | undefined =>
    typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : undefined;

const nonBlank = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

type Option = { label: string; value: string };

/** A saved `options` list, without All and auto. */
const savedOptions = (variable: GrafanaTemplatingVariable): Option[] =>
    (Array.isArray(variable.options) ? variable.options : []).flatMap(
        (option: unknown) => {
            if (typeof option !== 'object' || option === null) return [];
            const { text, value } = option as {
                text?: unknown;
                value?: unknown;
            };
            const v = asText(value) ?? asText(text);
            if (v === undefined || isSpecialValue(v)) return [];
            return [{ label: asText(text) ?? v, value: v }];
        },
    );

/**
 * A custom or interval variable's `query`: values split on commas (`\,` escapes one); a
 * custom value written `text : value` keeps both.
 */
const queryOptions = (variable: GrafanaTemplatingVariable): Option[] => {
    if (typeof variable.query !== 'string') return [];
    return variable.query
        .split(/(?<!\\),/)
        .map((part) => part.replace(/\\,/g, ',').trim())
        .filter((part) => part !== '')
        .map((part) => {
            const pair =
                variable.type === 'custom'
                    ? /^(.*\S)\s+:\s+(\S.*)$/.exec(part)
                    : null;
            return pair
                ? { label: pair[1], value: pair[2] }
                : { label: part, value: part };
        });
};

const uniqueOptions = (options: Option[]): Option[] =>
    options.filter(
        (option, i) => options.findIndex((o) => o.value === option.value) === i,
    );

/** Plain values when every label is its value, else label+value pairs. */
const configOptions = (
    options: Option[],
): string[] | LightdashParameterOption[] =>
    options.every((o) => o.label === o.value)
        ? options.map((o) => o.value)
        : options.map((o) => ({ label: o.label, value: o.value }));

/** The options a chart viewer picks from: saved options, else the variable's query. */
const variableOptions = (variable: GrafanaTemplatingVariable): Option[] => {
    if (variable.type !== 'custom' && variable.type !== 'interval') return [];
    const saved = savedOptions(variable);
    return uniqueOptions(saved.length > 0 ? saved : queryOptions(variable));
};

/** The current value as one string, or undefined for none, All or auto. */
const currentValue = (
    variable: GrafanaTemplatingVariable,
): { value?: string; special?: string } => {
    const raw = variable.current?.value ?? variable.current?.text;
    const values = (Array.isArray(raw) ? raw : [raw])
        .map(asText)
        .filter((v): v is string => v !== undefined);
    const special = values.find(isSpecialValue);
    if (special !== undefined) return { special };
    return { value: values[0] };
};

/**
 * The value a parameter starts at when Grafana's is All or auto, which have no single
 * Lightdash value: All becomes the variable's custom all value, else `.*` (Grafana's All matches
 * every value, as a regex); auto becomes the first interval option.
 */
const specialDefault = (
    variable: GrafanaTemplatingVariable,
    special: string,
    options: Option[],
): string | undefined => {
    if (special === '$__all') {
        return nonBlank(variable.allValue) ?? '.*';
    }
    return options[0]?.value;
};

export type GrafanaVariableParameters = {
    /** Project parameters (lightdash.config.yml), keyed by name. */
    parameters: Record<string, LightdashProjectParameter>;
    /** The dashboard's parameter values: each variable's current value. */
    dashboardParameters: DashboardParameters;
    warnings: ImportWarning[];
};

/**
 * Each custom, query, textbox and interval variable as a project parameter and a dashboard
 * parameter value. Query and textbox variables accept any value (their options come from a
 * datasource or the viewer); custom and interval variables list their options.
 */
export const grafanaVariableParameters = (
    variables: GrafanaTemplatingVariable[],
): GrafanaVariableParameters => {
    const parameters: Record<string, LightdashProjectParameter> = {};
    const dashboardParameters: DashboardParameters = {};
    const warnings: ImportWarning[] = [];
    variables.forEach((variable) => {
        if (!PARAMETER_VARIABLE_TYPES.has(variable.type)) return;
        const { name } = variable;
        if (typeof name !== 'string' || !PARAMETER_NAME.test(name)) {
            warnings.push({
                code: 'variable-unsupported',
                message: `The ${variable.type} variable "${String(name)}" has a name Lightdash parameters do not accept (letters, digits, _ and - only); it is not imported`,
            });
            return;
        }
        if (parameters[name] !== undefined) return;
        const options = variableOptions(variable);
        const parameter: LightdashProjectParameter = {
            label: nonBlank(variable.label) ?? name,
            ...(nonBlank(variable.description) === undefined
                ? {}
                : { description: nonBlank(variable.description) }),
            ...(options.length > 0
                ? { options: configOptions(options) }
                : { allow_custom_values: true }),
        };
        const { value, special } = currentValue(variable);
        const start =
            special === undefined
                ? value
                : specialDefault(variable, special, options);
        if (special !== undefined && start !== undefined) {
            warnings.push({
                code: 'parameter-default-adjusted',
                message: `The variable ${name} is set to ${
                    special === '$__all' ? 'All' : 'auto'
                } in Grafana, which has no single Lightdash value; the parameter ${name} starts at "${start}"`,
            });
        }
        if (start !== undefined && start !== '') {
            parameter.default = start;
        }
        parameters[name] = parameter;
        if (start !== undefined) {
            dashboardParameters[name] = { parameterName: name, value: start };
        }
    });
    return { parameters, dashboardParameters, warnings };
};

const optionValue = (option: string | number | LightdashParameterOption) =>
    typeof option === 'object' ? String(option.value) : String(option);

/**
 * The project parameters of several dashboards, merged by name for one lightdash.config.yml.
 * The first definition keeps its label, description and default; options from later ones are
 * added. A name that accepts any value in one dashboard accepts any value. Each difference is
 * a `parameter-merged` warning naming the dashboards, with the index of the source that
 * differed so the caller can add it to that dashboard's warnings.
 */
export const mergeProjectParameters = (
    sources: Array<{
        dashboard: string;
        parameters: Record<string, LightdashProjectParameter>;
    }>,
): {
    parameters: Record<string, LightdashProjectParameter>;
    warnings: Array<{ index: number; warning: ImportWarning }>;
} => {
    const merged: Record<string, LightdashProjectParameter> = {};
    const firstDashboard: Record<string, string> = {};
    const warnings: Array<{ index: number; warning: ImportWarning }> = [];
    sources.forEach(({ dashboard, parameters }, index) => {
        Object.entries(parameters).forEach(([name, parameter]) => {
            const existing = merged[name];
            if (existing === undefined) {
                merged[name] = parameter;
                firstDashboard[name] = dashboard;
                return;
            }
            const existingOptions = (existing.options ?? []) as Array<
                string | number | LightdashParameterOption
            >;
            const newOptions = (
                (parameter.options ?? []) as Array<
                    string | number | LightdashParameterOption
                >
            ).filter(
                (option) =>
                    !existingOptions.some(
                        (o) => optionValue(o) === optionValue(option),
                    ),
            );
            const allOptions = [...existingOptions, ...newOptions];
            const anyValue =
                existing.allow_custom_values === true ||
                parameter.allow_custom_values === true;
            const differs =
                newOptions.length > 0 ||
                existing.allow_custom_values !==
                    parameter.allow_custom_values ||
                existing.label !== parameter.label;
            const next: LightdashProjectParameter = {
                label: existing.label,
                ...(existing.description === undefined
                    ? {}
                    : { description: existing.description }),
                ...(allOptions.length > 0
                    ? {
                          options: allOptions.every(
                              (o) => typeof o !== 'object',
                          )
                              ? allOptions.map(optionValue)
                              : allOptions.map((o) =>
                                    typeof o === 'object'
                                        ? o
                                        : { label: String(o), value: o },
                                ),
                      }
                    : {}),
                ...(anyValue ? { allow_custom_values: true } : {}),
                ...(existing.default === undefined
                    ? {}
                    : { default: existing.default }),
            };
            merged[name] = next;
            if (differs) {
                warnings.push({
                    index,
                    warning: {
                        code: 'parameter-merged',
                        message: `The dashboards ${firstDashboard[name]} and ${dashboard} both define the variable ${name} differently; lightdash.config.yml has one parameter ${name} with the label "${next.label}"${
                            anyValue
                                ? ' that accepts any value'
                                : ' and the options of both'
                        }`,
                        dashboard,
                    },
                });
            }
        });
    });
    return { parameters: merged, warnings };
};
