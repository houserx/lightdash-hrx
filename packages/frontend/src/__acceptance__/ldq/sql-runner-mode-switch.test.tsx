// ldq-investigate-availability: Investigate is a mode of the SQL Runner, offered only on
// projects whose warehouse credentials have flavor 'federation'.
import { load } from './load';
import { fireEvent, renderUi, screen } from './ui';

let SqlRunnerModeSwitch: any;

beforeAll(async () => {
    ({ SqlRunnerModeSwitch } = await load(
        '../../features/investigate/components/SqlRunnerModeSwitch',
    ));
}, 120_000);

const federationProject = {
    warehouseConnection: { type: 'postgres', flavor: 'federation' },
};

describe('SqlRunnerModeSwitch', () => {
    it('offers Investigate on a federation project', () => {
        const onModeChange = vi.fn();
        renderUi(
            <SqlRunnerModeSwitch
                project={federationProject}
                mode="sql"
                onModeChange={onModeChange}
            />,
        );
        fireEvent.click(screen.getByRole('radio', { name: 'Investigate' }));
        expect(onModeChange).toHaveBeenLastCalledWith('investigate');
        expect(screen.getByRole('radio', { name: 'SQL' })).toBeInTheDocument();
    });

    it('is absent on plain Postgres and other warehouses', () => {
        renderUi(
            <>
                <SqlRunnerModeSwitch
                    project={{
                        warehouseConnection: { type: 'postgres', flavor: 'postgres' },
                    }}
                    mode="sql"
                    onModeChange={vi.fn()}
                />
                <SqlRunnerModeSwitch
                    project={{ warehouseConnection: { type: 'bigquery' } }}
                    mode="sql"
                    onModeChange={vi.fn()}
                />
                <SqlRunnerModeSwitch
                    project={undefined}
                    mode="sql"
                    onModeChange={vi.fn()}
                />
            </>,
        );
        expect(screen.queryByText('Investigate')).toBeNull();
        expect(screen.queryAllByRole('radio')).toHaveLength(0);
    });
});
