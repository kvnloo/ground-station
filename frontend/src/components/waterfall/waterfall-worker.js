/**
 * @license
 * Copyright (c) 2025 Efstratios Goudelis
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
 * Developed with the assistance of Claude (Anthropic AI Assistant)
 */

// Import worker modules (gradual migration)
import { getColorForPower } from './worker-modules/color-maps.js';
import { updateSmoothedFftData } from './worker-modules/smoothing.js';
import { storeFFTDataInHistory, autoScaleDbRange } from './worker-modules/auto-scaling.js';
import {
    drawBandscope as drawBandscopeModule,
    updateWaterfallLeftMargin as updateWaterfallLeftMarginModule
} from './worker-modules/rendering.js';
import { createWebGlWaterfallRenderer } from './webgl-waterfall-renderer.js';

let waterfallCanvas = null;
let bandscopeCanvas = null;
let dBAxisCanvas = null;
let waterfallLeftMarginCanvas = null;
let waterfallCtx = null;
let webglWaterfall = null;
let waterfallBackend = 'canvas2d';
// Ring buffer canvas to avoid full-surface scroll blits each frame
let ringCanvas = null;
let ringCtx = null;
let ringHeadY = 0; // points to the next row to write (newest row will be at ringHeadY after write-1)
// Transparent ring that keeps rotator markers aligned with their FFT rows.
let rotatorOverlayCanvas = null;
let rotatorOverlayCtx = null;
let bandscopeCtx = null;
let dBAxisCtx = null;
let waterFallLeftMarginCtx = null;
// Persistent left-margin state used to preserve timestamps/events across detach/reattach.
let leftMarginStateCanvas = null;
let leftMarginStateCtx = null;
let bandscopeZoomScale = 1;
let targetFPS = 15;
let fftData = new Array(1024).fill(-120);
let fftSize = 8192;
let colorMap = 'cosmic';
let dbRange = [-120, 30];
let scrollOffset = 0;
let imageData = null;
// colorCache now in color-maps.js module
let fftUpdateCount = 0;
let fftRateStartTime = Date.now();
let fftUpdatesPerSecond = 0;
let fftRateIntervalId = null;
let binsUpdateCount = 0;
let binsPerSecond = 0;
let lastBandscopeDrawTime = 0;
let bandscopeDrawInterval = 200;
// Internal switch: default is per-FFT updates (no rate limiting).
let bandscopeRateLimitEnabled = false;
let rotatorEventQueue = [];
let lastTimestamp = new Date();
let timezone = 'UTC';
let recordingDatetime = null; // For playback mode: tracks the recording datetime
let playbackElapsedSeconds = null; // For playback mode: elapsed seconds counter
let playbackRemainingSeconds = null; // For playback mode: remaining seconds countdown
let playbackTotalSeconds = null; // For playback mode: total recording duration
let lastPlaybackRemainingSeconds = null; // Track previous remaining seconds to detect end/loop
let renderWaterfallCount = 0;
let vfoMarkers = [];
let showRotatorDottedLines = true;
let autoScalePreset = 'medium'; // 'strong', 'medium', 'weak'
// Control whether we collect FFT frames for auto-scale history
let collectAutoScaleHistory = true;
// Global offset to adjust the dB range for visual rescaling
let DB_RANGE_OFFSET = 0;

// Store theme object
let theme = {
    palette: {
        background: {
            default: '#121212',
            paper: '#1e1e1e',
            elevated: '#2a2a2a',
        },
        border: {
            main: '#424242',
            light: '#494949',
            dark: '#262626',
        },
        overlay: {
            light: 'rgba(255, 255, 255, 0.08)',
            medium: 'rgba(255, 255, 255, 0.12)',
            dark: 'rgba(0, 0, 0, 0.5)',
        },
        text: {
            primary: '#ffffff',
            secondary: 'rgba(255, 255, 255, 0.7)',
        }
    }
};

// Store waterfall history for auto-scaling
let waterfallHistory = [];

// Keep the last 10 frames for analysis
const maxHistoryLength = 5;

// Add a flag to track if initial auto-scaling has been performed
let hasPerformedInitialAutoScale = false;

// Store recent FFT data for averaging
let fftHistory = [];

// Number of frames to average (adjust as needed)
let maxFftHistoryLength = 5;

// Smoothing type: 'simple', 'weighted', 'exponential'
let smoothingType = 'weighted';

// For exponential smoothing (0-1, higher = more smoothing)
let smoothingStrength = 0.9;

// Cached smoothed data
let smoothedFftData = new Array(1024).fill(-120);

