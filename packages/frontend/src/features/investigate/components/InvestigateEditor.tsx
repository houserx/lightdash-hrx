import {
    buildPlatformQuerySql,
    buildTelemetrySql,
    type TelemetryQuery,
} from '@lightdash/common';
import {
    Button,
    Checkbox,
    SegmentedControl,
    Stack,
    Textarea,
    TextInput,
} from '@mantine/core';
import { IconTable } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import MantineIcon from '../../../components/common/MantineIcon';
import {
    DEFAULT_CLOUDWATCH_FORM,
    metricDataQueryJsonFromForm,
    parseMetricDataQuery,
    splitLogGroups,
    type CloudWatchFormValues,
} from '../utils/cloudWatchForm';
import {
    CloudWatchLogsEditor,
    CloudWatchMetricsEditor,
} from './CloudWatchEditors';
import {
    PlatformSchemaBrowser,
    type PlatformSchemaLoaders,
} from './PlatformSchemaBrowser';

/** The source languages Investigate offers (CONTRACTS §1.1). */
export type InvestigateSource =
    | 'prometheus'
    | 'loki'
    | 'cloudwatch'
    | 'cloudwatch_logs'
    | 'tempo'
    | 'platform';

const SOURCE_OPTIONS: { value: InvestigateSource; label: string }[] = [
    { value: 'prometheus', label: 'Prometheus' },
    { value: 'loki', label: 'Loki' },
    { value: 'cloudwatch', label: 'CloudWatch metrics' },
    { value: 'cloudwatch_logs', label: 'CloudWatch Logs' },
    { value: 'tempo', label: 'Tempo' },
    { value: 'platform', label: 'Platform Database' },
];

/** What the editor reports: the query kind and the SQL that runs. */
export type InvestigateEditorChange =
    | { kind: TelemetryQuery['kind']; sql: string }
    | { kind: 'platform'; sql: string; statement: string };

type Props = {
    onChange: (change: InvestigateEditorChange) => void;
    /** Called when the user picks another source; the editor starts on Prometheus. */
    onSourceChange?: (source: InvestigateSource) => void;
    /** Called with the Platform SQL statement whenever it changes, including to empty. */
    onPlatformSqlChange?: (statement: string) => void;
    /** SQL to show in the SQL box before anything is generated, e.g. a query being reopened. */
    initialSql?: string;
    /** Reads the Platform Database catalog; the schema browser is offered only with it. */
    platformSchema?: PlatformSchemaLoaders;
};

const kindOfSource = (
    source: InvestigateSource,
    isLogqlMetric: boolean,
): InvestigateEditorChange['kind'] => {
    switch (source) {
        case 'prometheus':
            return 'promql';
        case 'loki':
            return isLogqlMetric ? 'logql_metric' : 'logql';
        case 'tempo':
            return 'traceql';
        case 'cloudwatch':
        case 'cloudwatch_logs':
        case 'platform':
            return source;
        default: {
            const unknownSource: never = source;
            throw new Error(`Unknown Investigate source: ${unknownSource}`);
        }
    }
};

/**
 * Investigate's query editor: a source picker, the editor for the picked source's language,
 * and the SQL box with the table-function SQL generated from it (CONTRACTS §1.1). Telemetry
 * SQL uses the reserved time parameters, so it follows the chosen time range.
 *
 * The SQL box is editable and its text is what runs: a manual edit is reported through
 * onChange and kept until the user changes the source query, which regenerates the SQL.
 */
