import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { Provider } from 'react-redux';
import { expect, test, vi } from 'vitest';
import updateCheckReducer from '../../dashboard/update-slice.jsx';
import UpdateCard from '../maintenance/update-card.jsx';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (_key, options) => options?.defaultValue || _key,
    }),
}));

vi.mock('../../../hooks/useUserTimeSettings.jsx', () => ({
    useUserTimeSettings: () => ({ timezone: 'UTC', locale: 'en-US' }),
}));

test('shows GitHub check errors and copies release commands', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
    });
    const store = configureStore({
        reducer: { updateCheck: updateCheckReducer },
        preloadedState: {
            updateCheck: {
                data: {
                    currentVersion: '1.2.0',
                    latestVersion: '1.3.0',
                    latestTag: 'v1.3.0',
                    latestUrl: 'https://github.com/sgoudelis/ground-station/releases/tag/v1.3.0',
                    publishedAt: '2026-10-07T10:00:00Z',
                    checkedAt: '2026-10-07T11:00:00Z',
                    isUpdateAvailable: true,
                },
                loading: false,
                error: 'Unable to check GitHub Releases: connection timed out',
                lastChecked: 1,
                lastAttempted: 2,
            },
        },
    });

    render(
        <Provider store={store}>
            <ThemeProvider theme={createTheme()}>
                <UpdateCard />
            </ThemeProvider>
        </Provider>
    );

    expect(screen.getByText('GitHub release check failed')).toBeInTheDocument();
    expect(screen.getByText('Unable to check GitHub Releases: connection timed out')).toBeInTheDocument();
    expect(screen.getByText('Check failed')).toBeInTheDocument();
    expect(screen.getByText('docker pull ghcr.io/sgoudelis/ground-station:1.3.0')).toBeInTheDocument();
    expect(screen.getByText(/--platform linux\/amd64[\s\S]*--network host/)).toBeInTheDocument();
    expect(screen.getByText(/--platform linux\/arm64[\s\S]*-p 7000:7000/)).toBeInTheDocument();

    const copyButtons = screen.getAllByRole('button', { name: 'Copy command' });
    expect(copyButtons).toHaveLength(6);
    fireEvent.click(copyButtons[0]);
    await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith('docker pull ghcr.io/sgoudelis/ground-station:1.3.0');
    });
});
