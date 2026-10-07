/**
 * @license
 * Copyright (c) 2026 Efstratios Goudelis
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, it, vi} from 'vitest';
import {getSatelliteCoverageCircle} from '../common/tracking-logic.jsx';
import {
    fitDialogMapLibreCoverage,
    getDialogLeafletCoveragePadding,
    getDialogMapLibreCoveragePadding,
} from './dialogcoveragefit.js';

describe('satellite dialog coverage camera fit', () => {
    it('uses compact padding that a short dialog map can honor for GEO coverage', () => {
        const map = {
            getContainer: () => ({clientWidth: 700, clientHeight: 352}),
        };
        const coverage = getSatelliteCoverageCircle(0, 20, 35786, 360);

        const padding = getDialogMapLibreCoveragePadding({map, coverage});
        const projectedY = coverage.map(({lat}) => {
            const clampedLatitude = Math.min(85.051129, Math.max(-85.051129, lat));
            const radians = clampedLatitude * Math.PI / 180;
            return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
        });
        const spareVerticalPixels = 352 * (1 - (Math.max(...projectedY) - Math.min(...projectedY)));

        expect(padding).toEqual({top: 11, right: 11, bottom: 11, left: 11});
        expect(padding.top + padding.bottom + 4).toBeLessThanOrEqual(spareVerticalPixels);
    });

    it('reduces vertical padding when a footprint reaches a Mercator pole', () => {
        const map = {
            getContainer: () => ({clientWidth: 700, clientHeight: 352}),
        };
        const coverage = [
            {lat: 90, lon: -80},
            {lat: 90, lon: 80},
            {lat: -84.9, lon: 80},
            {lat: -84.9, lon: -80},
        ];

        const padding = getDialogMapLibreCoveragePadding({map, coverage});

        expect(padding.top).toBeLessThan(padding.left);
        expect(padding.bottom).toBe(padding.top);
    });

    it('fits with the dialog padding instead of the tracking-page padding', () => {
        const map = {
            getContainer: () => ({clientWidth: 700, clientHeight: 352}),
            fitBounds: vi.fn(),
        };
        const coverage = getSatelliteCoverageCircle(0, 20, 35786, 360);

        expect(fitDialogMapLibreCoverage({map, coverage})).toBe(true);
        expect(map.fitBounds).toHaveBeenCalledWith(expect.anything(), {
            padding: {top: 11, right: 11, bottom: 11, left: 11},
            animate: false,
            duration: 0,
        });
    });

    it('uses the compact canvas size for Leaflet padding', () => {
        const map = {getSize: () => ({x: 700, y: 352})};
        expect(getDialogLeafletCoveragePadding(map)).toEqual([11, 11]);
    });
});
