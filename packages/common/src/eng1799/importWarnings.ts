/**
 * ENG-1799 importers: the structured warning every unsupported Grafana or Perses construct
 * becomes. Nothing is dropped silently: each warning lands in the import report and summary.
 */

/** Warning codes the importers emit. Lower-case and dashed; add new codes here. */
export type ImportWarningCode =
    | 'datasource-unsupported'
    | 'datasource-unresolved'
    | 'query-empty'
    | 'panel-targets-not-combined'
    | 'query-instant-dropped'
    | 'query-limit-invalid'
    | 'query-direction-unsupported'
    | 'query-cloudwatch-unsupported'
    | 'query-cloudwatch-math-unsupported'
    | 'query-cloudwatch-math-periods'
    | 'query-region-unsupported'
    | 'query-period-auto'
    | 'query-period-invalid'
    | 'query-statistic-missing'
    | 'query-statistics-dropped'
    | 'query-dimension-wildcard'
    | 'query-dimension-values-dropped'
    | 'query-match-exact-dropped'
    | 'query-macro-unsupported'
    | 'no-ops-mart'
    | 'ops-mart-invalid'
    | 'ops-mart-filters-dropped'
    | 'expression-unsupported'
    | 'expression-hysteresis-dropped'
    | 'variable-undefined'
    | 'variable-unsupported'
    | 'variable-multi-value'
    | 'variable-format-ignored'
    | 'parameter-default-adjusted'
    | 'parameter-merged'
    | 'panel-type-unsupported'
    | 'panel-dropped'
    | 'option-dropped'
    | 'chart-kind-fallback'
    | 'unit-unsupported'
    | 'thresholds-unsupported'
    | 'legend-unsupported'
    | 'stacking-unsupported'
    | 'link-unsupported'
    | 'dashboard-link-unsupported'
    | 'annotations-unsupported'
    | 'transformation-unsupported'
    | 'time-range-adjusted'
    | 'time-range-unsupported'
    | 'refresh-adjusted'
    | 'refresh-unsupported'
    | 'terraform-unsupported'
    | 'terraform-unresolved'
    | 'label-invalid'
    | 'rule-needs-review'
    | 'rule-description-generated'
    | 'rule-null-handling-changed'
    | 'rule-state-changed'
    | 'contact-point-integration-unsupported'
    | 'contact-point-skipped'
    | (string & {});

export type ImportWarning = {
    code: ImportWarningCode;
    message: string;
    dashboard?: string;
    panel?: string;
    rule?: string;
    path?: string;
};
