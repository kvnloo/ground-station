import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('waterfall presentation and retained FFT display', () => {
    it('clips ring composition and restores history on reattach and capture', async () => {
        const displayCtx = {
            drawImage: vi.fn(),
            fillRect: vi.fn(),
        };
        const makeContext = () => ({
            drawImage: vi.fn(),
            fillRect: vi.fn(),
            clearRect: vi.fn(),
            putImageData: vi.fn(),
            setLineDash: vi.fn(),
            beginPath: vi.fn(),
            moveTo: vi.fn(),
            lineTo: vi.fn(),
            quadraticCurveTo: vi.fn(),
            stroke: vi.fn(),
            fill: vi.fn(),
            fillText: vi.fn(),
            createImageData: (width, height) => ({
                width,
                height,
                data: new Uint8ClampedArray(width * height * 4),
            }),
        });
        class FakeOffscreenCanvas {
            constructor(width, height) {
                this.width = width;
                this.height = height;
                this.ctx = makeContext();
            }
            getContext() { return this.ctx; }
        }
        const makeCanvas = (ctx = makeContext()) => ({
            width: 4,
            height: 4,
            getContext: () => ctx,
            convertToBlob: () => Promise.resolve(new Blob()),
        });
        const workerScope = { postMessage: vi.fn() };
        vi.stubGlobal('self', workerScope);
        vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
        vi.resetModules();
        await import('../waterfall-worker.js');

        const waterfallCanvas = makeCanvas(displayCtx);
        const initialBandscopeCtx = makeContext();
        const initialDbAxisCtx = makeContext();
        const send = (data) => workerScope.onmessage({ data });
        const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1000);
        try {
            send({
                cmd: 'initCanvas',
                waterfallCanvas,
                bandscopeCanvas: makeCanvas(initialBandscopeCtx),
                dBAxisCanvas: makeCanvas(initialDbAxisCtx),
                waterfallLeftMarginCanvas: makeCanvas(),
                config: { width: 4, height: 4, showRotatorDottedLines: false },
            });
            send({ cmd: 'updateFFTData', fft: new Float32Array([1, 2, 3, 4]), immediate: true });
            expect(initialBandscopeCtx.fill).toHaveBeenCalled();
            expect(initialDbAxisCtx.fillText).toHaveBeenCalled();
            send({ cmd: 'stop' });
            displayCtx.drawImage.mockClear();

            send({ cmd: 'setVisibleWaterfallHeight', height: 2 });
            expect(displayCtx.drawImage.mock.calls.map((call) => call.slice(1))).toEqual([
                [0, 3, 4, 1, 0, 0, 4, 1],
                [0, 0, 4, 1, 0, 1, 4, 1],
            ]);

            displayCtx.drawImage.mockClear();
            send({ cmd: 'captureWaterfallCanvas' });
            expect(displayCtx.drawImage.mock.calls.map((call) => call.slice(1))).toEqual([
                [0, 3, 4, 1, 0, 0, 4, 1],
                [0, 0, 4, 3, 0, 1, 4, 3],
            ]);

            // A new page mounts a fresh display canvas. The worker should
            // present retained ring rows and redraw the bandscope/axis before
            // another FFT frame arrives.
            const reattachedCtx = { drawImage: vi.fn(), fillRect: vi.fn() };
            const bandscopeCtx = makeContext();
            const dBAxisCtx = makeContext();
            send({
                cmd: 'initCanvas',
                waterfallCanvas: makeCanvas(reattachedCtx),
                bandscopeCanvas: makeCanvas(bandscopeCtx),
                dBAxisCanvas: makeCanvas(dBAxisCtx),
                waterfallLeftMarginCanvas: makeCanvas(),
                config: { width: 4, height: 4, showRotatorDottedLines: false, bandscopeRateLimitEnabled: true },
            });
            expect(reattachedCtx.drawImage.mock.calls.map((call) => call.slice(1))).toEqual([
                [0, 3, 4, 1, 0, 0, 4, 1],
                [0, 0, 4, 1, 0, 1, 4, 1],
            ]);
            expect(bandscopeCtx.stroke).toHaveBeenCalled();
            expect(bandscopeCtx.fill).toHaveBeenCalled();
            expect(dBAxisCtx.fillText).toHaveBeenCalledWith(expect.stringContaining('dB'), expect.any(Number), expect.any(Number));

            // A quick remount must repaint even within the bandscope rate limit.
            const nextBandscopeCtx = makeContext();
            const nextDbAxisCtx = makeContext();
            send({
                cmd: 'initCanvas',
                waterfallCanvas: makeCanvas(),
                bandscopeCanvas: makeCanvas(nextBandscopeCtx),
                dBAxisCanvas: makeCanvas(nextDbAxisCtx),
                waterfallLeftMarginCanvas: makeCanvas(),
                config: { width: 4, height: 4, showRotatorDottedLines: false, bandscopeRateLimitEnabled: true },
            });
            expect(nextBandscopeCtx.fill).toHaveBeenCalled();
            expect(nextDbAxisCtx.fillText).toHaveBeenCalled();
        } finally {
            send({ cmd: 'stopMonitoring' });
            send({ cmd: 'detachCanvases' });
            dateNow.mockRestore();
        }
    });

});
