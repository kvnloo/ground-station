import { describe, expect, it } from 'vitest';
import {
  calculatePathDistanceAu,
  calculatePerpendicularPathCap,
  calculateTargetPathViewport,
  collectLiveTrackedTargetKeys,
  doesPolylineIntersectBox,
  shouldSuppressStaticSolarBody,
  shouldShowTrackedLabel,
  splitOrbitSamplesAtTime,
} from '../solarsystem-canvas.jsx';

describe('solar system path endpoint markers', () => {
  it('builds a centered cap perpendicular to the path start', () => {
    expect(calculatePerpendicularPathCap(10, 20, 20, 20, 8)).toEqual({
      fromX: 10,
      fromY: 16,
      toX: 10,
      toY: 24,
    });
  });

  it('detects when a trajectory crosses a padded label box', () => {
    const labelBox = { x: 10, y: 10, w: 20, h: 10 };

    expect(doesPolylineIntersectBox([[0, 15], [40, 15]], labelBox, 2)).toBe(true);
    expect(doesPolylineIntersectBox([[0, 5], [40, 5]], labelBox, 2)).toBe(false);
  });
});

describe('solar system tracked labels', () => {
  it('only shows unfocused labels when explicitly enabled', () => {
    expect(shouldShowTrackedLabel({ isSelected: true, isDimmed: false, showTrackedLabels: true, showUnfocusedLabels: false })).toBe(true);
    expect(shouldShowTrackedLabel({ isSelected: false, isDimmed: true, showTrackedLabels: true, showUnfocusedLabels: false })).toBe(false);
    expect(shouldShowTrackedLabel({ isSelected: false, isDimmed: true, showTrackedLabels: true, showUnfocusedLabels: true })).toBe(true);
  });
});

describe('solar system live path split', () => {
  const samples = [
    [0, 0, 0],
    [10, 10, 0],
    [20, 0, 0],
  ];
  const times = [
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:10:00Z',
    '2026-01-01T00:20:00Z',
  ];

  it('interpolates the solid-to-dotted boundary at the live timestamp', () => {
    expect(splitOrbitSamplesAtTime(samples, times, '2026-01-01T00:15:00Z')).toEqual({
      pastSamples: [samples[0], samples[1], [15, 5, 0]],
      futureSamples: [[15, 5, 0], samples[2]],
    });
  });

  it('shares an exact sample between the past and future segments', () => {
    expect(splitOrbitSamplesAtTime(samples, times, '2026-01-01T00:10:00Z')).toEqual({
      pastSamples: [samples[0], samples[1]],
      futureSamples: [samples[1], samples[2]],
    });
  });
});

describe('solar system endpoint path distances', () => {
  it('sums the sampled three-dimensional trajectory', () => {
    expect(calculatePathDistanceAu([
      [0, 0, 0],
      [3, 4, 0],
      [3, 4, 12],
    ])).toBe(17);
  });

  it('measures from the interpolated live split point', () => {
    const samples = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ];
    const times = [
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:10:00Z',
      '2026-01-01T00:20:00Z',
    ];
    const { pastSamples, futureSamples } = splitOrbitSamplesAtTime(
      samples,
      times,
      '2026-01-01T00:15:00Z',
    );

    expect(calculatePathDistanceAu(pastSamples)).toBe(15);
    expect(calculatePathDistanceAu(futureSamples)).toBe(5);
  });
});

describe('solar system target path fitting', () => {
  it('zooms short projected paths using their actual bounds', () => {
    const viewport = calculateTargetPathViewport({
      points: [
        [5, 1, 0],
        [5.001, 1, 0],
      ],
      width: 800,
      height: 600,
    });

    expect(viewport.zoom).toBeCloseTo(576000);
    expect(viewport.panX).toBeCloseTo(-5.0005 * viewport.zoom);
    expect(viewport.panY).toBeCloseTo(viewport.zoom);
  });

  it('uses the changing axis for a vertical path', () => {
    const viewport = calculateTargetPathViewport({
      points: [
        [5, 1, 0],
        [5, 1.002, 0],
      ],
      width: 800,
      height: 600,
    });

    expect(viewport.zoom).toBeCloseTo(216000);
  });
});

describe('solar system monitored body ownership', () => {
  it('suppresses a static marker when the same live target is rendered', () => {
    const liveKeys = collectLiveTrackedTargetKeys([
      { target_key: 'body:io', position_xyz_au: [1, 2, 3] },
      { target_key: 'body:europa', position_xyz_au: null },
    ]);

    expect(shouldSuppressStaticSolarBody({ target_key: 'body:io' }, liveKeys)).toBe(true);
    expect(shouldSuppressStaticSolarBody({ target_key: 'body:europa' }, liveKeys)).toBe(false);
    expect(shouldSuppressStaticSolarBody({ target_key: 'body:io' }, liveKeys, false)).toBe(false);
  });
});
