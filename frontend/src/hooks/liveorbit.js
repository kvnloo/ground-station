/**
 * @license
 * Copyright (c) 2026 Efstratios Goudelis
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 */

import { useEffect, useMemo, useState } from 'react';
import * as satellite from 'satellite.js';

const DEFAULT_UPDATE_INTERVAL_MS = 1000;

const emptyLiveOrbit = (error = '') => ({
    available: false,
    source: null,
    position: null,
    generatedAt: null,
    error,
});

const parseOmmPayload = (payload) => {
    if (!payload) return null;
    if (typeof payload === 'string') {
        const parsed = JSON.parse(payload);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    }
    return typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
};

const isUsableRecord = (record) => record && !record.error;

export const createSatelliteRecord = (satelliteData = {}) => {
    const centralBody = String(satelliteData?.orbit_central_body || 'earth').trim().toLowerCase();
    if (centralBody !== 'earth') {
        return { record: null, source: null, error: `Unsupported central body: ${centralBody}` };
    }

    const modelKind = String(
        satelliteData?.orbit_model_kind || satelliteData?.orbit_format || 'tle'
    ).trim().toLowerCase();
    const tle1 = String(satelliteData?.tle1 || '').trim();
    const tle2 = String(satelliteData?.tle2 || '').trim();

    const createFromOmm = () => {
        const payload = parseOmmPayload(satelliteData?.orbit_payload);
        if (!payload) return null;
        const record = satellite.json2satrec(payload);
        return isUsableRecord(record) ? { record, source: 'omm' } : null;
    };
    const createFromTle = () => {
        if (!tle1 || !tle2) return null;
        const record = satellite.twoline2satrec(tle1, tle2);
        return isUsableRecord(record) ? { record, source: 'tle' } : null;
    };

    try {
        // Prefer the canonical database model while retaining TLE compatibility
        // for migrated OMM rows that still include representable TLE lines.
        const result = modelKind === 'omm'
            ? (createFromOmm() || createFromTle())
            : (createFromTle() || createFromOmm());
        return result || { record: null, source: null, error: 'No usable TLE or OMM elements' };
    } catch (error) {
        return { record: null, source: null, error: error?.message || 'Invalid orbital elements' };
    }
};

export const propagateSatelliteRecord = (record, date, observer = null) => {
    if (!record || !(date instanceof Date) || Number.isNaN(date.getTime())) return null;

    try {
        const propagated = satellite.propagate(record, date);
        if (!propagated?.position || !propagated?.velocity || record.error) return null;

        const gmst = satellite.gstime(date);
        const geodetic = satellite.eciToGeodetic(propagated.position, gmst);
        const lat = satellite.degreesLat(geodetic.latitude);
        const lon = satellite.degreesLong(geodetic.longitude);
        const altitudeKm = geodetic.height;
        const velocity = Math.hypot(
            propagated.velocity.x,
            propagated.velocity.y,
            propagated.velocity.z,
        );
        if (![lat, lon, altitudeKm, velocity].every(Number.isFinite)) return null;

        const position = {
            lat,
            lon,
            // Satellite position payloads use metres for altitude elsewhere in the app.
            alt: altitudeKm * 1000,
            vel: velocity,
        };

        const observerLat = Number(observer?.lat);
        const observerLon = Number(observer?.lon);
        if (Number.isFinite(observerLat) && Number.isFinite(observerLon)) {
            const observerAltitudeMetres = Number(observer?.alt ?? observer?.altitude ?? 0);
            const observerGeodetic = {
                latitude: satellite.degreesToRadians(observerLat),
                longitude: satellite.degreesToRadians(observerLon),
                height: Number.isFinite(observerAltitudeMetres) ? observerAltitudeMetres / 1000 : 0,
            };
            const positionEcf = satellite.eciToEcf(propagated.position, gmst);
            const lookAngles = satellite.ecfToLookAngles(observerGeodetic, positionEcf);
            const azimuth = satellite.radiansToDegrees(lookAngles.azimuth);
            position.az = ((azimuth % 360) + 360) % 360;
            position.el = satellite.radiansToDegrees(lookAngles.elevation);
            position.range = lookAngles.rangeSat;
        }

        return position;
    } catch {
        return null;
    }
};

export const calculateLiveOrbitSnapshot = ({
    record,
    source,
    date,
    observer,
}) => {
    const position = propagateSatelliteRecord(record, date, observer);
    if (!position) return emptyLiveOrbit('Orbital propagation failed');
    return {
        available: true,
        source,
        position,
        generatedAt: date.toISOString(),
        error: '',
    };
};

export const useSatelliteLiveOrbit = (satelliteData, {
    enabled = true,
    observer = null,
    updateIntervalMs = DEFAULT_UPDATE_INTERVAL_MS,
} = {}) => {
    const orbitRecord = useMemo(
        () => createSatelliteRecord(satelliteData),
        [
            satelliteData?.norad_id,
            satelliteData?.orbit_central_body,
            satelliteData?.orbit_model_kind,
            satelliteData?.orbit_format,
            satelliteData?.orbit_payload,
            satelliteData?.tle1,
            satelliteData?.tle2,
        ],
    );
    const [liveOrbit, setLiveOrbit] = useState(() => emptyLiveOrbit(orbitRecord.error));
    const observerLat = Number(observer?.lat);
    const observerLon = Number(observer?.lon);
    const observerAlt = Number(observer?.alt ?? observer?.altitude ?? 0);

    useEffect(() => {
        if (!enabled || !orbitRecord.record) {
            setLiveOrbit(emptyLiveOrbit(orbitRecord.error));
            return undefined;
        }

        let stopped = false;
        const update = () => {
            const date = new Date();
            const snapshot = calculateLiveOrbitSnapshot({
                record: orbitRecord.record,
                source: orbitRecord.source,
                date,
                observer: {
                    lat: observerLat,
                    lon: observerLon,
                    alt: observerAlt,
                },
            });
            if (stopped) return;
            setLiveOrbit(snapshot);
        };

        update();
        const interval = window.setInterval(update, updateIntervalMs);
        return () => {
            stopped = true;
            window.clearInterval(interval);
        };
    }, [
        enabled,
        observerAlt,
        observerLat,
        observerLon,
        orbitRecord.error,
        orbitRecord.record,
        orbitRecord.source,
        updateIntervalMs,
    ]);

    return liveOrbit;
};
