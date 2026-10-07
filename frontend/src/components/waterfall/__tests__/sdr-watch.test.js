import { describe, expect, it, vi } from 'vitest';
import reducer, { updateSDRConfig, setSelectedSDRId } from '../waterfall-slice.jsx';
import { unwatchSdr, watchSdr } from '../sdr-watch.js';
import backendSyncMiddleware, { setSocketForMiddleware } from '../vfo-marker/vfo-middleware.jsx';

describe('passive SDR watching', () => {
    it('uses only the watch subscription and applies the worker settings', async () => {
        const commands = [];
        const socket = {
            emit: (_event, request, callback) => {
                commands.push(request.cmd);
                callback(request.cmd === 'sdr.watch-sdr'
                    ? { success: true, data: { config: {
                        sdr_id: 'sdr-a', center_freq: 145_800_000,
                        sample_rate: 2_048_000, gain: 20, antenna: 'RX', bias_t: true,
                    } } }
                    : { success: true });
            },
        };
        let state = reducer(undefined, { type: '@@INIT' });
        const dispatch = (action) => { state = reducer(state, action); };
        dispatch(setSelectedSDRId('previous-sdr'));
        dispatch(updateSDRConfig({ sdr_id: 'previous-sdr', gain: 49.6, sample_rate: 1_024_000 }));

        await watchSdr(socket, dispatch, 'sdr-a');

        expect(commands).toEqual(['sdr.watch-sdr']);
        expect(state.selectedSDRId).toBe('sdr-a');
        expect(state.watchingSdrId).toBe('sdr-a');
        expect(state.isStreaming).toBe(true);
        expect(state.centerFrequency).toBe(145_800_000);
        expect(state.sampleRate).toBe(2_048_000);
        expect(state.gainValues).toEqual([20]);
        expect(state.sampleRateValues).toEqual([2_048_000]);
        expect(state.sdrSettingsById['sdr-a'].draft.biasT).toBe(true);

        dispatch(updateSDRConfig({ sdr_id: 'sdr-a', bias_t: false, center_freq: 145_810_000 }));
        expect(state.sdrSettingsById['sdr-a'].draft.biasT).toBe(false);
        expect(state.centerFrequency).toBe(145_810_000);

        await unwatchSdr(socket, dispatch, 'sdr-a');
        expect(commands).toEqual(['sdr.watch-sdr', 'sdr.unwatch-sdr']);
        expect(state.watchingSdrId).toBe(null);
        expect(state.isStreaming).toBe(false);
    });

    it('does not initialize VFO consumers when watching starts', () => {
        const socket = { emit: vi.fn() };
        setSocketForMiddleware(socket);
        const store = {
            getState: () => ({
                waterfall: { isStreaming: true, watchingSdrId: 'sdr-a' },
                vfo: { vfoMarkers: { 1: { frequency: 145_800_000 } },
                    vfoActive: { 1: true }, selectedVFO: 1 },
            }),
            dispatch: vi.fn(),
        };
        const next = vi.fn();

        backendSyncMiddleware(store)(next)({
            type: 'waterfallState/setIsStreaming', payload: true,
        });

        expect(store.dispatch).not.toHaveBeenCalled();
        setSocketForMiddleware(null);
    });
});
