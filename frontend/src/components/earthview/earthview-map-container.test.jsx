import React from 'react';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {configureStore} from '@reduxjs/toolkit';
import {Provider} from 'react-redux';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import '../../i18n/config.js';
import EarthViewMapContainer from './earthview-map-container.jsx';
import earthViewReducer from './earthview-slice.jsx';
import satellitesReducer from '../satellites/satellite-slice.jsx';

const socket = vi.hoisted(() => ({emit: vi.fn()}));

vi.mock('../common/socket.jsx', () => ({
    useSocket: () => ({socket}),
}));

vi.mock('./earthview-map-leaflet.jsx', () => ({
    default: ({onOpenSatelliteInfo}) => (
        <button type="button" onClick={() => onOpenSatelliteInfo({norad_id: 12345})}>
            Leaflet info
        </button>
    ),
}));

vi.mock('./earthview-map-maplibre.jsx', () => ({
    default: ({onOpenSatelliteInfo}) => (
        <>
            <button type="button" onClick={() => onOpenSatelliteInfo({norad_id: 12345})}>
                MapLibre info
            </button>
            <button type="button" onClick={() => onOpenSatelliteInfo({norad_id: 67890})}>
                Other MapLibre info
            </button>
        </>
    ),
}));

vi.mock('../satellites/satellite-info-page.jsx', () => ({
    SatelliteInfoDialog: ({open, onClose, satelliteData, targetGroupId, livePosition}) => open && (
        <div role="dialog">
            <span>{satelliteData.name}</span>
            <span>{satelliteData.transmitters[0]?.description}</span>
            <span>{satelliteData.position?.lat}</span>
            <span>{targetGroupId}</span>
            <span>{livePosition?.altitude}</span>
            <button type="button" onClick={onClose}>Close details</button>
        </div>
    ),
}));

const renderMap = (mapEngine) => {
    const state = earthViewReducer(undefined, {type: 'init'});
    const store = configureStore({
        reducer: {
            earthViewTrack: earthViewReducer,
            satellites: satellitesReducer,
        },
        preloadedState: {
            earthViewTrack: {
                ...state,
                mapEngine,
                selectedSatGroupId: 8,
                selectedSatellitePositions: {12345: {altitude: 420}},
            },
        },
    });
    render(<Provider store={store}><EarthViewMapContainer /></Provider>);
};

describe('Earth View map satellite information', () => {
    beforeEach(() => {
        socket.emit.mockReset();
        socket.emit.mockImplementation((_event, request, acknowledge) => {
            if (request.cmd !== 'get-satellite') return;
            acknowledge({
                success: true,
                data: {
                    details: {norad_id: request.data, name: 'Test satellite'},
                    transmitters: [{description: 'Test transmitter'}],
                    position: {lat: 12.5},
                },
            });
        });
    });

    it.each([
        ['leaflet', 'Leaflet info'],
        ['maplibre', 'MapLibre info'],
    ])('opens the shared dialog from the %s map', async (mapEngine, buttonName) => {
        renderMap(mapEngine);

        fireEvent.click(screen.getByRole('button', {name: buttonName}));

        await waitFor(() => expect(socket.emit).toHaveBeenCalledWith(
            'api.call',
            {cmd: 'get-satellite', data: 12345},
            expect.any(Function),
        ));
        expect(await screen.findByRole('dialog')).toHaveTextContent('Test satellite');
        expect(screen.getByRole('dialog')).toHaveTextContent('Test transmitter');
        expect(screen.getByRole('dialog')).toHaveTextContent('12.5');
        expect(screen.getByRole('dialog')).toHaveTextContent('420');
        expect(screen.getByRole('dialog')).toHaveTextContent('8');

        fireEvent.click(screen.getByRole('button', {name: 'Close details'}));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('keeps the last clicked satellite when requests finish out of order', async () => {
        const acknowledgements = new Map();
        socket.emit.mockImplementation((_event, request, acknowledge) => {
            acknowledgements.set(request.data, acknowledge);
        });
        renderMap('maplibre');

        fireEvent.click(screen.getByRole('button', {name: 'MapLibre info'}));
        fireEvent.click(screen.getByRole('button', {name: 'Other MapLibre info'}));
        await waitFor(() => expect(acknowledgements.size).toBe(2));

        await act(async () => {
            acknowledgements.get(67890)({
                success: true,
                data: {details: {norad_id: 67890, name: 'Second satellite'}},
            });
        });
        expect(screen.getByRole('dialog')).toHaveTextContent('Second satellite');

        await act(async () => {
            acknowledgements.get(12345)({
                success: true,
                data: {details: {norad_id: 12345, name: 'First satellite'}},
            });
        });
        expect(screen.getByRole('dialog')).toHaveTextContent('Second satellite');
        expect(screen.getByRole('dialog')).not.toHaveTextContent('First satellite');
    });
});