// Precomputed 256-entry RGB palette (r,g,b for indices 0..255)
// Built from current colorMap and dbRange. Avoids per-pixel object allocation
// and function calls inside the hot rendering loop.
let palette = null; // Uint8Array of length 256*3
let paletteDirty = true;
let presentLoopRunning = false;
let presentTimeoutId = null;
let pendingRowsToPresent = 0;
let needsPresent = false;
const ROTATOR_MARKER_DASH_WIDTH = 4;
const ROTATOR_MARKER_DASH_GAP = 12;

function initLeftMarginStateCanvas(options = {}) {
    if (!waterfallLeftMarginCanvas) return;

    const reset = options.reset === true;
    const width = waterfallLeftMarginCanvas.width;
    const height = waterfallLeftMarginCanvas.height;
    const needsCreate = !leftMarginStateCanvas
        || leftMarginStateCanvas.width !== width
        || leftMarginStateCanvas.height !== height;

    if (needsCreate) {
        leftMarginStateCanvas = new OffscreenCanvas(width, height);
        leftMarginStateCtx = leftMarginStateCanvas.getContext('2d', {
            alpha: true,
            desynchronized: true,
            willReadFrequently: false,
        });
    }

    if (!leftMarginStateCtx) return;

    if (needsCreate || reset) {
        leftMarginStateCtx.fillStyle = theme.palette.background.paper;
        leftMarginStateCtx.fillRect(0, 0, width, height);
        return;
    }

    // Reattach path: seed visible left margin from persisted state.
    if (waterFallLeftMarginCtx) {
        waterFallLeftMarginCtx.drawImage(leftMarginStateCanvas, 0, 0);
    }
}

function advanceHeadlessLeftMargin() {
    if (!leftMarginStateCtx || !leftMarginStateCanvas) {
        return;
    }

    const marginResult = updateWaterfallLeftMarginModule({
        waterFallLeftMarginCtx: leftMarginStateCtx,
        waterfallLeftMarginCanvas: leftMarginStateCanvas,
        rotatorEventQueue,
        theme,
        timezone,
        lastTimestamp,
        recordingDatetime
    });
    lastTimestamp = marginResult.lastTimestamp;
    if (marginResult.hasRotatorEvent) {
        stampRotatorOverlayRow(ringHeadY);
    }
}

function initializeRotatorOverlay(width, height, reset) {
    const needsCreate = !rotatorOverlayCanvas
        || rotatorOverlayCanvas.width !== width
        || rotatorOverlayCanvas.height !== height;

    if (needsCreate) {
        rotatorOverlayCanvas = new OffscreenCanvas(width, height);
        rotatorOverlayCtx = rotatorOverlayCanvas.getContext('2d', {
            alpha: true,
            desynchronized: true,
            willReadFrequently: false,
        });
    }

    if (rotatorOverlayCtx && (needsCreate || reset)) {
        rotatorOverlayCtx.clearRect(0, 0, width, height);
    }
}

function stampRotatorOverlayRow(y) {
    if (!showRotatorDottedLines || !rotatorOverlayCtx || !rotatorOverlayCanvas) {
        return;
    }

    // The overlay uses the same ring coordinates as FFT rows, so the marker
    // follows the waterfall through every composition and CSS transform.
    rotatorOverlayCtx.clearRect(0, y, rotatorOverlayCanvas.width, 1);
    rotatorOverlayCtx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    for (let x = 0; x < rotatorOverlayCanvas.width; x += ROTATOR_MARKER_DASH_GAP) {
        rotatorOverlayCtx.fillRect(x, y, ROTATOR_MARKER_DASH_WIDTH, 1);
    }
}

function composeWaterfall() {
    if (webglWaterfall) {
        webglWaterfall.present();
        return;
    }
    if (!waterfallCanvas || !waterfallCtx || !ringCanvas) {
        return;
    }

    // Composite the ring buffers with the newest row at the top.
    const h = waterfallCanvas.height;
    const w = waterfallCanvas.width;
    const topStart = ringHeadY;
    const heightA = h - topStart;

    if (heightA > 0) {
        waterfallCtx.drawImage(ringCanvas, 0, topStart, w, heightA, 0, 0, w, heightA);
    }
    if (topStart > 0) {
        waterfallCtx.drawImage(ringCanvas, 0, 0, w, topStart, 0, heightA, w, topStart);
    }

    // Draw the transparent marker ring after the FFT pixels. Keeping this in
    // worker canvas space makes it inherit the existing zoom and pan exactly.
    if (!showRotatorDottedLines || !rotatorOverlayCanvas) {
        return;
    }
    if (heightA > 0) {
        waterfallCtx.drawImage(rotatorOverlayCanvas, 0, topStart, w, heightA, 0, 0, w, heightA);
    }
    if (topStart > 0) {
        waterfallCtx.drawImage(rotatorOverlayCanvas, 0, 0, w, topStart, 0, heightA, w, topStart);
    }
}

