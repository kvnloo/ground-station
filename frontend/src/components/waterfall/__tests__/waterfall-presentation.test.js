import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('waterfall presentation height', () => {
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
        const send = (data) => workerScope.onmessage({ data });
        try {
            send({
                cmd: 'initCanvas',
                waterfallCanvas,
                bandscopeCanvas: makeCanvas(),
                dBAxisCanvas: makeCanvas(),
                waterfallLeftMarginCanvas: makeCanvas(),
                config: { width: 4, height: 4, showRotatorDottedLines: false },
            });
            send({ cmd: 'updateFFTData', fft: new Float32Array([1, 2, 3, 4]) });
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
            // present retained ring rows before another FFT frame arrives.
            const reattachedCtx = { drawImage: vi.fn(), fillRect: vi.fn() };
            send({
                cmd: 'initCanvas',
                waterfallCanvas: makeCanvas(reattachedCtx),
                bandscopeCanvas: makeCanvas(),
                dBAxisCanvas: makeCanvas(),
                waterfallLeftMarginCanvas: makeCanvas(),
                config: { width: 4, height: 4, showRotatorDottedLines: false },
            });
            expect(reattachedCtx.drawImage.mock.calls.map((call) => call.slice(1))).toEqual([
                [0, 3, 4, 1, 0, 0, 4, 1],
                [0, 0, 4, 1, 0, 1, 4, 1],
            ]);
        } finally {
            send({ cmd: 'stopMonitoring' });
            send({ cmd: 'detachCanvases' });
        }
    });

});
