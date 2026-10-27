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
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it, vi } from 'vitest';
import '../../../i18n/config.js';
import { setupTheme } from '../../../theme.js';
import CelestialPasses from '../celestial-passes.jsx';

const socket = vi.hoisted(() => ({ emit: vi.fn() }));
const latestDataGridProps = vi.hoisted(() => ({ current: null }));

vi.mock('../../common/socket.jsx', () => ({
    useSocket: () => ({ socket }),
}));

vi.mock('../../target/use-target-rotator-selection-dialog.jsx', () => ({
    useTargetRotatorSelectionDialog: () => ({
        requestRotatorForTarget: vi.fn(),
        dialog: null,
    }),
}));

vi.mock('@mui/x-data-grid', async () => {
    const ReactModule = await import('react');
    return {
        DataGrid: ReactModule.forwardRef((props, ref) => {
            const { rows = [], slotProps = {}, onPaginationModelChange, paginationModel } = props;
            const previousRowsRef = ReactModule.useRef(rows);
            latestDataGridProps.current = props;

            ReactModule.useEffect(() => {
                if (previousRowsRef.current !== rows) {
                    // Model the automatic reset emitted by MUI while replacing
                    // a live row set so the component must retain ownership.
                    onPaginationModelChange?.({ page: 0, pageSize: paginationModel.pageSize });
                    previousRowsRef.current = rows;
                }
            }, [onPaginationModelChange, paginationModel, rows]);

            return ReactModule.createElement(
                'div',
                { ref },
                rows.map((row) => ReactModule.createElement(
                    'div',
                    {
                        key: row.id,
                        'data-id': row.id,
                        'data-testid': `pass-row-${row.id}`,
                        onContextMenu: slotProps?.row?.onContextMenu,
                    },
                    row.name,
                )),
            );
        }),
        gridClasses: { cell: 'MuiDataGrid-cell', columnHeader: 'MuiDataGrid-columnHeader' },
        gridPageCountSelector: () => 1,
        gridPageSelector: () => 0,
        gridRowSelectionCountSelector: () => 0,
        useGridApiContext: () => ({ current: { setPage: vi.fn() } }),
        useGridSelector: () => 0,
    };
});

const fixedReducer = (initialState) => (state = initialState) => state;