function selectWaterfallRenderer(config = {}) {
    webglWaterfall?.destroy();
    webglWaterfall = null;
    waterfallCtx = null;
    const preference = config.rendererPreference || 'auto';
    const wantsWebGl = preference === 'auto' || preference === 'webgl2';
    if (wantsWebGl && waterfallCanvas) {
        webglWaterfall = createWebGlWaterfallRenderer(waterfallCanvas, {
            width: config.width || waterfallCanvas.width,
            height: config.height || waterfallCanvas.height,
            palette: palette || new Uint8Array(256 * 3),
            backgroundColor: theme.palette.background.default,
            onContextLost: () => self.postMessage({ type: 'rendererContextLost' }),
        });
    }
    if (webglWaterfall) {
        waterfallBackend = 'webgl2';
    } else {
        waterfallBackend = 'canvas2d';
        waterfallCtx = waterfallCanvas?.getContext('2d', {
            alpha: true,
            desynchronized: true,
            willReadFrequently: false,
        }) || null;
        if (waterfallCtx) waterfallCtx.imageSmoothingEnabled = false;
    }
    self.postMessage({ type: 'rendererStatus', data: { preference, effective: waterfallBackend,
        reason: waterfallBackend === 'webgl2' ? 'supported' : (preference === 'canvas2d' ? 'forced' : 'unavailable') } });
}

function rebuildPalette() {
    if (!dbRange || dbRange.length !== 2) return;
    const [min, max] = dbRange;
    const range = max - min;
    // Protect against zero/negative range; fall back to a default to avoid NaN
    const safeRange = range > 1e-6 ? range : 1;
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
        // Map i in [0..255] back to amplitude within dbRange
        const amp = min + (i / 255) * safeRange;
        const c = getColorForPower(amp, colorMap, dbRange);
        const o = i * 3;
        lut[o] = Math.min(255, Math.max(0, c.r | 0));
        lut[o + 1] = Math.min(255, Math.max(0, c.g | 0));
        lut[o + 2] = Math.min(255, Math.max(0, c.b | 0));
    }
    palette = lut;
    paletteDirty = false;
}


