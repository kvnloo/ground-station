import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../i18n/config.js';
import { configureStore } from '@reduxjs/toolkit';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'react-toastify';
import { renderWithProviders } from '../../../test/test-utils.jsx';
import filebrowserReducer, { purgeFinished, purgeProgressUpdated } from '../filebrowser-slice.jsx';
import PurgeDialog from '../purge-dialog.jsx';

vi.mock('react-toastify', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

const AGGREGATE = {
    items: 7,
    files: 40,
    bytes: 5_000_000_000,
    skippedInProgress: 1,
    categories: {
        observation: { items: 1, files: 30, bytes: 4_000_000_000 },
        recording: { items: 2, files: 8, bytes: 800_000_000 },
        snapshot: { items: 4, files: 4, bytes: 200_000_000 },
    },
    oldest: '2024-01-01T00:00:00+00:00',
    newest: '2026-06-01T00:00:00+00:00',
};

// Match the backend's UTC offset format rather than echoing the request's Z.
function mockSocket() {
    return {
        connected: true,
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn((event, payload, callback) => {
            callback({
                success: true,
                data: { ...AGGREGATE, cutoff: payload.data.cutoff.replace('Z', '+00:00') },
            });
        }),
    };
}

function createStore() {
    return configureStore({
        reducer: { filebrowser: filebrowserReducer },
        middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false }),
    });
}

