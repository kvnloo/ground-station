import { configureStore } from '@reduxjs/toolkit';
import { expect, test, vi } from 'vitest';
import reducer, {
    deleteLibraryItems,
    fetchFiles,
    setPageSize,
} from '../filebrowser-slice.jsx';

function createStore() {
    return configureStore({ reducer: { filebrowser: reducer } });
}

test('queries one server-side page and stores its total', async () => {
    const socket = {
        connected: true,
        emit: vi.fn((event, payload, callback) => {
            expect(event).toBe('api.call');
            expect(payload).toEqual({
                cmd: 'filebrowser.query',
                data: {
                    filters: { showAudio: true },
                    sortBy: 'modified',
                    sortOrder: 'desc',
                    page: 3,
                    pageSize: 25,
                },
            });
            callback({
                success: true,
                data: {
                    items: [{ id: 'audio:voice.wav', type: 'audio', filename: 'voice.wav' }],
                    total: 51,
                    diskUsage: { total: 100, used: 20, available: 80 },
                },
            });
        }),
    };
    const store = createStore();

    await store.dispatch(fetchFiles({
        socket,
        filters: { showAudio: true },
        sortBy: 'modified',
        sortOrder: 'desc',
        page: 3,
        pageSize: 25,
    })).unwrap();

    expect(store.getState().filebrowser.files).toEqual([
        { id: 'audio:voice.wav', type: 'audio', filename: 'voice.wav' },
    ]);
    expect(store.getState().filebrowser.total).toBe(51);
});

test('only removes acknowledged library deletions', async () => {
    const socket = {
        connected: true,
        emit: vi.fn((event, payload, callback) => {
            expect(event).toBe('api.call');
            expect(payload).toEqual({
                cmd: 'filebrowser.delete',
                data: { ids: ['audio:voice.wav'] },
            });
            callback({ success: false, error: 'Item not found' });
        }),
    };
    const store = createStore();

    await expect(store.dispatch(deleteLibraryItems({ socket, ids: ['audio:voice.wav'] })).unwrap())
        .rejects.toThrow('Item not found');
    expect(store.getState().filebrowser.files).toEqual([]);
});

test('changing responsive page size restarts paging', () => {
    const store = createStore();
    store.dispatch({ type: 'filebrowser/setPage', payload: 4 });
    store.dispatch(setPageSize(25));

    expect(store.getState().filebrowser.pageSize).toBe(25);
    expect(store.getState().filebrowser.page).toBe(1);
});