// Main message handler
self.onmessage = function(eventMessage) {
    const { cmd } = eventMessage.data;

    switch(cmd) {
        case 'initCanvas':
            waterfallCanvas = eventMessage.data.waterfallCanvas;
            bandscopeCanvas = eventMessage.data.bandscopeCanvas;
            dBAxisCanvas = eventMessage.data.dBAxisCanvas;
            waterfallLeftMarginCanvas = eventMessage.data.waterfallLeftMarginCanvas;
            selectWaterfallRenderer(eventMessage.data.config);
            bandscopeCtx = bandscopeCanvas.getContext('2d', {
                alpha: true,
                desynchronized: true,
                willReadFrequently: false, // true breaks Webview on android and Hermit browser
            });
            dBAxisCtx = dBAxisCanvas.getContext('2d', {
                alpha: true,
                desynchronized: true,
                willReadFrequently: false, // true breaks Webview on android and Hermit browser
            });
            waterFallLeftMarginCtx = waterfallLeftMarginCanvas.getContext('2d', {
                alpha: true,
                desynchronized: true,
                willReadFrequently: false, // true breaks Webview on android and Hermit browser
            });

            // Note: imageSmoothingQuality is ignored when smoothing is disabled
            bandscopeCtx.imageSmoothingEnabled = true;
            bandscopeCtx.imageSmoothingQuality = 'high';
            dBAxisCtx.imageSmoothingEnabled = true;
            dBAxisCtx.imageSmoothingQuality = 'high';

            // Preserve ring-buffer history when (re)attaching visible canvases.
            setupCanvas(eventMessage.data.config, { preserveRing: true });

            // Start monitoring when canvas is initialized
            startFftRateMonitoring();
            break;

        case 'initHeadless':
            // Configure ring-buffer rendering even when no visible canvas is attached.
            setupCanvas(eventMessage.data.config);
            startFftRateMonitoring();
            break;

        case 'replaceWaterfallCanvas':
            // An OffscreenCanvas cannot exchange a WebGL context for 2D in place.
            webglWaterfall?.destroy();
            webglWaterfall = null;
            waterfallCanvas = eventMessage.data.waterfallCanvas;
            selectWaterfallRenderer(eventMessage.data.config);
            setupCanvas(eventMessage.data.config, { preserveRing: true });
            break;

        case 'start':
            // Rotator markers describe the current stream. Drop any status
            // changes accumulated while the waterfall was idle.
            rotatorEventQueue = [];
            // Reset auto-scale flags/history for new sessions
            hasPerformedInitialAutoScale = false;
            waterfallHistory = []; // Clear any existing history
            collectAutoScaleHistory = true;

            startRendering(eventMessage.data.fps || eventMessage.data?.data?.fps || targetFPS);
            break;

        case 'stop':
            stopRendering();
            break;

        case 'updateFPS':
            updateFPS(eventMessage.data.fps || eventMessage.data?.data?.fps);
            break;

        case 'toggleRotatorDottedLines':
            // Toggle the visibility of dotted lines for rotator events
            showRotatorDottedLines = Boolean(eventMessage.data.show);
            // Recompose immediately so hiding or showing existing markers does
            // not require another FFT frame.
            composeWaterfall();
            break;

        case 'updateFFTData': {
            // Increment the counter for rate calculation
            fftUpdateCount++;

            // Increment the fft bin counter
            binsUpdateCount += eventMessage.data.fft.length;

            // Store the new FFT data
            fftData = eventMessage.data.fft;

            // Update playback timing info if present (for playback mode)
            if (eventMessage.data.recording_datetime) {
                recordingDatetime = new Date(eventMessage.data.recording_datetime);
            } else {
                recordingDatetime = null;
            }

            // Detect end of recording by checking if remaining seconds increased (loop) or reached near zero
            const newRemainingSeconds = eventMessage.data.playback_remaining_seconds || null;
            if (lastPlaybackRemainingSeconds !== null && newRemainingSeconds !== null) {
                // Check if we looped (remaining increased significantly) or reached end (near zero)
                const hasLooped = newRemainingSeconds > lastPlaybackRemainingSeconds + 1;
                const reachedEnd = lastPlaybackRemainingSeconds > 0 && newRemainingSeconds < 1;

                if (hasLooped || reachedEnd) {
                    // Push "END" marker to rotator event queue to display on left margin
                    rotatorEventQueue.push('━━━ END ━━━');
                }
            }

            playbackElapsedSeconds = eventMessage.data.playback_elapsed_seconds || null;
            playbackRemainingSeconds = newRemainingSeconds;
            playbackTotalSeconds = eventMessage.data.playback_total_seconds || null;
            lastPlaybackRemainingSeconds = newRemainingSeconds;

            // Store FFT data in history for auto-scaling if collection is enabled
            if (collectAutoScaleHistory) {
                waterfallHistory = storeFFTDataInHistory(eventMessage.data.fft, waterfallHistory, maxHistoryLength);
            }

            // Perform initial auto-scaling once we have enough data (3-5 frames)
            if (!hasPerformedInitialAutoScale && waterfallHistory.length >= 3) {
                console.log('Performing initial auto-scale with', waterfallHistory.length, 'frames of data');
                const result = autoScaleDbRange(waterfallHistory, autoScalePreset);
                if (result) {
                    dbRange = result.dbRange;
                    // Palette depends on dbRange
                    paletteDirty = true;
                    rebuildPalette();
                    self.postMessage({
                        type: 'autoScaleResult',
                        data: result
                    });
                }
                hasPerformedInitialAutoScale = true;
                // Stop collecting history after initial auto-scale to reduce overhead
                waterfallHistory = [];
                collectAutoScaleHistory = false;
            }

            // Ingest every FFT frame into the ring buffer immediately.
            // Presentation to visible canvas is handled by a dedicated present loop.
            ingestWaterfallRow(eventMessage.data.fft);

            // Keep compatibility for non-streaming/manual scenarios where
            // start/stop lifecycle may not be running.
            if (eventMessage.data.immediate && !presentLoopRunning) {
                presentWaterfall();
            }
            break;
        }

        case 'updateFFTSize':
            fftSize = eventMessage.data.fftSize;

            // Reset smoothing arrays when FFT size changes
            fftHistory = [];
            smoothedFftData = new Array(fftSize).fill(-120);

            // Also reset waterfall history for auto-scaling
            waterfallHistory = [];
            hasPerformedInitialAutoScale = false;
            collectAutoScaleHistory = true;

            self.postMessage({
                type: 'fftSizeUpdated',
                data: { fftSize: fftSize }
            });
            break;

        case 'updateSmoothingConfig':
            if (eventMessage.data.historyLength !== undefined) {
                maxFftHistoryLength = Math.max(1, Math.min(20, eventMessage.data.historyLength));
            }
            if (eventMessage.data.smoothingType !== undefined) {
                smoothingType = eventMessage.data.smoothingType;
            }
            if (eventMessage.data.smoothingStrength !== undefined) {
                smoothingStrength = Math.max(0, Math.min(1, eventMessage.data.smoothingStrength));
            }

            // Reset history when changing settings
            fftHistory = [];
            smoothedFftData = new Array(fftData.length).fill(-120);

            self.postMessage({
                type: 'smoothingConfigUpdated',
                data: {
                    historyLength: maxFftHistoryLength,
                    smoothingType: smoothingType,
                    smoothingStrength: smoothingStrength
                }
            });
            break;

        case 'updateConfig':
            // Update rendering configuration
            if (eventMessage.data.colorMap) {
                colorMap = eventMessage.data.colorMap;
                paletteDirty = true;
            }
            if (eventMessage.data.dbRange) {
                dbRange = eventMessage.data.dbRange;
                paletteDirty = true;
            }
            if (eventMessage.data.theme) {
                theme = eventMessage.data.theme;
            }
            if (eventMessage.data.zoomScale !== undefined) {
                bandscopeZoomScale = Math.max(1, Number(eventMessage.data.zoomScale) || 1);
            }
            if (eventMessage.data.timezone !== undefined) {
                timezone = eventMessage.data.timezone || 'UTC';
            }
            if (eventMessage.data.bandscopeRateLimitEnabled !== undefined) {
                bandscopeRateLimitEnabled = Boolean(eventMessage.data.bandscopeRateLimitEnabled);
            }
            // Rebuild palette if needed after config updates
            if (paletteDirty) rebuildPalette();
            webglWaterfall?.setPalette(palette, theme.palette.background.default);
            break;

        case 'autoScaleDbRange': {
            // Trigger auto-scaling of dB range. If we don't have enough
            // history yet, enable collection and wait for a few frames.
            if (waterfallHistory.length < 3) {
                hasPerformedInitialAutoScale = false;
                collectAutoScaleHistory = true;
                break;
            }

            const result = autoScaleDbRange(waterfallHistory, autoScalePreset);
            if (result) {
                dbRange = result.dbRange;
                paletteDirty = true;
                rebuildPalette();
                self.postMessage({
                    type: 'autoScaleResult',
                    data: result
                });
            }
            // After manual auto-scale, stop collecting to reduce memory/CPU
            waterfallHistory = [];
            collectAutoScaleHistory = false;
            break;
        }

        case 'rotatorEvent':
            // Handle rotator events to display them on canvas
            rotatorEventQueue.push(eventMessage.data.event);
            break;

        case 'releaseCanvas':
        case 'detachCanvases':
            // Persist currently visible margin before releasing canvases.
            if (leftMarginStateCtx && leftMarginStateCanvas && waterfallLeftMarginCanvas) {
                leftMarginStateCtx.drawImage(waterfallLeftMarginCanvas, 0, 0);
            }
            waterfallCanvas = null;
            webglWaterfall?.destroy();
            webglWaterfall = null;
            waterfallBackend = 'canvas2d';
            bandscopeCanvas = null;
            dBAxisCanvas = null;
            waterfallLeftMarginCanvas = null;
            waterfallCtx = null;
            bandscopeCtx = null;
            dBAxisCtx = null;
            waterFallLeftMarginCtx = null;
            break;

        case 'startMonitoring':
            startFftRateMonitoring();
            break;

        case 'stopMonitoring':
            stopFftRateMonitoring();
            break;

        case 'updateVFOMarkers':
            vfoMarkers = eventMessage.data.markers;
            break;

        case 'setAutoScalePreset':
            autoScalePreset = eventMessage.data.preset;
            console.log('Auto-scale preset changed to:', autoScalePreset);
            break;

        case 'captureWaterfallCanvas':
            // Capture waterfall canvas as PNG
            if (waterfallCanvas && (waterfallCtx || webglWaterfall)) {
                try {
                    webglWaterfall?.present();
                    // Get the original canvas dimensions
                    const originalWidth = waterfallCanvas.width;
                    const originalHeight = waterfallCanvas.height;

                    // Capture at full resolution for high-quality snapshots
                    // No downscaling - use original dimensions
                    const targetWidth = originalWidth;
                    const targetHeight = originalHeight;

                    // Use the waterfall canvas directly without scaling
                    // (no need for temporary canvas if dimensions match)
                    const tempCanvas = waterfallCanvas;

                    // Convert to blob (this works in workers)
                    tempCanvas.convertToBlob({ type: 'image/png' })
                        .then(blob => {
                            // Send the blob back to main thread
                            // Main thread will convert to data URL
                            self.postMessage({
                                type: 'waterfallCaptured',
                                data: {
                                    blob: blob,
                                    width: targetWidth,
                                    height: targetHeight,
                                    originalWidth: originalWidth,
                                    originalHeight: originalHeight
                                }
                            });
                        })
                        .catch(err => {
                            console.error('Worker: Failed to convert canvas to blob:', err);
                            self.postMessage({
                                type: 'waterfallCaptureFailed',
                                error: err.message
                            });
                        });
                } catch (err) {
                    console.error('Worker: Failed to capture waterfall canvas:', err);
                    self.postMessage({
                        type: 'waterfallCaptureFailed',
                        error: err.message
                    });
                }
            } else {
                console.error('Worker: Canvas or context not available');
                self.postMessage({
                    type: 'waterfallCaptureFailed',
                    error: 'Canvas not available'
                });
            }
            break;

        default:
            console.error('Unknown command:', cmd);
    }
};


