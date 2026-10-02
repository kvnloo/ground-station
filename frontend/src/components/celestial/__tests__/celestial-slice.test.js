import { describe, expect, it } from 'vitest';
import celestialReducer, {
  fetchTargetCelestialScene,
  fetchSolarSystemScene,
  setCelestialEphemerisStatus,
  setCelestialEphemerisSyncCompleted,
  setCelestialEphemerisSyncFailed,
  setCelestialEphemerisSyncProgress,
  setCelestialEphemerisSyncStarted,
  setTargetCelestialLivePointing,
  setCelestialTracksLive,
  refreshMonitoredCelestialNow,
  upsertCelestialTrackRowsLive,
  upsertSolarSystemBodyLive,
  upsertSolarSystemBodiesLive,
} from '../celestial-slice';

describe('target celestial scenes', () => {
  it('applies progressive solar rows only to the active request', () => {
    const requestArgs = { socket: {}, payload: { allow_network_fetch: true } };
    let state = celestialReducer(
      undefined,
      fetchSolarSystemScene.pending('solar-request', requestArgs),
    );

    state = celestialReducer(state, upsertSolarSystemBodyLive({
      request_id: 'older-request',
      body: { target_key: 'body:mars', name: 'Wrong Mars' },
      progress: { current: 1, total: 2 },
    }));
    expect(state.solarScene).toBeNull();

    state = celestialReducer(state, upsertSolarSystemBodyLive({
      request_id: 'solar-request',
      body: { target_key: 'body:mars', name: 'Mars' },
      progress: { current: 1, total: 2 },
    }));
    state = celestialReducer(state, upsertSolarSystemBodyLive({
      request_id: 'solar-request',
      body: { target_key: 'body:mars', stale: false },
      progress: { current: 2, total: 2 },
    }));

    expect(state.solarScene.planets).toEqual([
      { target_key: 'body:mars', name: 'Mars', stale: false },
    ]);
    expect(state.solarProgress).toEqual({ current: 2, total: 2 });
  });

  it('merges streamed celestial updates in one state transition', () => {
    let state = celestialReducer(undefined, upsertCelestialTrackRowsLive({
      updates: [
        {
          timestamp_utc: '2026-10-02T18:00:00Z',
          row: { target_key: 'body:mars', name: 'Mars' },
          progress: { current: 1, total: 2 },
        },
        {
          timestamp_utc: '2026-10-02T18:00:01Z',
          row: { target_key: 'body:mars', stale: false },
          progress: { current: 2, total: 2 },
        },
        {
          row: { target_key: 'body:venus', name: 'Venus' },
        },
      ],
    }));

    expect(state.celestialTracks.celestial).toEqual([
      { target_key: 'body:mars', name: 'Mars', stale: false },
      { target_key: 'body:venus', name: 'Venus' },
    ]);
    expect(state.celestialTracks.timestamp_utc).toBe('2026-10-02T18:00:01Z');
    expect(state.tracksProgress).toEqual({ current: 2, total: 2 });
  });

  it('ignores an inactive solar request while applying a batch', () => {
    const requestArgs = { socket: {}, payload: { allow_network_fetch: true } };
    let state = celestialReducer(
      undefined,
      fetchSolarSystemScene.pending('solar-request', requestArgs),
    );

    state = celestialReducer(state, upsertSolarSystemBodiesLive({
      updates: [
        {
          request_id: 'older-request',
          body: { target_key: 'body:mars', name: 'Wrong Mars' },
        },
        {
          request_id: 'solar-request',
          body: { target_key: 'body:mars', name: 'Mars' },
          progress: { current: 1, total: 2 },
        },
        {
          request_id: 'solar-request',
          body: { target_key: 'body:venus', name: 'Venus' },
          progress: { current: 2, total: 2 },
        },
      ],
    }));

    expect(state.solarScene.planets).toEqual([
      { target_key: 'body:mars', name: 'Mars' },
      { target_key: 'body:venus', name: 'Venus' },
    ]);
    expect(state.solarProgress).toEqual({ current: 2, total: 2 });
  });

  it('clears live tracks and passes when the backend broadcasts an empty state', () => {
    let state = celestialReducer(undefined, setCelestialTracksLive({
      celestial: [{ target_key: 'body:mars', name: 'Mars' }],
      celestial_passes: [{ id: 'mars-pass', target_key: 'body:mars' }],
    }));

    state = celestialReducer(state, setCelestialTracksLive({
      celestial: [],
      celestial_passes: [],
      observer_bodies: [],
    }));

    expect(state.celestialTracks.celestial).toEqual([]);
    expect(state.celestialTracks.celestial_passes).toEqual([]);
    expect(state.celestialTracks.observer_bodies).toEqual([]);
  });

  it('survive a monitored-target live broadcast', () => {
    const requestKey = 'body:venus:0:24:60';
    const requestArgs = { requestKey, payload: {}, socket: {} };
    let state = celestialReducer(
      undefined,
      fetchTargetCelestialScene.pending('venus-request', requestArgs),
    );

    state = celestialReducer(
      state,
      fetchTargetCelestialScene.fulfilled({
        requestKey,
        solarScene: { planets: [] },
        celestialTracks: {
          celestial: [{ target_key: 'body:venus', name: 'Venus' }],
          celestial_passes: [{ target_key: 'body:venus' }],
        },
      }, 'venus-request', requestArgs),
    );

    state = celestialReducer(state, setCelestialTracksLive({
      celestial: [{ target_key: 'body:mars', name: 'Mars' }],
    }));

    expect(state.celestialTracks.celestial).toEqual([
      { target_key: 'body:mars', name: 'Mars' },
    ]);
    expect(state.targetScenesByKey[requestKey].celestialTracks.celestial).toEqual([
      { target_key: 'body:venus', name: 'Venus' },
    ]);
  });

  it('overlays tracker telemetry onto every cached window for the target', () => {
    const requestKey = 'body:venus:0:24:60';
    const requestArgs = { requestKey, payload: {}, socket: {} };
    let state = celestialReducer(
      undefined,
      fetchTargetCelestialScene.pending('venus-request', requestArgs),
    );
    state = celestialReducer(
      state,
      fetchTargetCelestialScene.fulfilled({
        requestKey,
        solarScene: { planets: [] },
        celestialTracks: {
          timestamp_utc: '2026-01-01T00:00:00Z',
          celestial: [{
            target_key: 'body:venus',
            sky_position: { az_deg: 10, el_deg: 20, ra_deg: 30 },
          }],
          celestial_passes: [{ target_key: 'body:venus' }],
        },
      }, 'venus-request', requestArgs),
    );

    state = celestialReducer(state, setTargetCelestialLivePointing({
      targetKey: 'body:venus',
      azDeg: 105.2,
      elDeg: 0.54,
      timestampUtc: '2026-01-01T00:00:05Z',
    }));

    const tracks = state.targetScenesByKey[requestKey].celestialTracks;
    expect(tracks.timestamp_utc).toBe('2026-01-01T00:00:05Z');
    expect(tracks.celestial[0].sky_position).toEqual({ az_deg: 105.2, el_deg: 0.54, ra_deg: 30 });
    expect(tracks.celestial[0].visibility).toMatchObject({ above_horizon: true, visible: true });
    expect(tracks.celestial_passes).toEqual([{ target_key: 'body:venus' }]);
  });

  it('merges a one-target refresh without replacing the shared timeline or other passes', () => {
    let state = celestialReducer(undefined, setCelestialTracksLive({
      celestial: [
        { target_key: 'body:moon', name: 'Moon', stale: true },
        { target_key: 'body:mars', name: 'Mars' },
      ],
      celestial_passes: [
        { id: 'old-moon-pass', target_key: 'body:moon', event_start: '2026-01-02T00:00:00Z' },
        { id: 'mars-pass', target_key: 'body:mars', event_start: '2026-01-03T00:00:00Z' },
      ],
      meta: {
        projection: { past_hours: 6, future_hours: 24, step_minutes: 60 },
        projection_by_target: {
          'body:moon': { past_hours: 1, future_hours: 24, step_minutes: 60 },
          'body:mars': { past_hours: 1, future_hours: 24, step_minutes: 60 },
        },
        passes: { count: 2 },
      },
    }));

    const requestArgs = { socket: {}, ids: ['moon-id'] };
    state = celestialReducer(state, refreshMonitoredCelestialNow.fulfilled({
      celestial: [{ target_key: 'body:moon', name: 'Moon', stale: false }],
      celestial_passes: [
        { id: 'new-moon-pass', target_key: 'body:moon', event_start: '2026-01-04T00:00:00Z' },
      ],
      meta: {
        projection: { past_hours: 12, future_hours: 72, step_minutes: 10 },
        projection_by_target: {
          'body:moon': { past_hours: 12, future_hours: 72, step_minutes: 10 },
        },
        passes: { count: 1 },
      },
    }, 'moon-refresh', requestArgs));

    expect(state.celestialTracks.celestial).toEqual([
      { target_key: 'body:moon', name: 'Moon', stale: false },
      { target_key: 'body:mars', name: 'Mars' },
    ]);
    expect(state.celestialTracks.celestial_passes).toEqual([
      { id: 'mars-pass', target_key: 'body:mars', event_start: '2026-01-03T00:00:00Z' },
      { id: 'new-moon-pass', target_key: 'body:moon', event_start: '2026-01-04T00:00:00Z' },
    ]);
    expect(state.celestialTracks.meta.projection).toEqual({
      past_hours: 6,
      future_hours: 24,
      step_minutes: 60,
    });
    expect(state.celestialTracks.meta.projection_by_target).toEqual({
      'body:moon': { past_hours: 12, future_hours: 72, step_minutes: 10 },
      'body:mars': { past_hours: 1, future_hours: 24, step_minutes: 60 },
    });
    expect(state.celestialTracks.meta.passes.count).toBe(2);
  });
});

