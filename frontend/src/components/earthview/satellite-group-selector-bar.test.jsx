import React from 'react';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {configureStore} from '@reduxjs/toolkit';
import {Provider} from 'react-redux';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import '../../i18n/config.js';
import SatelliteGroupSelectorBar from './satellite-group-selector-bar.jsx';
import earthViewReducer, {setSelectedSatGroupId} from './earthview-slice.jsx';

const socket = vi.hoisted(() => ({emit: vi.fn()}));

vi.mock('../common/socket.jsx', () => ({
    useSocket: () => ({socket}),
}));

const groups = [
    {id: 'amateur', name: 'Amateur', type: 'system', satellite_ids: [1, 2]},
    {id: 'weather', name: 'Weather', type: 'system', satellite_ids: [3]},
    {id: 'tinygs', name: 'TinyGS', type: 'user', satellite_ids: [4]},
    {id: 'noaa', name: 'NOAA', type: 'system', satellite_ids: [5]},
    {id: 'large', name: 'Large', type: 'user', satellite_ids: Array.from({length: 201}, (_, index) => index)},
];

const recentPillIds = () => within(screen.getByRole('group', {name: 'Recent'}))
    .getAllByRole('button')
    .map(button => button.getAttribute('data-pill-id'));

describe('Earth view recent group shortcuts', () => {
    beforeEach(() => {
        localStorage.clear();
        socket.emit.mockReset();
        socket.emit.mockImplementation((_event, _request, acknowledge) => acknowledge({success: true, data: []}));
    });

    it('shows stored recent groups, keeps pill order during selection, and appends a new selection', async () => {
        localStorage.setItem('satellite-recent-groups', JSON.stringify([
            {id: 'amateur', name: 'Amateur'},
            {id: 'weather', name: 'Weather'},
            {id: 'tinygs', name: 'TinyGS'},
            {id: 'large', name: 'Large'},
        ]));
        const initialState = earthViewReducer(undefined, {type: 'init'});
        const store = configureStore({
            reducer: {earthViewTrack: earthViewReducer},
            preloadedState: {
                earthViewTrack: {
                    ...initialState,
                    satGroups: groups,
                    selectedSatGroupId: 'amateur',
                },
            },
        });

        render(<Provider store={store}><SatelliteGroupSelectorBar /></Provider>);

        await waitFor(() => expect(recentPillIds()).toEqual(['amateur', 'weather', 'tinygs', 'large']));
        expect(screen.queryByRole('button', {name: /NOAA/})).not.toBeInTheDocument();
        expect(within(screen.getByRole('group', {name: 'Recent'})).getByRole('button', {name: /Large/})).toBeDisabled();

        fireEvent.click(within(screen.getByRole('group', {name: 'Recent'})).getByRole('button', {name: /Weather/}));
        await waitFor(() => expect(store.getState().earthViewTrack.selectedSatGroupId).toBe('weather'));
        expect(recentPillIds()).toEqual(['amateur', 'weather', 'tinygs', 'large']);

        act(() => store.dispatch(setSelectedSatGroupId('noaa')));
        await waitFor(() => expect(recentPillIds()).toEqual(['amateur', 'weather', 'tinygs', 'large', 'noaa']));
        expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
    });
});