// Store FFT data in history for auto-scaling analysis

// Function to throttle bandscope drawing
function throttledDrawBandscope() {
    if (!bandscopeCtx || !bandscopeCanvas || !dBAxisCtx || !dBAxisCanvas) {
        return;
    }

    const now = Date.now();

    // Draw on every FFT frame unless internal rate limiting is enabled.
    const canDrawNow = !bandscopeRateLimitEnabled || now - lastBandscopeDrawTime >= bandscopeDrawInterval;
    if (canDrawNow) {
        // Compute smoothing only when the bandscope is actually redrawn.
        // This avoids expensive per-packet smoothing work when FFT ingest
        // cadence is much higher than visual bandscope cadence.
        const smoothResult = updateSmoothedFftData(
            fftData,
            fftHistory,
            smoothedFftData,
            smoothingType,
            smoothingStrength,
            maxFftHistoryLength
        );
        fftHistory = smoothResult.fftHistory;
        smoothedFftData = smoothResult.smoothedFftData;

        drawBandscopeModule({
            bandscopeCtx,
            bandscopeCanvas,
            fftData,
            smoothedFftData,
            dbRange,
            colorMap,
            theme,
            dBAxisCtx,
            dBAxisCanvas,
            zoomScale: bandscopeZoomScale
        });
        lastBandscopeDrawTime = now;
    }
}

