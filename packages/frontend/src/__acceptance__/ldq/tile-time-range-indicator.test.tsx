// ldq-dashboard-tile-not-affected: Tiles without a time dimension are visibly marked
// "Not affected by the time range" when the dashboard has a Dashboard Time Range.
import { load } from './load';
import { renderUi, screen } from './ui';

let TileTimeRangeIndicator: any;

beforeAll(async () => {
    ({ TileTimeRangeIndicator } = await load(
        '../../features/dashboardTimeRange/components/TileTimeRangeIndicator',
    ));
}, 120_000);

const timeRange = {
    from: 'now-6h',
    to: 'now',
    refreshInterval: null,
    tileTimeDimensions: {
        'tile-orders': { fieldId: 'orders_created_at', tableName: 'orders' },
    },
};

describe('TileTimeRangeIndicator', () => {
    it('marks an unmapped tile', () => {
        renderUi(
            <TileTimeRangeIndicator
                timeRange={timeRange}
                tile={{ uuid: 'tile-other', type: 'saved_chart' }}
            />,
        );
        expect(
            screen.getByText('Not affected by the time range'),
        ).toBeInTheDocument();
    });

    it('shows nothing for a mapped tile or a telemetry SQL tile', () => {
        renderUi(
            <>
                <TileTimeRangeIndicator
                    timeRange={timeRange}
                    tile={{ uuid: 'tile-orders', type: 'saved_chart' }}
                />
                <TileTimeRangeIndicator
                    timeRange={timeRange}
                    tile={{ uuid: 'tile-sql', type: 'sql_chart' }}
                    sql="SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})"
                />
            </>,
        );
        expect(screen.queryByText('Not affected by the time range')).toBeNull();
    });

    it('shows nothing when the dashboard has no time range', () => {
        renderUi(
            <TileTimeRangeIndicator
                timeRange={undefined}
                tile={{ uuid: 'tile-other', type: 'saved_chart' }}
            />,
        );
        expect(screen.queryByText('Not affected by the time range')).toBeNull();
    });
});
