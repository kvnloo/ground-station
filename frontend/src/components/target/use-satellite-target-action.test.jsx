import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../i18n/config.js';
import { useSatelliteTargetAction } from './use-satellite-target-action.jsx';

const { chooseTargetSlot, submitTracking } = vi.hoisted(() => ({
    chooseTargetSlot: vi.fn(),
    submitTracking: vi.fn(),
}));

vi.mock('../common/socket.jsx', () => ({ useSocket: () => ({ socket: { emit: vi.fn() } }) }));
vi.mock('./use-target-rotator-selection-dialog.jsx', () => ({
    useTargetRotatorSelectionDialog: () => ({ requestRotatorForTarget: chooseTargetSlot, dialog: null }),
}));
vi.mock('./target-slice.jsx', () => ({
    setTrackerId: (trackerId) => ({ type: 'test/setTrackerId', payload: trackerId }),
    setRotator: (selection) => ({ type: 'test/setRotator', payload: selection }),
    setTrackingStateInBackend: (request) => {
        submitTracking(request);
        return () => ({ unwrap: async () => ({ success: true }) });
    },
}));

const renderTargetAction = () => {
    const store = configureStore({
        reducer: {
            targetSatTrack: () => ({
                satelliteId: 987,
                trackingState: { group_id: 'previous-group' },
                trackerViews: {
                    'target-1': {
                        trackingState: {
                            norad_id: 987,
                            group_id: 'previous-group',
                            transmitter_id: 'transmitter-1',
                            rig_id: 'rig-1',
                        },
                        selectedRadioRig: 'rig-2',
                    },
                },
            }),
            trackerInstances: () => ({ instances: [{ tracker_id: 'target-1' }] }),
        },
    });
    const wrapper = ({ children }) => <Provider store={store}>{children}</Provider>;
    return renderHook(() => useSatelliteTargetAction({
        satellite: { norad_id: 12345, name: 'New Satellite' },
        groupId: 'selected-group',
    }), { wrapper });
};

describe('useSatelliteTargetAction', () => {
    beforeEach(() => {
        chooseTargetSlot.mockReset();
        submitTracking.mockReset();
    });

    it('retargets the selected slot while preserving its rig and transmitter', async () => {
        chooseTargetSlot.mockResolvedValue({
            action: 'retarget_current_slot',
            trackerId: 'target-1',
            rotatorId: 'rotator-1',
            rigId: 'rig-1',
        });
        const { result } = renderTargetAction();

        await act(async () => { await result.current.setAsTarget(); });

        expect(chooseTargetSlot).toHaveBeenCalledWith('New Satellite');
        expect(submitTracking).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                tracker_id: 'target-1',
                norad_id: 12345,
                group_id: 'selected-group',
                target_type: 'satellite',
                target_name: 'New Satellite',
                rotator_id: 'rotator-1',
                rig_id: 'rig-2',
                transmitter_id: 'transmitter-1',
            }),
        }));
    });

    it('starts a new slot without carrying over the previous transmitter', async () => {
        chooseTargetSlot.mockResolvedValue({
            action: 'create_new_slot',
            trackerId: 'target-2',
            rotatorId: 'rotator-1',
            rigId: 'rig-3',
        });
        const { result } = renderTargetAction();

        await act(async () => { await result.current.setAsTarget(); });

        expect(submitTracking).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                tracker_id: 'target-2',
                norad_id: 12345,
                target_type: 'satellite',
                rotator_id: 'none',
                rig_id: 'rig-3',
                transmitter_id: 'none',
            }),
        }));
    });
});