function startFftRateMonitoring() {
    stopFftRateMonitoring();

    // Reset counters
    fftUpdateCount = 0;
    renderWaterfallCount = 0; // Reset renderWaterfall counter
    fftRateStartTime = Date.now();

    // Calculate and report rate every second
    fftRateIntervalId = setInterval(() => {
        const now = Date.now();
        const elapsedSeconds = (now - fftRateStartTime) / 1000;

        // Calculate rates
        fftUpdatesPerSecond = fftUpdateCount / elapsedSeconds;
        const renderWaterfallPerSecond = renderWaterfallCount / elapsedSeconds;

        // Calculate bins per second
        binsPerSecond = binsUpdateCount / elapsedSeconds;

        // Report the rates to the main thread
        self.postMessage({
            type: 'metrics',
            data: {
                fftUpdatesPerSecond: parseFloat(fftUpdatesPerSecond.toFixed(1)),
                binsPerSecond: binsPerSecond,
                renderWaterfallPerSecond: parseFloat(renderWaterfallPerSecond.toFixed(1)),
                totalUpdates: fftUpdateCount,
                timeElapsed: elapsedSeconds,
            }
        });

        // Reset for next interval
        fftUpdateCount = 0;
        renderWaterfallCount = 0;
        binsUpdateCount = 0;
        fftRateStartTime = now;
    }, 1000);
}

function stopFftRateMonitoring() {
    if (fftRateIntervalId) {
        clearInterval(fftRateIntervalId);
        fftRateIntervalId = null;
    }
}