export const InvestigateEditor: FC<Props> = ({
    onChange,
    onSourceChange,
    onPlatformSqlChange,
    initialSql,
    platformSchema,
}) => {
    const [source, setSource] = useState<InvestigateSource>('prometheus');
    const [promql, setPromql] = useState('');
    const [logql, setLogql] = useState('');
    const [isLogqlMetric, setIsLogqlMetric] = useState(false);
    const [traceql, setTraceql] = useState('');
    const [platformSql, setPlatformSqlState] = useState('');
    const setPlatformSql = (statement: string) => {
        setPlatformSqlState(statement);
        onPlatformSqlChange?.(statement);
    };
    const [isSchemaBrowserOpen, setIsSchemaBrowserOpen] = useState(false);
    const platformSqlInput = useRef<HTMLTextAreaElement>(null);
    const [cloudWatchForm, setCloudWatchForm] = useState<CloudWatchFormValues>(
        DEFAULT_CLOUDWATCH_FORM,
    );
    const [metricDataQueryJson, setMetricDataQueryJson] = useState('');
    const [logGroups, setLogGroups] = useState('');
    const [logsInsightsQuery, setLogsInsightsQuery] = useState('');
    const [sourceName, setSourceName] = useState('');
    const [sql, setSql] = useState(initialSql ?? '');

    // The form writes the JSON whenever it describes a complete metric stat; a hand edit of
    // the JSON stays until the form is changed again.
    const handleCloudWatchFormChange = (form: CloudWatchFormValues) => {
        setCloudWatchForm(form);
        const json = metricDataQueryJsonFromForm(form);
        if (json !== undefined) setMetricDataQueryJson(json);
    };

    const parsedMetricDataQuery = useMemo(
        () =>
            metricDataQueryJson.trim() === ''
                ? undefined
                : parseMetricDataQuery(metricDataQueryJson),
        [metricDataQueryJson],
    );

    const change = useMemo((): InvestigateEditorChange | undefined => {
        const engineSource = sourceName.trim() || undefined;
        const telemetry = (query: TelemetryQuery): InvestigateEditorChange => ({
            kind: query.kind,
            sql: buildTelemetrySql(query),
        });
        switch (source) {
            case 'prometheus':
                return promql.trim() === ''
                    ? undefined
                    : telemetry({
                          kind: 'promql',
                          query: promql,
                          source: engineSource,
                      });
            case 'loki':
                return logql.trim() === ''
                    ? undefined
                    : telemetry({
                          kind: isLogqlMetric ? 'logql_metric' : 'logql',
                          query: logql,
                          source: engineSource,
                      });
            case 'tempo':
                return traceql.trim() === ''
                    ? undefined
                    : telemetry({
                          kind: 'traceql',
                          query: traceql,
                          source: engineSource,
                      });
            case 'platform':
                return platformSql.trim() === ''
                    ? undefined
                    : {
                          kind: 'platform',
                          statement: platformSql,
                          sql: buildPlatformQuerySql(platformSql),
                      };
            case 'cloudwatch':
                return parsedMetricDataQuery && 'query' in parsedMetricDataQuery
                    ? telemetry({
                          kind: 'cloudwatch',
                          metricDataQuery: parsedMetricDataQuery.query,
                          source: engineSource,
                      })
                    : undefined;
            case 'cloudwatch_logs': {
                const groups = splitLogGroups(logGroups);
                return groups.length === 0 ||
                    groups.some((name) => name.includes(',')) ||
                    logsInsightsQuery.trim() === ''
                    ? undefined
                    : telemetry({
                          kind: 'cloudwatch_logs',
                          logGroups: groups,
                          query: logsInsightsQuery,
                          source: engineSource,
                      });
            }
            default: {
                const unknownSource: never = source;
                throw new Error(`Unknown Investigate source: ${unknownSource}`);
            }
        }
    }, [
        source,
        promql,
        logql,
        isLogqlMetric,
        traceql,
        platformSql,
        parsedMetricDataQuery,
        logGroups,
        logsInsightsQuery,
        sourceName,
    ]);

    // Show and report each newly generated SQL once; the parent's callback identity does
    // not matter. A manual edit stays until the generated SQL changes again.
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const lastGeneratedSql = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!change || change.sql === lastGeneratedSql.current) return;
        lastGeneratedSql.current = change.sql;
        setSql(change.sql);
        onChangeRef.current(change);
    }, [change]);

    // A column picked in the schema browser replaces the selection in the Platform SQL box, or
    // goes at its end when the box has never been focused.
    const insertIntoPlatformSql = (text: string) => {
        const input = platformSqlInput.current;
        const start = input?.selectionStart ?? platformSql.length;
        const end = input?.selectionEnd ?? platformSql.length;
        setPlatformSql(
            platformSql.slice(0, start) + text + platformSql.slice(end),
        );
        requestAnimationFrame(() => {
            input?.focus();
            input?.setSelectionRange(start + text.length, start + text.length);
        });
    };

    const handleSqlEdit = (editedSql: string) => {
        setSql(editedSql);
        const kind = kindOfSource(source, isLogqlMetric);
        onChangeRef.current(
            kind === 'platform'
                ? { kind, sql: editedSql, statement: platformSql }
                : { kind, sql: editedSql },
        );
    };

    return (
        <Stack gap="sm">
            <SegmentedControl
                aria-label="Source"
                data={SOURCE_OPTIONS}
                value={source}
                onChange={(value) => {
                    setSource(value as InvestigateSource);
                    onSourceChange?.(value as InvestigateSource);
                }}
            />
            {source === 'prometheus' && (
                <Textarea
                    label="PromQL"
                    autosize
                    minRows={2}
                    value={promql}
                    onChange={(event) => setPromql(event.currentTarget.value)}
                />
            )}
            {source === 'loki' && (
                <>
                    <Textarea
                        label="LogQL"
                        autosize
                        minRows={2}
                        value={logql}
                        onChange={(event) =>
                            setLogql(event.currentTarget.value)
                        }
                    />
                    <Checkbox
                        label="Metric query"
                        checked={isLogqlMetric}
                        onChange={(event) =>
                            setIsLogqlMetric(event.currentTarget.checked)
                        }
                    />
                </>
            )}
            {source === 'tempo' && (
                <Textarea
                    label="TraceQL"
                    autosize
                    minRows={2}
                    value={traceql}
                    onChange={(event) => setTraceql(event.currentTarget.value)}
                />
            )}
            {source === 'platform' && (
                <>
                    <Textarea
                        ref={platformSqlInput}
                        label="Platform SQL"
                        autosize
                        minRows={4}
                        value={platformSql}
                        onChange={(event) =>
                            setPlatformSql(event.currentTarget.value)
                        }
                    />
                    {platformSchema && (
                        <Button
                            size="xs"
                            variant="subtle"
                            w="fit-content"
                            leftSection={<MantineIcon icon={IconTable} />}
                            aria-expanded={isSchemaBrowserOpen}
                            onClick={() =>
                                setIsSchemaBrowserOpen((isOpen) => !isOpen)
                            }
                        >
                            {isSchemaBrowserOpen
                                ? 'Hide tables'
                                : 'Browse tables'}
                        </Button>
                    )}
                    {platformSchema && isSchemaBrowserOpen && (
                        <PlatformSchemaBrowser
                            loadTables={platformSchema.loadTables}
                            loadColumns={platformSchema.loadColumns}
                            onInsert={insertIntoPlatformSql}
                        />
                    )}
                </>
            )}
            {source === 'cloudwatch' && (
                <CloudWatchMetricsEditor
                    form={cloudWatchForm}
                    onFormChange={handleCloudWatchFormChange}
                    json={metricDataQueryJson}
                    jsonError={
                        parsedMetricDataQuery &&
                        'error' in parsedMetricDataQuery
                            ? parsedMetricDataQuery.error
                            : undefined
                    }
                    onJsonChange={setMetricDataQueryJson}
                />
            )}
            {source === 'cloudwatch_logs' && (
                <CloudWatchLogsEditor
                    logGroups={logGroups}
                    onLogGroupsChange={setLogGroups}
                    query={logsInsightsQuery}
                    onQueryChange={setLogsInsightsQuery}
                />
            )}
            {source !== 'platform' && (
                <TextInput
                    label="Source name"
                    description="Optional. Leave empty to use the default source."
                    value={sourceName}
                    onChange={(event) =>
                        setSourceName(event.currentTarget.value)
                    }
                />
            )}
            <Textarea
                label="SQL"
                autosize
                minRows={3}
                value={sql}
                onChange={(event) => handleSqlEdit(event.currentTarget.value)}
            />
        </Stack>
    );
};
