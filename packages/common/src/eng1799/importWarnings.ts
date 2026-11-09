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
    | (string & {});

export type ImportWarning = {
    code: ImportWarningCode;
    message: string;
    dashboard?: string;
    panel?: string;
    rule?: string;
    path?: string;
};
