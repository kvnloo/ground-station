import { useEffect, useSyncExternalStore } from 'react';
import { useAudio } from '../dashboard/audio-provider.jsx';

const EMPTY_SQUELCH_STATE = Object.freeze({
    1: null,
    2: null,
    3: null,
    4: null,
});
const POLL_INTERVAL_MS = 250;

let squelchState = EMPTY_SQUELCH_STATE;
let pollIntervalId = null;
const listeners = new Set();
const readers = new Map();

const statesMatch = (current, next) => (
    current[1] === next[1] &&
    current[2] === next[2] &&
    current[3] === next[3] &&
    current[4] === next[4]
);

const pollSquelchState = () => {
    const getVfoSquelchDebug = readers.keys().next().value;
    if (!getVfoSquelchDebug) {
        return;
    }

    const nextState = { 1: null, 2: null, 3: null, 4: null };
    for (let vfoNumber = 1; vfoNumber <= 4; vfoNumber += 1) {
        const debug = getVfoSquelchDebug(vfoNumber);
        if (debug && typeof debug.gate_open === 'boolean') {
            nextState[vfoNumber] = Boolean(debug.gate_open);
        }
    }

    // The state object is the useSyncExternalStore snapshot. Retaining it when
    // gates have not changed prevents React from scheduling consumer updates.
    if (statesMatch(squelchState, nextState)) {
        return;
    }

    squelchState = Object.freeze(nextState);
    listeners.forEach((listener) => listener());
};

const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

const getSnapshot = () => squelchState;

/**
 * Shares one audio-diagnostic poller across the VFO controls and marker canvas.
 * Consumers only rerender when at least one gate changes state.
 */
export const useVfoSquelchState = () => {
    const { getVfoSquelchDebug } = useAudio();

    useEffect(() => {
        readers.set(getVfoSquelchDebug, (readers.get(getVfoSquelchDebug) || 0) + 1);
        pollSquelchState();

        if (pollIntervalId === null) {
            pollIntervalId = window.setInterval(pollSquelchState, POLL_INTERVAL_MS);
        }

        return () => {
            const readerCount = readers.get(getVfoSquelchDebug) || 0;
            if (readerCount <= 1) {
                readers.delete(getVfoSquelchDebug);
            } else {
                readers.set(getVfoSquelchDebug, readerCount - 1);
            }
            if (readers.size === 0 && pollIntervalId !== null) {
                window.clearInterval(pollIntervalId);
                pollIntervalId = null;
            }
        };
    }, [getVfoSquelchDebug]);

    return {
        vfoSquelchOpen: useSyncExternalStore(subscribe, getSnapshot, getSnapshot),
    };
};
