import { configureStore } from '@reduxjs/toolkit';
import { afterEach, describe, expect, it } from 'vitest';
import reducer, { getSDRConfigParameters } from '../waterfall-slice.jsx';

describe('SDR capability requests', () => {
    afterEach(() => localStorage.removeItem('ground-station.waterfall.sdr-params.v1'));

    it('uses backend capabilities even when a browser has an old cached response', async () => {
        localStorage.setItem('ground-station.waterfall.sdr-params.v1', JSON.stringify({
            version: 1,
            items: { 'sdr-a': { gain_values: [1] } },
        }));
        const calls = [];
        const socket = {
            emit: (_event, request, callback) => {
                calls.push(request.cmd);
                callback({ success: true, data: { gain_values: [0, 10, 20] } });
            },
        };
        const store = configureStore({ reducer: { waterfall: reducer } });

        await store.dispatch(getSDRConfigParameters({ socket, selectedSDRId: 'sdr-a' })).unwrap();

        expect(calls).toEqual(['get-sdr-parameters']);
        expect(store.getState().waterfall.gainValues).toEqual([0, 10, 20]);
    });
});
