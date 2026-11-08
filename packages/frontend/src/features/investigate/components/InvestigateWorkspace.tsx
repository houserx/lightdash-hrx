import {
    buildPlatformExplainSql,
    formatExplainPlanAsText,
    isAuditDescriptionRequiredError,
    isAuditedSql,
    type ExplainPlanInput,
    type FederationAttrs,
    type QueryAudit,
    type QueryTimeRange,
    type TimeRangeInput,
} from '@lightdash/common';
import {
    Alert,
    Button,
    Group,
    Loader,
    Modal,
    Stack,
    Text,
    TextInput,
} from '@mantine/core';
import {
    IconAlertCircle,
    IconDeviceFloppy,
    IconListTree,
    IconPlayerPlay,
} from '@tabler/icons-react';
import { useRef, useState, type FC } from 'react';
import MantineIcon from '../../../components/common/MantineIcon';
import { TimeRangePicker } from '../../timeRange/components/TimeRangePicker';
import { getTimeRangeLabel } from '../../timeRange/utils';
import { type InvestigateRow } from '../utils/timeSeries';
import { ExplainPlan } from './ExplainPlan';
import {
    InvestigateEditor,
    type InvestigateEditorChange,
    type InvestigateSource,
} from './InvestigateEditor';
import { InvestigateResults } from './InvestigateResults';
import { type PlatformSchemaLoaders } from './PlatformSchemaBrowser';

/** Investigate opens over the last 6 hours unless the caller says otherwise. */
const DEFAULT_INVESTIGATE_TIME_RANGE: TimeRangeInput = {
    from: 'now-6h',
    to: 'now',
};

/** One Investigate run: the SQL as shown, and the range that resolves its time parameters. */
export type InvestigateRunRequest = {
    sql: string;
    timeRange: QueryTimeRange;
    /** Present only for an Audited Query (SQL touching the Platform Database). */
    audit?: QueryAudit;
};

export type InvestigateQueryResult = {
    columns: string[];
    rows: InvestigateRow[];
};

export type InvestigateWorkspaceProps = {
    runQuery: (
        request: InvestigateRunRequest,
    ) => Promise<InvestigateQueryResult>;
    /** The range the time range control starts from. */
    initialTimeRange?: TimeRangeInput;
    /** Saves the SQL in the SQL box as a SQL chart; Save as chart is hidden without it. */
    onSaveAsChart?: (chart: InvestigateSaveAsChartRequest) => Promise<void>;
    /** Reads the Platform Database catalog for the schema browser; hidden without it. */
    platformSchema?: PlatformSchemaLoaders;
    /**
     * The user's ldq claims. On the Platform Database, Run needs platform_read and Explain
     * needs platform_read or platform_explain. Without it both are offered and the engine
     * decides. The engine enforces every claim either way.
     */
    access?: FederationAttrs;
};

/** What Save as chart sends: the chart's name and the SQL exactly as shown in the SQL box. */
export type InvestigateSaveAsChartRequest = {
    name: string;
    sql: string;
};

type RunState =
    | { status: 'idle' }
    | { status: 'running'; action: RunAction; timeRange: TimeRangeInput }
    | {
          status: 'done';
          timeRange: TimeRangeInput;
          result: InvestigateQueryResult;
      }
    | { status: 'explained'; plan: ExplainPlanInput; text: string }
    | {
          status: 'failed';
          action: RunAction;
          timeRange: TimeRangeInput;
          error: string;
      }
    | { status: 'description-required'; timeRange: TimeRangeInput };

type RunAction = 'run' | 'explain';

/**
 * The plan from a platform_explain result: the `plan` cell of its first row, which may arrive
 * as JSON text. Its shape is checked when it is formatted as text.
 */
const planFromExplainResult = (
    result: InvestigateQueryResult,
): ExplainPlanInput => {
    const cell = result.rows[0]?.plan;
    if (cell === undefined || cell === null) {
        throw new Error('The explain returned no plan');
    }
    if (typeof cell !== 'string') return cell as ExplainPlanInput;
    try {
        return JSON.parse(cell) as ExplainPlanInput;
    } catch {
        throw new Error('Not a Postgres JSON explain plan');
    }
};

