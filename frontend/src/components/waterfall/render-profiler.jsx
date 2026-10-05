import { Profiler } from 'react';

const MAX_RENDER_RECORDS = 500;
const PROFILE_KEY = '__groundStationRenderProfile';

const recordRender = (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
    if (typeof window === 'undefined') {
        return;
    }

    const records = window[PROFILE_KEY] || (window[PROFILE_KEY] = []);
    const record = {
        id,
        phase,
        actualDuration,
        baseDuration,
        startTime,
        commitTime,
    };

    records.push(record);
    if (records.length > MAX_RENDER_RECORDS) {
        records.splice(0, records.length - MAX_RENDER_RECORDS);
    }

    // Keep a visible User Timing entry in Chrome's Performance trace while the
    // complete per-commit data remains available from the browser console.
    performance.measure(
        `gs-render:${id} (${actualDuration.toFixed(1)}ms)`,
        { start: startTime, end: commitTime, detail: record }
    );
};

/**
 * Development-only React Profiler boundary for targeted render investigations.
 * Inspect `window.__groundStationRenderProfile` after recording.
 */
export const DevRenderProfiler = ({ id, children }) => {
    if (!import.meta.env.DEV) {
        return children;
    }

    return (
        <Profiler id={id} onRender={recordRender}>
            {children}
        </Profiler>
    );
};
