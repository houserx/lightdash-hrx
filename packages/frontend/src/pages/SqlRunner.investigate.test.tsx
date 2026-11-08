import { WarehouseTypes, type Project } from '@lightdash/common';
import { fireEvent, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { renderWithProviders } from '../testing/testUtils';
import SqlRunnerNewPage from './SqlRunner';

vi.mock('../components/common/Page/Page', () => ({
    default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../features/sqlRunner', () => ({
    SqlRunnerSidebar: () => null,
}));
vi.mock('../features/sqlRunner/components/ContentPanel', () => ({
    ContentPanel: () => <div data-testid="sql-content-panel" />,
}));
vi.mock('../features/sqlRunner/components/Header', () => ({
    Header: () => null,
}));
vi.mock('../features/sqlRunner/components/Header/HeaderCreate', () => ({
    HeaderCreate: () => null,
}));
vi.mock(
    '../features/sqlRunner/multiConnection/components/SqlRunnerConnectionScope',
    () => ({
        SqlRunnerConnectionScope: ({
            children,
        }: {
            children: React.ReactNode;
        }) => <>{children}</>,
    }),
);
vi.mock('../features/sqlRunner/hooks/useSavedSqlCharts', () => ({
    useSavedSqlChart: () => ({ data: undefined, error: null }),
}));
vi.mock('../features/sqlRunner/hooks/useSqlRunnerShareUrl', () => ({
    useSqlRunnerShareUrl: () => ({ error: null, sqlRunnerState: null }),
}));
const projectQuery = vi.hoisted(() => ({
    data: undefined as
        | (Pick<Project, 'projectUuid'> & {
              warehouseConnection?: { type: WarehouseTypes; flavor?: string };
          })
        | undefined,
    isInitialLoading: false,
}));
vi.mock('../hooks/useProject', () => ({
    useProject: () => projectQuery,
}));
vi.mock('../hooks/useProjectUuid', () => ({
    useProjectUuid: () => 'project-uuid',
}));
vi.mock('../hooks/useSearchParams', () => ({
    default: () => null,
}));
vi.mock('../hooks/toaster/useToaster', () => ({
    default: () => ({ showToastError: vi.fn() }),
}));

const renderSqlRunner = () =>
    renderWithProviders(
        <MemoryRouter initialEntries={['/projects/project-uuid/sql-runner']}>
            <Routes>
                <Route
                    path="/projects/:projectUuid/sql-runner"
                    element={<SqlRunnerNewPage />}
                />
            </Routes>
        </MemoryRouter>,
    );

it('switches between SQL and Investigate on a federation project', async () => {
    projectQuery.data = {
        projectUuid: 'project-uuid',
        warehouseConnection: {
            type: WarehouseTypes.POSTGRES,
            flavor: 'federation',
        },
    };
    renderSqlRunner();

    expect(await screen.findByRole('radio', { name: 'SQL' })).toBeChecked();
    expect(screen.getByTestId('sql-content-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Investigate' }));
    expect(screen.getByRole('radio', { name: 'Investigate' })).toBeChecked();
    expect(screen.queryByTestId('sql-content-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'SQL' }));
    expect(screen.getByTestId('sql-content-panel')).toBeInTheDocument();
});

it('generates SQL from the picked source in Investigate', async () => {
    projectQuery.data = {
        projectUuid: 'project-uuid',
        warehouseConnection: {
            type: WarehouseTypes.POSTGRES,
            flavor: 'federation',
        },
    };
    renderSqlRunner();

    fireEvent.click(await screen.findByRole('radio', { name: 'Investigate' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Tempo' }));
    fireEvent.change(screen.getByLabelText('TraceQL'), {
        target: { value: '{ status = error }' },
    });
    expect(
        screen.getByLabelText<HTMLTextAreaElement>('SQL', {
            selector: 'textarea',
        }).value,
    ).toBe(
        "SELECT * FROM traceql('{ status = error }', ${ld.parameters.__from}, ${ld.parameters.__to}, 20)",
    );
});

it('keeps a manual edit of the generated SQL in Investigate', async () => {
    projectQuery.data = {
        projectUuid: 'project-uuid',
        warehouseConnection: {
            type: WarehouseTypes.POSTGRES,
            flavor: 'federation',
        },
    };
    renderSqlRunner();

    fireEvent.click(await screen.findByRole('radio', { name: 'Investigate' }));
    fireEvent.change(screen.getByLabelText('PromQL'), {
        target: { value: 'up' },
    });
    const sqlBox = screen.getByLabelText<HTMLTextAreaElement>('SQL', {
        selector: 'textarea',
    });
    expect(sqlBox.value).toContain("promql('up'");
    expect(sqlBox).not.toHaveAttribute('readonly');

    const edited =
        "SELECT timestamp, value FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval}) LIMIT 10";
    fireEvent.change(sqlBox, { target: { value: edited } });
    fireEvent.click(screen.getByRole('radio', { name: 'Loki' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Prometheus' }));
    expect(sqlBox.value).toBe(edited);

    fireEvent.change(screen.getByLabelText('PromQL'), {
        target: { value: 'rate(x[1m])' },
    });
    expect(sqlBox.value).toContain("promql('rate(x[1m])'");
});

it('builds CloudWatch metric and Logs Insights SQL in Investigate', async () => {
    projectQuery.data = {
        projectUuid: 'project-uuid',
        warehouseConnection: {
            type: WarehouseTypes.POSTGRES,
            flavor: 'federation',
        },
    };
    renderSqlRunner();

    fireEvent.click(await screen.findByRole('radio', { name: 'Investigate' }));
    fireEvent.click(screen.getByRole('radio', { name: 'CloudWatch metrics' }));
    const setField = (label: string, value: string) =>
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
    setField('Namespace', 'AWS/Lambda');
    setField('Metric name', 'Errors');
    setField('Dimensions', 'FunctionName=rx-sync');
    setField('Statistic', 'Sum');
    const json = screen.getByLabelText<HTMLTextAreaElement>(
        'MetricDataQuery JSON',
    );
    const sqlBox = screen.getByLabelText<HTMLTextAreaElement>('SQL', {
        selector: 'textarea',
    });
    expect(JSON.parse(json.value)).toMatchObject({
        Id: 'm1',
        MetricStat: { Period: 300, Stat: 'Sum' },
    });
    expect(sqlBox.value).toContain(
        `cloudwatch('${JSON.stringify(JSON.parse(json.value))}'`,
    );

    setField('MetricDataQuery JSON', '{ "Id": "e1"');
    expect(screen.getByText('Not valid JSON')).toBeInTheDocument();
    setField(
        'MetricDataQuery JSON',
        '{ "Id": "e1", "Expression": "m1 * 2", "ReturnData": true }',
    );
    expect(sqlBox.value).toBe(
        `SELECT * FROM cloudwatch('{"Id":"e1","Expression":"m1 * 2","ReturnData":true}', \${ld.parameters.__from}, \${ld.parameters.__to})`,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'CloudWatch Logs' }));
    setField('Log groups', '/ecs/api, /ecs/worker');
    setField('Logs Insights query', 'fields @message');
    setField('Source name', 'cloudwatch-production');
    expect(sqlBox.value).toBe(
        "SELECT * FROM cloudwatch_logs('/ecs/api,/ecs/worker', 'fields @message', ${ld.parameters.__from}, ${ld.parameters.__to}, 'cloudwatch-production')",
    );
});

it('has no Investigate mode on a plain Postgres project', async () => {
    projectQuery.data = {
        projectUuid: 'project-uuid',
        warehouseConnection: { type: WarehouseTypes.POSTGRES },
    };
    renderSqlRunner();

    expect(await screen.findByTestId('sql-content-panel')).toBeInTheDocument();
    expect(screen.queryByText('Investigate')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
});