describe('Celestial passes context menu', () => {
    it('opens property editing for the matching monitored celestial', async () => {
        const store = configureStore({
            reducer: {
                celestial: fixedReducer({
                    passesTableColumnVisibility: {},
                    passesTablePageSize: 10,
                    passesTableSortModel: [],
                }),
                celestialMonitored: fixedReducer({ monitored: [] }),
                trackerInstances: fixedReducer({ instances: [] }),
                targetSatTrack: fixedReducer({ trackingState: {}, trackerViews: {} }),
                preferences: fixedReducer({
                    preferences: [
                        { name: 'timezone', value: 'UTC' },
                        { name: 'locale', value: 'en-US' },
                    ],
                }),
            },
        });
        const monitored = {
            id: 'monitored-mars',
            targetKey: 'body:mars',
            targetType: 'body',
            displayName: 'Mars',
            bodyId: 'mars',
            enabled: true,
            projectionPastHours: 6,
            projectionFutureHours: 72,
            projectionStepMinutes: 30,
        };

        render(
            <Provider store={store}>
                <ThemeProvider theme={setupTheme()}>
                    <CelestialPasses
                        passes={[{
                            id: 'mars-pass',
                            target_key: 'body:mars',
                            target_type: 'body',
                            body_id: 'mars',
                            name: 'Mars',
                            event_start: '2026-09-28T10:00:00Z',
                            event_end: '2026-09-28T11:00:00Z',
                            peak_time: '2026-09-28T10:30:00Z',
                        }]}
                        monitoredRows={[monitored]}
                    />
                </ThemeProvider>
            </Provider>,
        );

        fireEvent.contextMenu(screen.getByTestId('pass-row-mars-pass'), {
            clientX: 100,
            clientY: 120,
        });
        const menuItems = await screen.findAllByRole('menuitem');
        expect(menuItems[2]).toHaveAccessibleName('Edit properties...');
        expect(screen.getByTestId('EditOutlinedIcon')).toBeInTheDocument();
        fireEvent.click(menuItems[2]);

        expect(await screen.findByRole('dialog', { name: 'Edit monitored celestial' })).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveValue('Mars');
        expect(screen.getByRole('textbox', { name: 'Body ID' })).toHaveValue('mars');
        expect(screen.getByRole('textbox', { name: 'Color' })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Past duration' })).toHaveTextContent('6h');
        expect(screen.getByRole('combobox', { name: 'Future duration' })).toHaveTextContent('72h');
        expect(screen.getByRole('combobox', { name: 'Sample interval' })).toHaveTextContent('30m');
    });

    it('opens the ephemeris vector data from the pass context menu', async () => {
        socket.emit.mockImplementation((_event, request, acknowledge) => {
            if (request.cmd === 'get-celestial-vector-snapshot-history') {
                acknowledge({
                    success: true,
                    data: {
                        target_key: 'body:mars',
                        now_utc: '2026-09-29T10:00:00Z',
                        snapshots: [],
                    },
                });
            }
        });
        const store = configureStore({
            reducer: {
                celestial: fixedReducer({
                    passesTableColumnVisibility: {},
                    passesTablePageSize: 10,
                    passesTableSortModel: [],
                }),
                celestialMonitored: fixedReducer({ monitored: [] }),
                trackerInstances: fixedReducer({ instances: [] }),
                targetSatTrack: fixedReducer({ trackingState: {}, trackerViews: {} }),
                preferences: fixedReducer({ preferences: [] }),
            },
        });
        const monitored = {
            id: 'monitored-mars',
            targetKey: 'body:mars',
            targetType: 'body',
            displayName: 'Mars',
            bodyId: 'mars',
            projectionPastHours: 6,
            projectionFutureHours: 72,
            projectionStepMinutes: 30,
        };

        render(
            <Provider store={store}>
                <ThemeProvider theme={setupTheme()}>
                    <CelestialPasses
                        passes={[{
                            id: 'mars-vector-pass',
                            target_key: 'body:mars',
                            target_type: 'body',
                            body_id: 'mars',
                            name: 'Mars',
                            event_start: '2026-09-29T10:00:00Z',
                            event_end: '2026-09-29T11:00:00Z',
                            peak_time: '2026-09-29T10:30:00Z',
                        }]}
                        monitoredRows={[monitored]}
                    />
                </ThemeProvider>
            </Provider>,
        );

        fireEvent.contextMenu(screen.getByTestId('pass-row-mars-vector-pass'), {
            clientX: 100,
            clientY: 120,
        });
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Vector details...' }));

        expect(await screen.findByText('Vector data · Mars')).toBeInTheDocument();
        await waitFor(() => expect(socket.emit).toHaveBeenCalledWith(
            'api.call',
            {
                cmd: 'get-celestial-vector-snapshot-history',
                data: {
                    target_key: 'body:mars',
                    limit: 24,
                    past_hours: 6,
                    future_hours: 72,
                    step_minutes: 30,
                },
            },
            expect.any(Function),
        ));
    });

    it('preserves the selected page when live rows are replaced', async () => {
        const store = configureStore({
            reducer: {
                celestial: fixedReducer({
                    passesTableColumnVisibility: {},
                    passesTablePageSize: 10,
                    passesTableSortModel: [],
                }),
                celestialMonitored: fixedReducer({ monitored: [] }),
                trackerInstances: fixedReducer({ instances: [] }),
                targetSatTrack: fixedReducer({ trackingState: {}, trackerViews: {} }),
                preferences: fixedReducer({ preferences: [] }),
            },
        });
        const passes = Array.from({ length: 25 }, (_, index) => ({
            id: `pass-${index}`,
            target_key: `body:target-${index}`,
            target_type: 'body',
            body_id: `target-${index}`,
            name: `Target ${index}`,
            event_start: '2026-09-29T10:00:00Z',
            event_end: '2026-09-29T10:30:00Z',
            peak_time: '2026-09-29T10:15:00Z',
        }));
        const renderTable = (rows) => (
            <Provider store={store}>
                <ThemeProvider theme={setupTheme()}>
                    <CelestialPasses passes={rows} />
                </ThemeProvider>
            </Provider>
        );
        const view = render(renderTable(passes));

        act(() => latestDataGridProps.current.slotProps.basePagination.onPageChange(null, 1));
        await waitFor(() => expect(latestDataGridProps.current.paginationModel.page).toBe(1));

        view.rerender(renderTable(passes.map((pass) => ({ ...pass }))));

        await waitFor(() => expect(latestDataGridProps.current.paginationModel.page).toBe(1));

        view.rerender(renderTable(passes.slice(0, 5)));

        await waitFor(() => expect(latestDataGridProps.current.paginationModel.page).toBe(0));
    });
});
