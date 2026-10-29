import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ZoomableImage from '../zoomable-image.jsx';
import ImageViewerDialog from '../image-viewer-dialog.jsx';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (_key, options) => options?.defaultValue || _key }),
}));

afterEach(() => vi.restoreAllMocks());

describe('image sizing', () => {
    it.each([
        ['sstv_Robot_36.png', undefined],
        ['renamed.png', { decoder: { type: 'SSTV' } }],
    ])('opens SSTV images at their original size: %s', (title, metadata) => {
        render(<ImageViewerDialog open onClose={vi.fn()} src="/image.png" title={title} metadata={metadata} />);

        expect(screen.getByRole('button', { name: 'Original size (100%)' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('img')).toHaveStyle({ width: 'auto', height: 'auto', flexShrink: 0 });
    });

    it('keeps other images fitted to the area by default', () => {
        render(<ImageViewerDialog open onClose={vi.fn()} src="/snapshot.png" title="Snapshot" />);

        expect(screen.getByRole('button', { name: 'Fit to area' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('img')).toHaveStyle({ width: '100%', height: '100%' });
    });

    it('switches sizing modes and resets zoom when selecting a size or reopening', () => {
        const { rerender } = render(<ZoomableImage src="/sstv.png" initialFit="original" showFitControls resetKey="first" />);
        const image = screen.getByRole('img');
        const viewer = image.parentElement;
        fireEvent.wheel(viewer, { deltaY: -100, clientX: 0, clientY: 0 });
        expect(image.style.transform).toContain('scale(1.1)');
        fireEvent.click(screen.getByRole('button', { name: 'Original size (100%)' }));
        expect(image.style.transform).toBe('translate(0px, 0px) scale(1)');

        fireEvent.click(screen.getByRole('button', { name: 'Fit to area' }));
        expect(image).toHaveStyle({ width: '100%', height: '100%' });
        fireEvent.wheel(viewer, { deltaY: -100, clientX: 0, clientY: 0 });
        rerender(<ZoomableImage src="/sstv.png" initialFit="original" showFitControls resetKey="reopened" />);
        expect(image).toHaveStyle({ width: 'auto', height: 'auto' });
        expect(image.style.transform).toBe('translate(0px, 0px) scale(1)');
    });

    it('pans large original-size images at 100% and after zooming out', () => {
        render(<ZoomableImage src="/large.png" initialFit="original" minZoom={0.1} />);
        const image = screen.getByRole('img');
        Object.defineProperties(image, { naturalWidth: { value: 800 }, naturalHeight: { value: 600 } });
        const viewer = image.parentElement;
        vi.spyOn(viewer, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 300, left: 0, top: 0 });
        viewer.setPointerCapture = vi.fn();
        viewer.releasePointerCapture = vi.fn();

        fireEvent.pointerDown(viewer, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 200, clientY: 150 });
        fireEvent.pointerMove(viewer, { pointerId: 1, pointerType: 'mouse', clientX: 700, clientY: 650 });
        expect(image.style.transform).toBe('translate(200px, 150px) scale(1)');
        fireEvent.pointerUp(viewer, { pointerId: 1, pointerType: 'mouse' });

        fireEvent.doubleClick(viewer);
        fireEvent.wheel(viewer, { deltaY: 100, clientX: 200, clientY: 150 });
        fireEvent.pointerDown(viewer, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 200, clientY: 150 });
        fireEvent.pointerMove(viewer, { pointerId: 2, pointerType: 'mouse', clientX: 700, clientY: 650 });
        expect(image.style.transform).toBe('translate(160px, 120px) scale(0.9)');
    });
});
