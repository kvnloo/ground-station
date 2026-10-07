/**
 * @license
 * Copyright (c) 2026 Efstratios Goudelis
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {maplibregl} from './maplibre.js';

export const MAPLIBRE_COVERAGE_PADDING = Object.freeze({
    top: 40,
    right: 40,
    bottom: 72,
    left: 40,
});

export const MAPLIBRE_GLOBE_COVERAGE_PADDING = Object.freeze({
    top: 48,
    right: 48,
    bottom: 88,
    left: 48,
});

const MAPLIBRE_MAX_FIT_BOUNDS_LAT = 85.051129;

const normalizeCoveragePoint = (point) => {
    const lat = Number(Array.isArray(point) ? point[0] : point?.lat);
    const lon = Number(Array.isArray(point) ? point[1] : point?.lon ?? point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return null;
    return [lat, lon];
};

/**
 * Fits a MapLibre camera to a satellite footprint. Both the tracking page and
 * satellite information maps use this function so padding, pole handling, and
 * world-copy behavior stay identical.
 */
export const fitMapLibreCoverage = ({map, coverage, globe = false}) => {
    if (!map || !Array.isArray(coverage)) return false;
    const fitBoundsPoints = coverage
        .map(normalizeCoveragePoint)
        .filter(Boolean)
        .map(([lat, lon]) => [
            lon,
            Math.max(-MAPLIBRE_MAX_FIT_BOUNDS_LAT, Math.min(MAPLIBRE_MAX_FIT_BOUNDS_LAT, lat)),
        ]);
    if (fitBoundsPoints.length < 2) return false;

    try {
        const bounds = fitBoundsPoints.reduce(
            (current, point) => current.extend(point),
            new maplibregl.LngLatBounds(fitBoundsPoints[0], fitBoundsPoints[0]),
        );
        map.fitBounds(bounds, {
            padding: globe ? MAPLIBRE_GLOBE_COVERAGE_PADDING : MAPLIBRE_COVERAGE_PADDING,
            animate: globe,
            duration: globe ? 280 : 0,
        });
        return true;
    } catch (error) {
        console.warn('Satellite coverage fitBounds skipped due to invalid bounds:', error);
        return false;
    }
};