describe('PurgeDialog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        {
            result: { success: true, deleted: 62, files: 62, bytesFreed: 4_710_000_000, failed: [] },
            method: 'success',
            message: 'Purged 62 items, freed 4.39 GB',
        },
        {
            result: { success: false, error: 'Could not purge files' },
            method: 'error',
            message: 'Could not purge files',
        },
    ])('does not replay a $method toast when returning to the file browser', async ({ result, method, message }) => {
        const socket = mockSocket();
        const store = createStore();
        const dialog = <PurgeDialog open={false} onClose={vi.fn()} socket={socket} />;
        const firstVisit = renderWithProviders(dialog, { store });

        // Completions still notify while the dialog is closed.
        act(() => store.dispatch(purgeFinished(result)));
        expect(toast[method]).toHaveBeenCalledExactlyOnceWith(message);
        firstVisit.unmount();

        const nextVisit = renderWithProviders(dialog, { store });
        expect(toast[method]).toHaveBeenCalledTimes(1);

        // A subsequent sweep must still notify, even with identical totals.
        act(() => store.dispatch(purgeProgressUpdated({ done: 0, total: 62 })));
        act(() => store.dispatch(purgeFinished({ ...result })));
        expect(toast[method]).toHaveBeenCalledTimes(2);
        expect(toast[method]).toHaveBeenLastCalledWith(message);

        nextVisit.rerender(<PurgeDialog open onClose={vi.fn()} socket={socket} />);
        await waitFor(() => expect(store.getState().filebrowser.purge.preview).not.toBeNull());
        expect(toast[method]).toHaveBeenCalledTimes(2);
    });

    it('keeps one spinner visible across the opening preview requests', async () => {
        const requests = [];
        const socket = {
            connected: true,
            on: vi.fn(),
            off: vi.fn(),
            emit: vi.fn((_event, payload, callback) => requests.push({ payload, callback })),
        };
        const store = createStore();
        renderWithProviders(<PurgeDialog open onClose={vi.fn()} socket={socket} />, { store });

        await waitFor(() => expect(requests).toHaveLength(1));
        expect(screen.getAllByRole('progressbar', { name: 'Scanning the library...' })).toHaveLength(1);

        act(() => {
            requests[0].callback({
                success: true,
                data: { ...AGGREGATE, cutoff: requests[0].payload.data.cutoff },
            });
        });
        await waitFor(() => expect(store.getState().filebrowser.purge.previewLoading).toBe(false));
        expect(screen.getAllByRole('progressbar', { name: 'Scanning the library...' })).toHaveLength(1);

        await waitFor(() => expect(requests).toHaveLength(2), { timeout: 3000 });
        act(() => {
            requests[1].callback({
                success: true,
                data: { ...AGGREGATE, cutoff: requests[1].payload.data.cutoff },
            });
        });
        await waitFor(() => {
            expect(screen.queryByRole('progressbar', { name: 'Scanning the library...' })).not.toBeInTheDocument();
        });
    });

    it('shows preview aggregates and starts the purge after confirmation', async () => {
        const socket = mockSocket();
        const store = createStore();
        renderWithProviders(
            <PurgeDialog open onClose={vi.fn()} socket={socket} />,
            { store }
        );

        expect(screen.getByText('Purge old files')).toBeInTheDocument();
        expect(screen.getByRole('progressbar', { name: 'Deletion progress' })).toHaveAttribute('aria-valuenow', '0');
        expect(screen.getByRole('button', { name: /Purge/i })).toBeDisabled();
        const initialSlider = screen.getByRole('slider', { name: 'Delete before' });
        expect(initialSlider).toHaveAttribute('aria-valuenow', initialSlider.getAttribute('aria-valuemax'));

        // The bootstrap preview provides the slider domain; the debounced
        // default-cutoff preview then fills the summary.
        await waitFor(() => {
            expect(screen.getByText('items will be deleted (40 files, including metadata files)')).toBeInTheDocument();
        }, { timeout: 3000 });
        expect(screen.getByText('7')).toBeInTheDocument();
        expect(screen.getByText(/in-progress items are protected/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Purge/i })).toBeEnabled();
        const readySlider = screen.getByRole('slider', { name: 'Delete before' });
        expect(readySlider).toHaveAttribute('aria-valuenow', readySlider.getAttribute('aria-valuemax'));

        await userEvent.click(screen.getByRole('button', { name: /Purge/i }));
        expect(await screen.findByText('Purge 7 items?')).toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: /Delete/i }));
        await waitFor(() => {
            expect(socket.emit).toHaveBeenCalledWith(
                'api.call',
                expect.objectContaining({ cmd: 'filebrowser.purge' }),
                expect.any(Function)
            );
        });
        expect(screen.getByText('Composition')).toBeInTheDocument();
        expect(await screen.findByRole('progressbar', { name: 'Purge' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Purge/i })).toBeDisabled();
        act(() => {
            store.dispatch(purgeProgressUpdated({ done: 2, total: 7, bytesFreed: 1024, current: 'sample.wav' }));
        });
        expect(screen.getByRole('progressbar', { name: 'Deletion progress' })).toHaveAttribute('aria-valuenow', '29');
        expect(screen.getByText('2 / 7', { exact: false })).toBeInTheDocument();
        expect(screen.getByText(/Removing sample.wav.../)).toBeInTheDocument();

        act(() => {
            store.dispatch(purgeFinished({ success: true, deleted: 7, files: 40, bytesFreed: 5_000_000_000, failed: [] }));
        });
        expect(screen.getByText('Composition')).toBeInTheDocument();
        expect(screen.getByRole('progressbar', { name: 'Deletion progress' })).toHaveAttribute('aria-valuenow', '100');
        expect(screen.getByText('Deleted 7 items (40 files, including metadata files), freed 4.66 GB.')).toBeInTheDocument();
        expect(screen.queryByText('— / — · —')).not.toBeInTheDocument();
        expect(screen.queryByRole('progressbar', { name: 'Purge' })).not.toBeInTheDocument();
        await waitFor(() => {
            const slider = screen.getByRole('slider', { name: 'Delete before' });
            expect(slider).toBeEnabled();
            expect(slider).toHaveAttribute('aria-valuenow', slider.getAttribute('aria-valuemax'));
            expect(screen.getByRole('button', { name: /Purge/i })).toBeEnabled();
        }, { timeout: 3000 });
    });

    it('asks for a purge only after the domain is known', async () => {
        const socket = {
            connected: true,
            on: vi.fn(),
            off: vi.fn(),
            emit: vi.fn((event, payload, callback) => {
                callback({
                    success: true,
                    data: {
                        items: 0,
                        files: 0,
                        bytes: 0,
                        skippedInProgress: 0,
                        categories: {},
                        cutoff: payload.data.cutoff,
                        oldest: '2026-05-20T00:00:00+00:00',
                        newest: '2026-06-01T00:00:00+00:00',
                    },
                });
            }),
        };
        renderWithProviders(<PurgeDialog open onClose={vi.fn()} socket={socket} />, { store: createStore() });

        await waitFor(() => {
            expect(screen.getByText('items will be deleted (0 files, including metadata files)')).toBeInTheDocument();
        }, { timeout: 3000 });
        expect(screen.getByText('Composition')).toBeInTheDocument();
        expect(screen.getByText('0 B')).toBeInTheDocument();
        expect(screen.getByText('No in-progress items in the selected date range.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Purge/i })).toBeDisabled();
    });

    it('keeps the full layout visible while preview values are unavailable', () => {
        const socket = {
            connected: true,
            on: vi.fn(),
            off: vi.fn(),
            emit: vi.fn(),
        };
        renderWithProviders(<PurgeDialog open onClose={vi.fn()} socket={socket} />, { store: createStore() });

        expect(screen.getByRole('slider', { name: 'Delete before' })).toBeDisabled();
        expect(screen.getByRole('progressbar', { name: 'Scanning the library...' })).toBeInTheDocument();
        expect(screen.getByText('items will be deleted (— files, including metadata files)')).toBeInTheDocument();
        expect(screen.getByText('Composition')).toBeInTheDocument();
        expect(screen.getByText(/Automated observations/)).toBeInTheDocument();
        expect(screen.queryByText('Scanning the library...')).not.toBeInTheDocument();
    });

    it('surfaces preview errors instead of hanging on the scanning state', async () => {
        // Reproduces a backend that predates the purge commands: the RPC
        // rejects and the dialog must explain itself, not spin forever.
        const socket = {
            connected: true,
            on: vi.fn(),
            off: vi.fn(),
            emit: vi.fn((event, payload, callback) => {
                callback({ success: false, error: 'Unknown command: filebrowser.purge-preview' });
            }),
        };
        renderWithProviders(<PurgeDialog open onClose={vi.fn()} socket={socket} />, { store: createStore() });

        expect(await screen.findByText(/Unknown command: filebrowser.purge-preview/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
        expect(screen.queryByText('Scanning the library...')).not.toBeInTheDocument();
        expect(screen.getByText('Composition')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Purge/i })).toBeDisabled();
    });
});