function setupCanvas(config = {}, options = {}) {
    const preserveRing = options.preserveRing === true;
    const width = Number(config.width) || waterfallCanvas?.width || ringCanvas?.width || 0;
    const height = Number(config.height) || waterfallCanvas?.height || ringCanvas?.height || 0;

    if (width <= 0 || height <= 0) {
        return;
    }

    if (waterfallCanvas) {
        waterfallCanvas.width = width;
        waterfallCanvas.height = height;
    }

    const previousRingWidth = ringCanvas?.width || 0;
    const previousRingHeight = ringCanvas?.height || 0;

    // Initialize or resize the ring buffer canvas to match
    if (!ringCanvas) {
        ringCanvas = new OffscreenCanvas(width, height);
    } else if (ringCanvas.width !== width || ringCanvas.height !== height) {
        ringCanvas.width = width;
        ringCanvas.height = height;
    }
    ringCtx = ringCanvas.getContext('2d', {
        alpha: true,
        desynchronized: true,
        willReadFrequently: false,
    });
    if (ringCtx) {
        ringCtx.imageSmoothingEnabled = false;
    }

    const ringSizeChanged = previousRingWidth !== width || previousRingHeight !== height;
    const shouldResetRing = !preserveRing || ringSizeChanged || !imageData;
    if (shouldResetRing) {
        ringHeadY = 0;
        pendingRowsToPresent = 0;
        needsPresent = false;
    }

    initializeRotatorOverlay(width, height, shouldResetRing);

    // Initialize imageData from the ring context, so headless mode can render too.
    if (!imageData || imageData.width !== width) {
        imageData = ringCtx?.createImageData(width, 1) || null;
    }

    // Other setup
    if (config.colorMap) {
        colorMap = config.colorMap;
    }
    if (config.dbRange) {
        dbRange = config.dbRange;
    }
    if (config.fftSize) {
        fftSize = config.fftSize;
    }
    if (config.showRotatorDottedLines !== undefined) {
        showRotatorDottedLines = config.showRotatorDottedLines;
    }
    if (config.bandscopeRateLimitEnabled !== undefined) {
        bandscopeRateLimitEnabled = Boolean(config.bandscopeRateLimitEnabled);
    }
    if (config.timezone !== undefined) {
        timezone = config.timezone || timezone;
    }

    // Update theme if provided
    if (config.theme) {
        theme = config.theme;
    }

    // IMPORTANT: Reset smoothing arrays when FFT size changes
    fftHistory = [];
    smoothedFftData = new Array(fftSize).fill(-120);

    // Clear visible canvas when attached.
    if (waterfallCtx && waterfallCanvas) {
        waterfallCtx.fillStyle = theme.palette.background.default;
        waterfallCtx.fillRect(0, 0, waterfallCanvas.width, waterfallCanvas.height);
    }

    // Keep a persistent left-margin history canvas so timestamp/event rows survive route unmounts.
    initLeftMarginStateCanvas({ reset: shouldResetRing });

    // Clear the ring canvas when resetting.
    if (ringCtx && shouldResetRing) {
        ringCtx.fillStyle = theme.palette.background.default;
        ringCtx.fillRect(0, 0, ringCanvas.width, ringCanvas.height);
    }

    // Rebuild color palette for current settings
    paletteDirty = true;
    rebuildPalette();
    if (webglWaterfall) {
        webglWaterfall.resize(width, height);
        webglWaterfall.setPalette(palette, theme.palette.background.default);
    }
}

function startRendering(fps) {
    // Clear any existing loop first
    stopRendering();

    // Keep markers received while the worker was starting. The first FFT row
    // should show the current rotator state even when tracking began first.

    targetFPS = fps;
    startPresentLoop();

    // Confirm start
    self.postMessage({ type: 'status', status: 'started', fps: targetFPS });
}

// Stop the rendering cycle
function stopRendering() {
    stopPresentLoop();
    self.postMessage({ type: 'status', status: 'stopped' });
}

function startPresentLoop() {
    presentLoopRunning = true;
    scheduleNextPresent();
}

function stopPresentLoop() {
    presentLoopRunning = false;
    if (presentTimeoutId !== null) {
        clearTimeout(presentTimeoutId);
    }
    presentTimeoutId = null;
    pendingRowsToPresent = 0;
    needsPresent = false;
}

function scheduleNextPresent() {
    if (!presentLoopRunning) return;

    // Android WebView-derived browsers can expose worker rAF but stall it.
    // Use a target-FPS timer so pending rows keep presenting without relying
    // on compositor-driven callbacks inside the worker.
    const intervalMs = Math.max(1, Math.round(1000 / (Number(targetFPS) || 10)));
    presentTimeoutId = setTimeout(presentTick, intervalMs);
}

function presentTick() {
    if (!presentLoopRunning) return;
    presentWaterfall();
    scheduleNextPresent();
}

function ingestWaterfallRow(frame) {
    if (webglWaterfall) {
        const [min, max] = dbRange;
        webglWaterfall.pushFrame(frame, min + DB_RANGE_OFFSET, max + DB_RANGE_OFFSET);
        if (waterfallCanvas) pendingRowsToPresent = Math.min(pendingRowsToPresent + 1, waterfallCanvas.height);
        needsPresent = true;
        return;
    }
    if (!ringCanvas || !ringCtx || !imageData) return;
    if (!frame || frame.length === 0) return;

    // Move head UPWARD in ring space. Decrement BEFORE writing so this row
    // becomes the newest row at the top of the composed output.
    const h = ringCanvas.height;
    ringHeadY = (ringHeadY - 1 + h) % h;

    // Render the new row in the ring buffer and mark presentation as needed.
    // A ring slot is about to receive a new FFT row, so discard any marker
    // from its previous trip through the ring before it can wrap into view.
    rotatorOverlayCtx?.clearRect(0, ringHeadY, ringCanvas.width, 1);
    renderFFTRowIntoRing(frame, ringHeadY);
    if (waterfallCanvas && waterfallCtx) {
        pendingRowsToPresent = Math.min(pendingRowsToPresent + 1, ringCanvas.height);
    } else {
        pendingRowsToPresent = 0;
        // Keep left timestamp/event history moving while waterfall view is detached.
        advanceHeadlessLeftMargin();
    }
    needsPresent = true;
}

