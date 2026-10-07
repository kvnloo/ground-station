/**
 * @license
 * Copyright (c) 2026 Efstratios Goudelis
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {maplibregl} from '../common/maplibre.js';

const MAX_MERCATOR_LATITUDE = 85.051129;
const MIN_DIALOG_PADDING = 4;
const MAX_DIALOG_PADDING = 12;
const COVERAGE_EDGE_SAFETY_PX = 4;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

const normalizeCoveragePoint = (point) => {
    const lat = Number(Array.isArray(point) ? point[0] : point?.lat);
    const lon = Number(Array.isArray(point) ? point[1] : point?.lon ?? point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return null;
    return [clamp(lat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE), lon];
};

const mercatorY = (latitude) => {
    const radians = latitude * Math.PI / 180;
    return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
};

const getContainerSize = (map) => {
    const container = map?.getContainer?.();
    const mapSize = map?.getSize?.();
    const width = Number(container?.clientWidth ?? container?.offsetWidth ?? mapSize?.x);
    const height = Number(container?.clientHeight ?? container?.offsetHeight ?? mapSize?.y);
    return {
        width: Number.isFinite(width) && width > 0 ? width : 0,
        height: Number.isFinite(height) && height > 0 ? height : 0,
    };
};

const getBasePadding = ({width, height}) => {
    const shortestSide = Math.min(width || 320, height || 240);
    return clamp(Math.round(shortestSide * 0.03), MIN_DIALOG_PADDING, MAX_DIALOG_PADDING);
};

/**
 * MapLibre keeps the Mercator world filling the viewport vertically. When a
 * footprint is almost world-height, fixed padding makes fitBounds request an
 * impossible zoom and MapLibre zooms back in, clipping the footprint. Limit
 * vertical padding to the geographic space that is actually available.
 */
export const getDialogMapLibreCoveragePadding = ({map, coverage}) => {
    const size = getContainerSize(map);
    const basePadding = getBasePadding(size);
    const points = (Array.isArray(coverage) ? coverage : []).map(normalizeCoveragePoint).filter(Boolean);
    if (points.length < 2 || size.height === 0) {
        return {top: basePadding, right: basePadding, bottom: basePadding, left: basePadding};
    }

    const projectedY = points.map(([lat]) => mercatorY(lat));
    const projectedSpan = clamp(Math.max(...projectedY) - Math.min(...projectedY), 0, 1);
    const spareVerticalPixels = size.height * (1 - projectedSpan);
    const supportedVerticalPadding = Math.max(
        0,
        Math.floor((spareVerticalPixels - COVERAGE_EDGE_SAFETY_PX) / 2),
    );
    const verticalPadding = Math.min(basePadding, supportedVerticalPadding);

    return {
        top: verticalPadding,
        right: basePadding,
        bottom: verticalPadding,
        left: basePadding,
    };
};

export const getDialogLeafletCoveragePadding = (map) => {
    const padding = getBasePadding(getContainerSize(map));
    return [padding, padding];
};

export const fitDialogMapLibreCoverage = ({map, coverage}) => {
    if (!map || !Array.isArray(coverage)) return false;
    const points = coverage.map(normalizeCoveragePoint).filter(Boolean);
    if (points.length < 2) return false;

    try {
        const lngLatPoints = points.map(([lat, lon]) => [lon, lat]);
        const bounds = lngLatPoints.reduce(
            (current, point) => current.extend(point),
            new maplibregl.LngLatBounds(lngLatPoints[0], lngLatPoints[0]),
        );
        map.fitBounds(bounds, {
            padding: getDialogMapLibreCoveragePadding({map, coverage: points}),
            animate: false,
            duration: 0,
        });
        return true;
    } catch (error) {
        console.warn('Dialog satellite coverage fitBounds skipped due to invalid bounds:', error);
        return false;
    }
};