describe('celestial ephemeris synchronization state', () => {
  it('tracks progress and clears a previous error when a new sync succeeds', () => {
    let state = celestialReducer(undefined, setCelestialEphemerisSyncStarted());
    expect(state.ephemerisSync.status).toBe('inprogress');

    state = celestialReducer(state, setCelestialEphemerisSyncProgress({
      percent: 50,
      processed: 2,
      total: 4,
      refreshed: 2,
      failed: 0,
      current_target: { key: 'body:mars', name: 'Mars' },
    }));
    expect(state.ephemerisSync).toMatchObject({
      status: 'inprogress',
      progress: 50,
      processed: 2,
      total: 4,
      currentTarget: { key: 'body:mars', name: 'Mars' },
    });

    state = celestialReducer(state, setCelestialEphemerisSyncFailed({
      error: 'Horizons unavailable',
      result: {
        count: 4,
        refreshed: 2,
        failed: 2,
        provider_status: { availability: 'unavailable' },
      },
    }));
    expect(state.ephemerisSync).toMatchObject({
      status: 'failed',
      error: 'Horizons unavailable',
      failed: 2,
      providerStatus: { availability: 'unavailable' },
    });

    state = celestialReducer(state, setCelestialEphemerisSyncStarted());
    state = celestialReducer(state, setCelestialEphemerisSyncCompleted({
      count: 4,
      refreshed: 4,
      failed: 0,
      provider_status: { availability: 'available' },
    }));
    expect(state.ephemerisSync).toMatchObject({
      status: 'complete',
      progress: 100,
      error: null,
      providerStatus: { availability: 'available' },
    });
  });

  it('applies a failed scheduled sync pushed by the backend', () => {
    const state = celestialReducer(undefined, setCelestialEphemerisStatus({
      provider: { status: { availability: 'unavailable' } },
      sync: {
        state: {
          status: 'complete',
          success: false,
          progress: 100,
          count: 3,
          refreshed: 1,
          failed: 2,
          message: 'Synchronization requires attention.',
        },
      },
    }));

    expect(state.ephemerisSync).toMatchObject({
      status: 'failed',
      total: 3,
      refreshed: 1,
      failed: 2,
      error: 'Synchronization requires attention.',
      providerStatus: { availability: 'unavailable' },
    });
  });
});
