import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SolarSystemCanvas from '../solarsystem-canvas.jsx';

vi.mock('../../../hooks/useUserTimeSettings.jsx', () => ({
    useUserTimeSettings: () => ({ locale: 'en-US' }),
}));

describe('solar system wheel zoom', () => {
    it('cancels page scrolling only while map zooming is enabled', () => {
        const displayOptions = { showStarfieldBackground: false };
        const { container, rerender } = render(
            <SolarSystemCanvas scene={{}} enableMapZooming displayOptions={displayOptions} />,
        );
        const map = container.querySelector('canvas').parentElement;

        const zoomIn = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
        map.dispatchEvent(zoomIn);
        expect(zoomIn.defaultPrevented).toBe(true);

        const zoomOut = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });
        map.dispatchEvent(zoomOut);
        expect(zoomOut.defaultPrevented).toBe(true);

        rerender(<SolarSystemCanvas scene={{}} enableMapZooming={false} displayOptions={displayOptions} />);
        const wheelWithZoomDisabled = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: 100,
        });
        map.dispatchEvent(wheelWithZoomDisabled);
        expect(wheelWithZoomDisabled.defaultPrevented).toBe(false);
    });
});
