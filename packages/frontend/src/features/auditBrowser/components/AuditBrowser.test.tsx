import { MantineProvider } from '@mantine/core';
import {
    fireEvent,
    render,
    renderHook,
    screen,
    waitFor,
} from '@testing-library/react';
import { useAuditBrowserApi } from '../hooks/useAuditBrowserApi';
import { AuditBrowser, type AuditBrowserProps } from './AuditBrowser';

const api = vi.fn();
vi.mock('../../../providers/LightdashApi/useLightdashApi', () => ({
    useLightdashApi: () => api,
}));

const renderBrowser = (fetchPage: AuditBrowserProps['fetchPage']) =>
    render(
        <MantineProvider env="test" forceColorScheme="light">
            <AuditBrowser canRead fetchPage={fetchPage} />
        </MantineProvider>,
    );

const setText = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('AuditBrowser', () => {
    it('trims filters and leaves blank ones out', async () => {
        const fetchPage = vi.fn(async () => ({ items: [], nextCursor: null }));
        renderBrowser(fetchPage);
        expect(
            await screen.findByText('No executions match these filters.'),
        ).toBeInTheDocument();

        setText('Ticket', '  ENG-9  ');
        setText('User', '   ');
        fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
        await waitFor(() =>
            expect(fetchPage).toHaveBeenLastCalledWith({ ticket: 'ENG-9' }),
        );
    });

    it('shows the message of a Lightdash API error', async () => {
        const fetchPage = vi.fn(async () => {
            throw {
                status: 'error',
                error: { statusCode: 400, message: 'month must be YYYY-MM' },
            };
        });
        renderBrowser(fetchPage);
        expect(
            await screen.findByText('month must be YYYY-MM'),
        ).toBeInTheDocument();
        expect(screen.queryByTestId('audit-executions')).toBeNull();
    });
});

describe('useAuditBrowserApi', () => {
    it('calls the audit route with only the given filters', async () => {
        api.mockResolvedValue({ items: [], nextCursor: null });
        const { result } = renderHook(() => useAuditBrowserApi('project-1'));
        await result.current({ ticket: 'ENG-1', month: '2026-11', user: '' });
        expect(api).toHaveBeenLastCalledWith({
            url: '/projects/project-1/federation/audit?ticket=ENG-1&month=2026-11',
            version: 'v2',
            method: 'GET',
            body: undefined,
        });
        await result.current({});
        expect(api).toHaveBeenLastCalledWith(
            expect.objectContaining({
                url: '/projects/project-1/federation/audit',
            }),
        );
    });
});
