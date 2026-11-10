// ldq-time-range-picker: one control for relative and absolute ranges, plus an optional refresh
// interval (Off, 10s, 30s, 1m, 5m, 15m, 30m, 1h). Shared by dashboards and Investigate.
import { listOptions, chooseOption, fireEvent, renderUi, screen, setText } from './ui';
import { load } from './load';

let TimeRangePicker: any;

beforeAll(async () => {
    ({ TimeRangePicker } = await load(
        '../../features/timeRange/components/TimeRangePicker',
    ));
}, 120_000);

describe('TimeRangePicker', () => {
    it('labels the current relative range', () => {
        renderUi(
            <TimeRangePicker
                value={{ from: 'now-6h', to: 'now' }}
                onChange={vi.fn()}
            />,
        );
        expect(screen.getByText('Last 6 hours')).toBeInTheDocument();
    });

    it('picks a quick relative range', async () => {
        const onChange = vi.fn();
        renderUi(
            <TimeRangePicker
                value={{ from: 'now-6h', to: 'now' }}
                onChange={onChange}
            />,
        );
        fireEvent.click(screen.getByText('Last 6 hours'));
        fireEvent.click(await screen.findByText('Last 15 minutes'));
        expect(onChange).toHaveBeenLastCalledWith({ from: 'now-15m', to: 'now' });
        fireEvent.click(screen.getByText('Last 6 hours'));
        fireEvent.click(await screen.findByText('Last 7 days'));
        expect(onChange).toHaveBeenLastCalledWith({ from: 'now-7d', to: 'now' });
    });

    it('applies an absolute range', async () => {
        const onChange = vi.fn();
        renderUi(
            <TimeRangePicker
                value={{ from: 'now-1h', to: 'now' }}
                onChange={onChange}
            />,
        );
        fireEvent.click(screen.getByText('Last 1 hour'));
        await screen.findByLabelText('From');
        setText('From', '2026-11-01T00:00:00.000Z');
        setText('To', '2026-11-02T00:00:00.000Z');
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
        expect(onChange).toHaveBeenLastCalledWith({
            from: '2026-11-01T00:00:00.000Z',
            to: '2026-11-02T00:00:00.000Z',
        });
    });

    it('offers exactly the refresh intervals when refresh is enabled', async () => {
        const onRefreshIntervalChange = vi.fn();
        renderUi(
            <TimeRangePicker
                value={{ from: 'now-6h', to: 'now' }}
                onChange={vi.fn()}
                refreshInterval={null}
                onRefreshIntervalChange={onRefreshIntervalChange}
            />,
        );
        expect(await listOptions('Refresh')).toEqual([
            'Off',
            '10s',
            '30s',
            '1m',
            '5m',
            '15m',
            '30m',
            '1h',
        ]);
        await chooseOption('Refresh', '30s');
        expect(onRefreshIntervalChange).toHaveBeenLastCalledWith('30s');
    });

    it('hides refresh when the caller does not support it', () => {
        renderUi(
            <TimeRangePicker
                value={{ from: 'now-6h', to: 'now' }}
                onChange={vi.fn()}
            />,
        );
        expect(screen.queryByLabelText('Refresh')).toBeNull();
    });
});
