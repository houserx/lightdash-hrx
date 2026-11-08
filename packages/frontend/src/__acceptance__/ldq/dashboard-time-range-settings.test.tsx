// ldq-dashboard-time-range-settings: a dashboard-level setting maps each Tile to the time
// dimension the Dashboard Time Range filters on.
import { load } from './load';
import { chooseOption, renderUi, screen } from './ui';

let DashboardTimeRangeSettings: any;

beforeAll(async () => {
    ({ DashboardTimeRangeSettings } = await load(
        '../../features/dashboardTimeRange/components/DashboardTimeRangeSettings',
    ));
}, 120_000);

const tiles = [
    {
        uuid: 'tile-orders',
        name: 'Orders per hour',
        timeDimensions: [
            { fieldId: 'orders_created_at', tableName: 'orders', label: 'Created at' },
            { fieldId: 'orders_shipped_at', tableName: 'orders', label: 'Shipped at' },
        ],
    },
    { uuid: 'tile-note', name: 'Runbook', timeDimensions: [] },
];

describe('DashboardTimeRangeSettings', () => {
    it('maps a tile to one of its time dimensions', async () => {
        const onChange = vi.fn();
        renderUi(
            <DashboardTimeRangeSettings
                tiles={tiles}
                value={{}}
                onChange={onChange}
            />,
        );
        await chooseOption('Orders per hour', 'Shipped at');
        expect(onChange).toHaveBeenLastCalledWith({
            'tile-orders': {
                fieldId: 'orders_shipped_at',
                tableName: 'orders',
            },
        });
    });

    it('clears a mapping with None', async () => {
        const onChange = vi.fn();
        renderUi(
            <DashboardTimeRangeSettings
                tiles={tiles}
                value={{
                    'tile-orders': {
                        fieldId: 'orders_created_at',
                        tableName: 'orders',
                    },
                }}
                onChange={onChange}
            />,
        );
        await chooseOption('Orders per hour', 'None');
        expect(onChange).toHaveBeenLastCalledWith({});
    });

    it('explains tiles that have no time dimension', () => {
        renderUi(
            <DashboardTimeRangeSettings
                tiles={tiles}
                value={{}}
                onChange={vi.fn()}
            />,
        );
        expect(screen.getByText('Runbook')).toBeInTheDocument();
        expect(screen.getByText('No time dimension')).toBeInTheDocument();
    });
});