const errorMessage = (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback;

/**
 * Investigate: the query editor, one time range control and the result. Every run sends the
 * SQL in the SQL box with the range shown in the control; the result is labelled with the range
 * it was run over, so a later change to the control does not misdescribe it. SQL that touches
 * the Platform Database is an Audited Query: Run waits for a Description, a Linear ticket is
 * optional, and both are sent with the run. The engine can also ask for a description for SQL
 * the client cannot recognise as audited (a Restricted Telemetry source); the same fields are
 * then shown for that SQL and the rerun sends them.
 *
 * On the Platform Database, Explain runs an estimate-only platform_explain of the Platform SQL
 * (also an Audited Query) and shows the plan as text with JSON and text downloads. Users with
 * platform_explain but not platform_read get Explain without Run.
 */
export const InvestigateWorkspace: FC<InvestigateWorkspaceProps> = ({
    runQuery,
    initialTimeRange = DEFAULT_INVESTIGATE_TIME_RANGE,
    onSaveAsChart,
    platformSchema,
    access,
}) => {
    const [source, setSource] = useState<InvestigateSource>('prometheus');
    const [platformStatement, setPlatformStatement] = useState('');
    const [timeRange, setTimeRange] =
        useState<TimeRangeInput>(initialTimeRange);
    const [sql, setSql] = useState('');
    const [auditDescription, setAuditDescription] = useState('');
    const [auditTicket, setAuditTicket] = useState('');
    const [run, setRun] = useState<RunState>({ status: 'idle' });
    // The SQL the engine refused for lack of an Audited Query description, if any.
    const [descriptionRequiredForSql, setDescriptionRequiredForSql] = useState<
        string | null
    >(null);
    // The SQL being saved while the Save as chart dialog is open.
    const [saveAsChartSql, setSaveAsChartSql] = useState<string | null>(null);
    // Only the latest run may set the result; an earlier one finishing late is dropped.
    const latestRun = useRef(0);

    const handleEditorChange = (change: InvestigateEditorChange) =>
        setSql(change.sql);

    const isPlatformSource = source === 'platform';
    const canRun = !isPlatformSource || !access || access.platform_read;
    const canExplain =
        isPlatformSource &&
        (!access || access.platform_read || access.platform_explain);

    // Platform Database SQL is an Audited Query: the engine refuses it without a description.
    // The engine's own request counts for exactly the SQL it refused.
    const isAudited = isAuditedSql(sql) || descriptionRequiredForSql === sql;
    // Explain is always an Audited Query: for a user who can only Explain the fields always
    // show; for others they follow the SQL box, and Explain waits for them like Run does.
    const showAuditFields = isAudited || (canExplain && !canRun);
    const description = auditDescription.trim();
    const ticket = auditTicket.trim();
    const auditFields: QueryAudit = { description, ...(ticket && { ticket }) };
    const audit: QueryAudit | undefined = isAudited ? auditFields : undefined;

    const handleRun = async () => {
        latestRun.current += 1;
        const runId = latestRun.current;
        const runTimeRange = { from: timeRange.from, to: timeRange.to };
        setRun({ status: 'running', action: 'run', timeRange: runTimeRange });
        try {
            const result = await runQuery({
                sql,
                timeRange: runTimeRange,
                ...(audit && { audit }),
            });
            if (runId !== latestRun.current) return;
            setRun({ status: 'done', timeRange: runTimeRange, result });
        } catch (error) {
            if (runId !== latestRun.current) return;
            const message = errorMessage(error, 'The query failed');
            if (!audit && isAuditDescriptionRequiredError(message)) {
                setDescriptionRequiredForSql(sql);
                setRun({
                    status: 'description-required',
                    timeRange: runTimeRange,
                });
                return;
            }
            setRun({
                status: 'failed',
                action: 'run',
                timeRange: runTimeRange,
                error: message,
            });
        }
    };

    const handleExplain = async () => {
        latestRun.current += 1;
        const runId = latestRun.current;
        const runTimeRange = { from: timeRange.from, to: timeRange.to };
        setRun({
            status: 'running',
            action: 'explain',
            timeRange: runTimeRange,
        });
        try {
            const result = await runQuery({
                sql: buildPlatformExplainSql(platformStatement),
                timeRange: runTimeRange,
                audit: auditFields,
            });
            const plan = planFromExplainResult(result);
            const text = formatExplainPlanAsText(plan);
            if (runId !== latestRun.current) return;
            setRun({ status: 'explained', plan, text });
        } catch (error) {
            if (runId !== latestRun.current) return;
            setRun({
                status: 'failed',
                action: 'explain',
                timeRange: runTimeRange,
                error: errorMessage(error, 'The explain failed'),
            });
        }
    };

    return (
        <Stack gap="md">
            <Group justify="space-between">
                <TimeRangePicker value={timeRange} onChange={setTimeRange} />
                <Group gap="xs">
                    {onSaveAsChart && (
                        <Button
                            size="xs"
                            variant="default"
                            leftSection={
                                <MantineIcon icon={IconDeviceFloppy} />
                            }
                            disabled={sql.trim() === ''}
                            onClick={() => setSaveAsChartSql(sql)}
                        >
                            Save as chart
                        </Button>
                    )}
                    {canExplain && (
                        <Button
                            size="xs"
                            variant={canRun ? 'default' : 'filled'}
                            leftSection={<MantineIcon icon={IconListTree} />}
                            disabled={
                                platformStatement.trim() === '' ||
                                !showAuditFields ||
                                description === '' ||
                                run.status === 'running'
                            }
                            onClick={handleExplain}
                        >
                            Explain
                        </Button>
                    )}
                    {canRun && (
                        <Button
                            size="xs"
                            leftSection={<MantineIcon icon={IconPlayerPlay} />}
                            disabled={
                                sql.trim() === '' ||
                                (isAudited && description === '') ||
                                run.status === 'running'
                            }
                            onClick={handleRun}
                        >
                            Run
                        </Button>
                    )}
                </Group>
            </Group>
            <InvestigateEditor
                onChange={handleEditorChange}
                onSourceChange={setSource}
                onPlatformSqlChange={setPlatformStatement}
                platformSchema={platformSchema}
            />
            {showAuditFields && (
                <Group align="flex-start" grow>
                    <TextInput
                        label="Description"
                        description="Why you are running this Audited Query; it is recorded in the audit log."
                        required
                        value={auditDescription}
                        onChange={(event) =>
                            setAuditDescription(event.currentTarget.value)
                        }
                    />
                    <TextInput
                        label="Linear ticket"
                        description="Optional, e.g. ENG-123."
                        placeholder="ENG-123"
                        value={auditTicket}
                        onChange={(event) =>
                            setAuditTicket(event.currentTarget.value)
                        }
                    />
                </Group>
            )}
            {onSaveAsChart && (
                <SaveAsChartModal
                    sql={saveAsChartSql}
                    onClose={() => setSaveAsChartSql(null)}
                    onSave={onSaveAsChart}
                />
            )}
            {run.status !== 'idle' && (
                <Stack gap="xs" data-testid="investigate-result">
                    {'timeRange' in run &&
                        !('action' in run && run.action === 'explain') && (
                            <Text size="xs" c="dimmed">
                                Results over {getTimeRangeLabel(run.timeRange)}
                            </Text>
                        )}
                    {run.status === 'running' && <Loader size="sm" />}
                    {run.status === 'failed' && (
                        <Alert
                            color="red"
                            icon={<MantineIcon icon={IconAlertCircle} />}
                            title={
                                run.action === 'explain'
                                    ? 'Explain failed'
                                    : 'Query failed'
                            }
                        >
                            {run.error}
                        </Alert>
                    )}
                    {run.status === 'description-required' && (
                        <Alert
                            color="yellow"
                            icon={<MantineIcon icon={IconAlertCircle} />}
                            title="Audited Query"
                        >
                            This is an Audited Query. Add a description and run
                            it again.
                        </Alert>
                    )}
                    {run.status === 'explained' && (
                        <ExplainPlan plan={run.plan} text={run.text} />
                    )}
                    {run.status === 'done' && (
                        <InvestigateResults
                            columns={run.result.columns}
                            rows={run.result.rows}
                        />
                    )}
                </Stack>
            )}
        </Stack>
    );
};

type SaveAsChartModalProps = {
    /** The SQL to save; the dialog is open while it is set. */
    sql: string | null;
    onClose: () => void;
    onSave: (chart: InvestigateSaveAsChartRequest) => Promise<void>;
};

/** Asks for the chart's name and saves the SQL taken when the dialog opened. */
const SaveAsChartModal: FC<SaveAsChartModalProps> = ({
    sql,
    onClose,
    onSave,
}) => {
    const [name, setName] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const close = () => {
        if (isSaving) return;
        setName('');
        setError(null);
        onClose();
    };

    const handleSave = async () => {
        if (sql === null || name.trim() === '') return;
        setIsSaving(true);
        setError(null);
        try {
            await onSave({ name: name.trim(), sql });
            setIsSaving(false);
            setName('');
            onClose();
        } catch (saveError) {
            setIsSaving(false);
            setError(
                saveError instanceof Error && saveError.message
                    ? saveError.message
                    : 'The chart could not be saved',
            );
        }
    };

    return (
        <Modal opened={sql !== null} onClose={close} title="Save as chart">
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void handleSave();
                }}
            >
                <Stack gap="sm">
                    <TextInput
                        label="Chart name"
                        data-autofocus
                        value={name}
                        onChange={(event) => setName(event.currentTarget.value)}
                    />
                    {error && (
                        <Alert
                            color="red"
                            icon={<MantineIcon icon={IconAlertCircle} />}
                            title="Could not save the chart"
                        >
                            {error}
                        </Alert>
                    )}
                    <Group justify="flex-end" gap="xs">
                        <Button
                            variant="default"
                            onClick={close}
                            disabled={isSaving}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            loading={isSaving}
                            disabled={name.trim() === ''}
                        >
                            Save
                        </Button>
                    </Group>
                </Stack>
            </form>
        </Modal>
    );
};
