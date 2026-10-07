import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    calculateLiveOrbitSnapshot,
    createSatelliteRecord,
    propagateSatelliteRecord,
    useSatelliteLiveOrbit,
} from './liveorbit.js';

const tleSatellite = {
    norad_id: 25544,
    orbit_model_kind: 'tle',
    orbit_central_body: 'earth',
    tle1: '1 25544U 98067A   24001.50000000  .00016717  00000-0  30230-3 0  9995',
    tle2: '2 25544  51.6416  20.0000 0005000  30.0000  45.0000 15.50000000432109',
};

const ommSatellite = {
    norad_id: 28492,
    orbit_model_kind: 'omm',
    orbit_central_body: 'earth',
    orbit_payload: {
        OBJECT_NAME: 'HELIOS 2A',
        OBJECT_ID: '2004-049A',
        EPOCH: '2025-03-26T05:19:34.116960',
        MEAN_MOTION: '15.00555103',
        ECCENTRICITY: '0.000583',
        INCLINATION: '98.3164',
        RA_OF_ASC_NODE: '103.8411',
        ARG_OF_PERICENTER: '20.5667',
        MEAN_ANOMALY: '339.5789',
        EPHEMERIS_TYPE: '0',
        CLASSIFICATION_TYPE: 'U',
        NORAD_CAT_ID: '28492',
        ELEMENT_SET_NO: '999',
        REV_AT_EPOCH: '8655',
        BSTAR: '0.00048021',
        MEAN_MOTION_DOT: '0.00005995',
        MEAN_MOTION_DDOT: '0',
    },
};

describe('shared satellite live orbit propagation', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('propagates TLE position and station-relative angles in app units', () => {
        const orbit = createSatelliteRecord(tleSatellite);
        const position = propagateSatelliteRecord(
            orbit.record,
            new Date('2024-01-01T12:05:00Z'),
            { lat: 37.9838, lon: 23.7275, alt: 100 },
        );

        expect(orbit.source).toBe('tle');
        expect(position).toEqual(expect.objectContaining({
            lat: expect.any(Number),
            lon: expect.any(Number),
            alt: expect.any(Number),
            vel: expect.any(Number),
            az: expect.any(Number),
            el: expect.any(Number),
            range: expect.any(Number),
        }));
        expect(position.alt).toBeGreaterThan(100000);
        expect(position.vel).toBeGreaterThan(1);
    });

    it('uses native OMM elements when no TLE lines are present', () => {
        const orbit = createSatelliteRecord(ommSatellite);
        const snapshot = calculateLiveOrbitSnapshot({
            record: orbit.record,
            source: orbit.source,
            date: new Date('2025-03-26T05:25:00Z'),
            observer: { lat: 0, lon: 0, alt: 0 },
        });

        expect(orbit.source).toBe('omm');
        expect(snapshot.available).toBe(true);
        expect(snapshot.position.alt).toBeGreaterThan(100000);
    });

    it('rejects orbital elements for a non-Earth central body', () => {
        expect(createSatelliteRecord({ ...tleSatellite, orbit_central_body: 'moon' })).toEqual(
            expect.objectContaining({ record: null, source: null }),
        );
    });

    it('refreshes the live position once per second while mounted', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-01T12:05:00Z'));
        const { result, unmount } = renderHook(() => useSatelliteLiveOrbit(tleSatellite));
        const firstTimestamp = result.current.generatedAt;

        act(() => {
            vi.advanceTimersByTime(1000);
        });

        expect(firstTimestamp).toBe('2024-01-01T12:05:00.000Z');
        expect(result.current.generatedAt).toBe('2024-01-01T12:05:01.000Z');
        unmount();
    });
});
