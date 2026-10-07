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
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {configureStore} from '@reduxjs/toolkit';
import {Provider} from 'react-redux';
import {createTheme, ThemeProvider} from '@mui/material/styles';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import SatelliteMapContainer from './satellite-map.jsx';

const mapMocks = vi.hoisted(() => ({
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
    getZoom: vi.fn(() => 2),
    isStyleLoaded: vi.fn(() => true),
    getProjection: vi.fn(() => ({type: 'mercator'})),
    getContainer: vi.fn(() => ({clientWidth: 700, clientHeight: 352})),
    on: vi.fn(),
    off: vi.fn(),
    resize: vi.fn(),
    mapProps: null,
}));

vi.mock('react-map-gl/maplibre', async () => {
    const ReactModule = await import('react');
    const Map = ({ref, children, ...props}) => {
        mapMocks.mapProps = props;
        ReactModule.useEffect(() => {
            ref?.({getMap: () => mapMocks});
        }, [ref]);
        return <div data-testid="maplibre-map">{children}</div>;
    };
    const Source = ({id, children}) => <div data-testid={id}>{children}</div>;
    const Layer = ({id, paint}) => <div data-testid={id} data-paint={JSON.stringify(paint)} />;
    const Marker = ({children}) => <div>{children}</div>;
    const Popup = ({children, className}) => <div data-testid="map-popup" className={className}><div className="maplibregl-popup-content">{children}</div></div>;
    return {default: Map, Source, Layer, Marker, Popup};
});

const satelliteData = {
    norad_id: 25544,
    name: 'ISS',
    tle1: '1 25544U 98067A   24001.50000000  .00016717  00000-0  30173-3 0  9991',
    tle2: '2 25544  51.6416  20.0000 0005000 120.0000 240.0000 15.50000000430000',
};

const liveOrbit = {
    available: true,
    source: 'tle',
    generatedAt: '2024-01-01T12:05:00.000Z',
    position: {lat: 15, lon: 25, alt: 420000, vel: 7.6},
};

const theme = createTheme({palette: {border: {light: '#333333'}}});

const renderMap = (overrides = {}) => {
    const targetSatTrack = {
        mapEngine: 'maplibre',
        tileLayerID: 'osm',
        mapZoomLevel: 3,
        orbitProjectionDuration: 5,
        lockOnTarget: true,
        enableMapDragging: true,
        enableMapZooming: true,
        showPastOrbitPath: true,
        showFutureOrbitPath: true,
        showSatelliteCoverage: true,
        showSunIcon: false,
        showMoonIcon: false,
        showTerminatorLine: false,
        showTooltip: false,
        showGrid: false,
        pastOrbitLineColor: '#112233',
        futureOrbitLineColor: '#445566',
        satelliteCoverageColor: '#778899',
        ...overrides,
    };
    const store = configureStore({
        reducer: () => ({targetSatTrack, location: {location: {lat: 38, lon: 24}}}),
    });
    render(
        <Provider store={store}>
            <ThemeProvider theme={theme}>
                <div className="MuiDialog-paper">
                    <SatelliteMapContainer satelliteData={satelliteData} liveOrbit={liveOrbit} />
                </div>
            </ThemeProvider>
        </Provider>,
    );
};

describe('satellite information map', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mapMocks.mapProps = null;
    });

    it('uses tracking map settings and the tracking coverage fit', async () => {
        renderMap();

        expect(screen.getByTestId('maplibre-map')).toBeInTheDocument();
        const attributionBar = screen.getByRole('link', {name: 'MapLibre'}).closest('.MuiPaper-root');
        expect(screen.getByTestId('maplibre-map').parentElement?.nextElementSibling).toBe(attributionBar);
        expect(attributionBar).toHaveStyle({position: 'static'});
        expect(screen.getByTestId('satellite-dialog-future-line')).toHaveAttribute('data-paint', expect.stringContaining('#445566'));
        expect(screen.getByTestId('satellite-dialog-coverage-fill')).toHaveAttribute('data-paint', expect.stringContaining('#778899'));
        expect(screen.getByTestId('satellite-dialog-marker')).toHaveStyle({
            width: '12px',
            height: '12px',
            background: '#38bdf8',
            transform: 'rotate(45deg)',
        });
        expect(screen.queryByTestId('satellite-dialog-grid')).not.toBeInTheDocument();
        expect(mapMocks.mapProps.dragPan).toBe(true);
        expect(mapMocks.mapProps.scrollZoom).toBe(true);
        expect(mapMocks.mapProps.mapStyle.sources.basemap.tiles[0]).toContain('openstreetmap.org');
        await waitFor(() => expect(mapMocks.fitBounds).toHaveBeenCalled());
        expect(mapMocks.fitBounds.mock.calls.at(-1)[1]).toEqual({
            padding: {top: 11, right: 11, bottom: 11, left: 11},
            animate: false,
            duration: 0,
        });

        const fitCountBeforeDialogSettles = mapMocks.fitBounds.mock.calls.length;
        fireEvent.transitionEnd(screen.getByTestId('maplibre-map').closest('.MuiDialog-paper'));
        await waitFor(() => expect(mapMocks.fitBounds.mock.calls.length).toBeGreaterThan(fitCountBeforeDialogSettles));
        expect(mapMocks.resize).toHaveBeenCalled();
    });

    it('centers on the satellite when coverage is disabled', async () => {
        renderMap({showSatelliteCoverage: false});

        expect(screen.queryByTestId('satellite-dialog-coverage')).not.toBeInTheDocument();
        await waitFor(() => expect(mapMocks.flyTo).toHaveBeenCalledWith({
            center: [25, 15],
            zoom: 2,
            animate: false,
        }));
        expect(mapMocks.fitBounds).not.toHaveBeenCalled();
    });

    it('fits visible coverage even when target locking is disabled', async () => {
        renderMap({lockOnTarget: false, mapZoomLevel: 8});

        expect(mapMocks.mapProps.initialViewState.zoom).toBe(0);
        await waitFor(() => expect(mapMocks.fitBounds).toHaveBeenCalled());
        expect(mapMocks.flyTo).not.toHaveBeenCalled();
    });

    it('uses the 2D projection when tracking is configured as a globe', () => {
        renderMap({mapEngine: 'maplibre-globe'});

        expect(screen.getByTestId('maplibre-map')).toBeInTheDocument();
        expect(mapMocks.mapProps.projection).toEqual({type: 'mercator'});
    });

    it('applies the themed Earth View popup class', () => {
        renderMap({showTooltip: true});

        expect(screen.getByTestId('map-popup')).toHaveClass('satellite-dialog-popup');
        expect(screen.getByTestId('map-popup').querySelector('.maplibregl-popup-content')).toBeInTheDocument();
    });
});
