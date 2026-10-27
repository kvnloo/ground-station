import React from 'react';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {configureStore} from '@reduxjs/toolkit';
import {Provider} from 'react-redux';
import {afterEach, describe, expect, it, vi} from 'vitest';
import '../../i18n/config.js';
import MapTitleControls from './map-title-controls.jsx';
import MapToolbar from './map-toolbar.jsx';
import earthViewReducer from './earthview-slice.jsx';
import useMapIslandFullscreen from './use-map-island-fullscreen.js';

const socket = vi.hoisted(() => ({emit: vi.fn()}));
vi.mock('../common/socket.jsx', () => ({useSocket: () => ({socket})}));

function MapIslandHarness({onResize}) {
    const {islandRef, isFullscreen, toggleFullscreen} = useMapIslandFullscreen(onResize);

    return (
        <div ref={islandRef} data-testid="map-island">
            <header>
                <MapTitleControls onSettings={() => {}} />
            </header>
            <MapToolbar homeDisabled={false} followDisabled={true} following={false}
                        onHome={() => {}} onCenter={() => {}} onFitEarth={() => {}}
                        onToggleFollow={() => {}} onZoomIn={() => {}} onZoomOut={() => {}}
                        onFullscreen={toggleFullscreen} isFullscreen={isFullscreen} />
            <div data-testid="map-viewport" />
        </div>
    );
}

describe('Earth View map island controls', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        socket.emit.mockReset();
    });

    const renderIsland = (onResize = vi.fn()) => {
        const store = configureStore({reducer: {earthViewTrack: earthViewReducer}});
        render(<Provider store={store}><MapIslandHarness onResize={onResize} /></Provider>);
        return store;
    };

    it('fullscreens the island from the toolbar and keeps the controls available after Escape', () => {
        let fullscreenElement = null;
        const requestFullscreen = vi.fn(function requestFullscreen() {
            fullscreenElement = this;
            document.dispatchEvent(new Event('fullscreenchange'));
        });
        const exitFullscreen = vi.fn(() => {
            fullscreenElement = null;
            document.dispatchEvent(new Event('fullscreenchange'));
        });
        const originalFullscreenElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
        const originalExitFullscreen = Object.getOwnPropertyDescriptor(document, 'exitFullscreen');
        const originalRequestFullscreen = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'requestFullscreen');
        Object.defineProperty(document, 'fullscreenElement', {
            configurable: true,
            get: () => fullscreenElement,
        });
        Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
            configurable: true,
            value: requestFullscreen,
        });
        Object.defineProperty(document, 'exitFullscreen', {
            configurable: true,
            value: exitFullscreen,
        });
        vi.stubGlobal('requestAnimationFrame', (callback) => {
            callback();
            return 1;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        const onResize = vi.fn();
        try {
            renderIsland(onResize);
            const island = screen.getByTestId('map-island');
            const controls = screen.getByRole('toolbar', {name: 'Earth map controls'});
            expect(island).toContainElement(controls);
            expect(island).toContainElement(screen.getByTestId('map-viewport'));
            expect(screen.getByRole('button', {name: 'Map Settings'})).toBeInTheDocument();

            fireEvent.click(screen.getByRole('button', {name: 'Go fullscreen'}));
            expect(requestFullscreen.mock.instances[0]).toBe(island);
            expect(onResize).toHaveBeenCalled();
            expect(screen.getByRole('button', {name: 'Exit fullscreen'})).toBeInTheDocument();

            // The browser can leave fullscreen through Escape without clicking the button.
            act(() => {
                fullscreenElement = null;
                document.dispatchEvent(new Event('fullscreenchange'));
            });
            expect(screen.getByRole('button', {name: 'Go fullscreen'})).toBeInTheDocument();

            fireEvent.click(screen.getByRole('button', {name: 'Go fullscreen'}));
            fireEvent.click(screen.getByRole('button', {name: 'Exit fullscreen'}));
            expect(exitFullscreen).toHaveBeenCalledOnce();
        } finally {
            if (originalFullscreenElement) {
                Object.defineProperty(document, 'fullscreenElement', originalFullscreenElement);
            } else {
                delete document.fullscreenElement;
            }
            if (originalExitFullscreen) {
                Object.defineProperty(document, 'exitFullscreen', originalExitFullscreen);
            } else {
                delete document.exitFullscreen;
            }
            if (originalRequestFullscreen) {
                Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', originalRequestFullscreen);
            } else {
                delete HTMLElement.prototype.requestFullscreen;
            }
        }
    });

    it('updates and saves a quick display toggle', async () => {
        socket.emit.mockImplementation((_event, _request, acknowledge) => acknowledge({success: true, data: {}}));
        const store = renderIsland();
        expect(screen.getByRole('button', {name: 'Show coordinate grid'})).toHaveAttribute('aria-pressed', 'true');

        fireEvent.click(screen.getByRole('button', {name: 'Show coordinate grid'}));

        expect(store.getState().earthViewTrack.showGrid).toBe(false);
        expect(screen.getByRole('button', {name: 'Show coordinate grid'})).toHaveAttribute('aria-pressed', 'false');
        await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('api.call', expect.objectContaining({
            cmd: 'set-map-settings',
            data: expect.objectContaining({value: expect.objectContaining({showGrid: false})}),
        }), expect.any(Function)));
    });
});
