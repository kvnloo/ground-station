import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { Saturn01Icon } from 'hugeicons-react';
import { getCelestialDataIconStatus, getNavigation } from './navigation.jsx';

describe('administration navigation', () => {
    it('groups satellite and celestial pages under their domain parents', () => {
        const navigation = getNavigation({ isAdmin: true });
        const satelliteData = navigation.find((item) => item.segment === 'admin/satellites');
        const celestialData = navigation.find((item) => item.segment === 'admin/celestial');

        expect(satelliteData.children.map((item) => item.segment)).toEqual([
            'orbital-data',
            'sources',
            'catalog',
            'groups',
        ]);
        expect(celestialData.children.map((item) => item.segment)).toEqual([
            'ephemeris',
            'catalog',
        ]);
        expect(celestialData.collapsedSegment).toBe('admin/celestial/ephemeris');
        expect(navigation.some((item) => item.segment === 'admin/satellites/catalog')).toBe(false);
        expect(navigation.some((item) => item.segment === 'admin/celestial/catalog')).toBe(false);
    });

    it('does not expose administration groups to non-admin users', () => {
        const navigation = getNavigation({ isAdmin: false });

        expect(navigation.some((item) => item.segment === 'admin/satellites')).toBe(false);
        expect(navigation.some((item) => item.segment === 'admin/celestial')).toBe(false);
    });

    it('uses a planet icon for celestial data administration and its catalog child', () => {
        const navigation = getNavigation({ isAdmin: true });
        const celestialData = navigation.find((item) => item.segment === 'admin/celestial');
        const catalogChild = celestialData.children.find((item) => item.segment === 'catalog');

        expect(catalogChild.icon.type).toBe(Saturn01Icon);

        const store = configureStore({
            reducer: {
                celestial: () => ({}),
            },
        });
        const { container } = render(
            <Provider store={store}>
                {celestialData.icon}
            </Provider>
        );
        expect(container.querySelector('svg')).toBeInTheDocument();
    });
});

describe('celestial data navigation status', () => {
    it('shows the working overlay while ephemeris synchronization is active', () => {
        expect(getCelestialDataIconStatus({
            ephemerisSync: { status: 'inprogress' },
        })).toEqual({ showOverlay: true, overlayType: 'sync' });
    });

    it('shows the error overlay for a failed sync or unavailable provider', () => {
        expect(getCelestialDataIconStatus({
            ephemerisSync: { status: 'failed' },
        })).toEqual({ showOverlay: true, overlayType: 'error' });

        expect(getCelestialDataIconStatus({
            ephemerisSync: {
                status: 'idle',
                providerStatus: { availability: 'unavailable' },
            },
        })).toEqual({ showOverlay: true, overlayType: 'error' });
    });

    it('removes the overlay after a successful synchronization', () => {
        expect(getCelestialDataIconStatus({
            ephemerisSync: {
                status: 'complete',
                providerStatus: { availability: 'available' },
            },
        })).toEqual({ showOverlay: false, overlayType: 'error' });
    });
});
