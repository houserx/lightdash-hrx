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
