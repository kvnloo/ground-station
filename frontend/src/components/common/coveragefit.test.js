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
import {getSatelliteCoverageCircle} from './tracking-logic.jsx';
import {fitMapLibreCoverage, MAPLIBRE_COVERAGE_PADDING} from './coveragefit.js';

describe('shared satellite coverage camera fit', () => {
    it('fits the complete geostationary footprint with tracking-map padding', () => {
        const map = {fitBounds: vi.fn()};
        const coverage = getSatelliteCoverageCircle(0, 20, 35786, 360);

        expect(fitMapLibreCoverage({map, coverage})).toBe(true);
        const [bounds, options] = map.fitBounds.mock.calls[0];
        expect(bounds.getEast() - bounds.getWest()).toBeGreaterThan(150);
        expect(bounds.getNorth() - bounds.getSouth()).toBeGreaterThan(150);
        expect(options).toEqual({
            padding: MAPLIBRE_COVERAGE_PADDING,
            animate: false,
            duration: 0,
        });
    });
});
