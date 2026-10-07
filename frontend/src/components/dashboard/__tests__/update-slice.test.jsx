import { configureStore } from '@reduxjs/toolkit';
import { afterEach, expect, test, vi } from 'vitest';
import reducer, { fetchUpdateCheck } from '../update-slice.jsx';

const createStore = () => configureStore({ reducer: { updateCheck: reducer } });

afterEach(() => {
    vi.unstubAllGlobals();
});

test('forces a fresh update check and stores successful release status', async () => {
    const payload = {
        currentVersion: '1.2.0',
        latestVersion: '1.3.0',
        latestTag: 'v1.3.0',
        latestUrl: 'https://github.com/sgoudelis/ground-station/releases/tag/v1.3.0',
        publishedAt: '2026-10-07T10:00:00Z',
        checkedAt: '2026-10-07T11:00:00Z',
        isUpdateAvailable: true,
    };
    const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(payload),
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = createStore();

    await store.dispatch(fetchUpdateCheck({ force: true }));

    expect(fetchMock).toHaveBeenCalledWith('/api/update-check?refresh=true', { cache: 'no-store' });
    expect(store.getState().updateCheck.data).toEqual(payload);
    expect(store.getState().updateCheck.error).toBeNull();
    expect(store.getState().updateCheck.lastChecked).toEqual(expect.any(Number));
});

test('stores the backend error returned by a failed GitHub check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: vi.fn().mockResolvedValue({
            detail: 'Unable to check GitHub Releases: connection timed out',
        }),
    }));
    const store = createStore();

    await store.dispatch(fetchUpdateCheck());

    const state = store.getState().updateCheck;
    expect(state.loading).toBe(false);
    expect(state.error).toBe('Unable to check GitHub Releases: connection timed out');
    expect(state.lastAttempted).toEqual(expect.any(Number));
    expect(state.lastChecked).toBeNull();
});
