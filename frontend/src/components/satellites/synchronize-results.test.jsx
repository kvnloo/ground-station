/**
 * @license
 * Copyright (c) 2026 Efstratios Goudelis
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../i18n/config.js';
import SyncResultsTable from './synchronize-results.jsx';
import satellitesReducer from './satellite-slice.jsx';

const socket = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock('../common/socket.jsx', () => ({
    useSocket: () => ({ socket }),
}));

vi.mock('./satellite-info-page.jsx', () => ({
    SatelliteInfoDialog: ({ open, onClose, satelliteData }) => open && (
        <div role="dialog">
            <span>{satelliteData.name}</span>
            <span>{satelliteData.transmitters[0]?.description}</span>
            <span>{satelliteData.position?.lat}</span>
            <button type="button" onClick={onClose}>Close details</button>
        </div>
    ),
}));

const syncState = {
    newly_added: {
        satellites: [{ name: 'NewSat', norad_id: 12345 }],
        transmitters: [],
    },
    modified: {
        satellites: [{ name: 'ChangedSat', norad_id: 67890, changes: { name: {} } }],
        transmitters: [],
    },
    removed: {
        satellites: [{ name: 'GoneSat', norad_id: 22222 }],
        transmitters: [],
    },
};

const renderResults = () => {
    const store = configureStore({ reducer: { satellites: satellitesReducer } });
    render(
        <Provider store={store}>
            <SyncResultsTable
                hasNewItems
                hasModifiedItems
                hasRemovedItems
                newSatellitesCount={1}
                newTransmittersCount={0}
                modifiedSatellitesCount={1}
                modifiedTransmittersCount={0}
                removedSatellitesCount={1}
                removedTransmittersCount={0}
                syncState={syncState}
            />
        </Provider>
    );
};

describe('orbital sync satellite details links', () => {
    beforeEach(() => {
        socket.emit.mockReset();
        socket.emit.mockImplementation((_event, request, acknowledge) => {
            if (request.cmd !== 'get-satellite') return;
            acknowledge({
                success: true,
                data: {
                    details: {
                        norad_id: request.data,
                        name: request.data === 12345 ? 'NewSat' : 'ChangedSat',
                    },
                    transmitters: [{ description: `Transmitter ${request.data}` }],
                    position: { lat: 12.5 },
                },
            });
        });
    });

    it.each([
        ['added name', 'NewSat', 12345],
        ['added NORAD ID', '12345', 12345],
        ['modified name', 'ChangedSat', 67890],
    ])('opens full details from the %s link', async (_case, label, noradId) => {
        renderResults();

        fireEvent.click(screen.getByRole('button', { name: label }));

        await waitFor(() => expect(socket.emit).toHaveBeenCalledWith(
            'api.call',
            { cmd: 'get-satellite', data: noradId },
            expect.any(Function),
        ));
        expect(await screen.findByRole('dialog')).toHaveTextContent(`Transmitter ${noradId}`);
        expect(screen.getByRole('dialog')).toHaveTextContent('12.5');
        expect(screen.queryByRole('button', { name: 'GoneSat' })).not.toBeInTheDocument();
    });

    it('keeps the most recently selected satellite when fetches finish out of order', async () => {
        const acknowledgements = new Map();
        socket.emit.mockImplementation((_event, request, acknowledge) => {
            acknowledgements.set(request.data, acknowledge);
        });
        renderResults();

        fireEvent.click(screen.getByRole('button', { name: 'NewSat' }));
        fireEvent.click(screen.getByRole('button', { name: 'ChangedSat' }));

        await act(async () => {
            acknowledgements.get(67890)({
                success: true,
                data: { details: { norad_id: 67890, name: 'ChangedSat' }, transmitters: [{ description: 'Changed transmitter' }] },
            });
        });
        expect(screen.getByRole('dialog')).toHaveTextContent('Changed transmitter');

        await act(async () => {
            acknowledgements.get(12345)({
                success: true,
                data: { details: { norad_id: 12345, name: 'NewSat' }, transmitters: [{ description: 'Old transmitter' }] },
            });
        });
        expect(screen.getByRole('dialog')).toHaveTextContent('Changed transmitter');
    });
});
