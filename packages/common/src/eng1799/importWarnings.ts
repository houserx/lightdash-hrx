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
    | 'query-region-unsupported'
    | 'query-period-auto'
    | 'query-period-invalid'
    | 'query-statistic-missing'
    | 'query-statistics-dropped'
    | 'query-dimension-wildcard'
    | 'query-dimension-values-dropped'
    | 'query-match-exact-dropped'
    | 'query-macro-unsupported'
    | 'variable-undefined'
    | 'variable-unsupported'
    | 'variable-multi-value'
    | 'variable-format-ignored'
    | (string & {});

export type ImportWarning = {
    code: ImportWarningCode;
    message: string;
    dashboard?: string;
    panel?: string;
    rule?: string;
    path?: string;
};