function presentWaterfall() {
    if (!waterfallCanvas || (!waterfallCtx && !webglWaterfall) || !needsPresent) return;

    // Increment the counter for rate calculation
    renderWaterfallCount++;

    // Left margin should advance one pixel per ingested waterfall row.
    if (pendingRowsToPresent > 0) {
        for (let i = 0; i < pendingRowsToPresent; i++) {
            const marginResult = updateWaterfallLeftMarginModule({
                waterFallLeftMarginCtx,
                waterfallLeftMarginCanvas,
                rotatorEventQueue,
                theme,
                timezone,
                lastTimestamp,
                recordingDatetime  // Pass recording datetime for playback mode
            });
            lastTimestamp = marginResult.lastTimestamp;
            if (marginResult.hasRotatorEvent) {
                if (webglWaterfall) webglWaterfall.markLatestRow();
                else stampRotatorOverlayRow(ringHeadY);
            }
        }
        // Keep persistent left-margin state aligned with what was rendered visibly.
        if (leftMarginStateCtx && leftMarginStateCanvas && waterfallLeftMarginCanvas) {
            leftMarginStateCtx.drawImage(waterfallLeftMarginCanvas, 0, 0);
        }
    }
    composeWaterfall();
    pendingRowsToPresent = 0;
    needsPresent = false;

    // Draw bandscope with throttling
    throttledDrawBandscope();
}

// Renders a single FFT row into the ring buffer at the specified y index
function renderFFTRowIntoRing(fftData, y) {
    if (!imageData || !ringCanvas || !ringCtx) return;
    if (!fftData || fftData.length === 0) return;

    const data = imageData.data;
    const [min, max] = dbRange;
    // Apply the global offset to the range
    const offsetMin = min + DB_RANGE_OFFSET;
    const offsetMax = max + DB_RANGE_OFFSET;
    const range = offsetMax - offsetMin;
    const canvasWidth = ringCanvas.width;

    // Note: No need to clear the image data here as we overwrite every pixel below

    // Ensure palette exists for current colorMap/dbRange
    if (paletteDirty || !palette) {
        rebuildPalette();
    }
    const safeRange = range > 1e-6 ? range : 1;

    if (fftData.length >= canvasWidth) {
        // More FFT bins than pixels - downsample
        const skipFactor = fftData.length / canvasWidth;

        for (let x = 0; x < canvasWidth; x++) {
            const fftIndex = Math.min(Math.floor(x * skipFactor), fftData.length - 1);
            const amplitude = fftData[fftIndex];

            // Map amplitude to palette index [0..255]
            let idx = ((amplitude - offsetMin) * 255 / safeRange) | 0;
            if (idx < 0) idx = 0; else if (idx > 255) idx = 255;
            const po = idx * 3;

            const pixelIndex = x * 4;
            data[pixelIndex] = palette[po];
            data[pixelIndex + 1] = palette[po + 1];
            data[pixelIndex + 2] = palette[po + 2];
            data[pixelIndex + 3] = 255;
        }
    } else {
        // Fewer FFT bins than pixels - interpolate/stretch
        const stretchFactor = canvasWidth / fftData.length;

        for (let i = 0; i < fftData.length; i++) {
            const amplitude = fftData[i];
            // Map amplitude to palette index [0..255]
            let idx = ((amplitude - offsetMin) * 255 / safeRange) | 0;
            if (idx < 0) idx = 0; else if (idx > 255) idx = 255;
            const po = idx * 3;

            // Calculate the pixel range for this FFT bin
            const startX = Math.floor(i * stretchFactor);
            const endX = Math.floor((i + 1) * stretchFactor);

            // Fill all pixels in this range with the same color
            for (let x = startX; x < endX && x < canvasWidth; x++) {
                const pixelIndex = x * 4;
                data[pixelIndex] = palette[po];
                data[pixelIndex + 1] = palette[po + 1];
                data[pixelIndex + 2] = palette[po + 2];
                data[pixelIndex + 3] = 255;
            }
        }
    }

    // Put the image data on the specified row of the ring canvas
    ringCtx.putImageData(imageData, 0, y);
}

// Update FPS setting
function updateFPS(fps) {
    if (!Number.isFinite(fps) || fps <= 0) {
        return;
    }

    if (fps !== targetFPS) {
        targetFPS = fps;

        // Restart with new FPS if currently running
        if (presentLoopRunning) {
            startRendering(targetFPS);
        }

        self.postMessage({ type: 'status', status: 'fpsUpdated', fps: targetFPS });
    }
}
