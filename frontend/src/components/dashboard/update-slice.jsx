import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

export const fetchUpdateCheck = createAsyncThunk(
    'updateCheck/fetchUpdateCheck',
    async ({ force = false } = {}, { rejectWithValue }) => {
        try {
            const response = await fetch(force ? '/api/update-check?refresh=true' : '/api/update-check', {
                cache: 'no-store',
            });
            let payload = null;
            try {
                payload = await response.json();
            } catch {
                // Preserve the HTTP status below when the response has no JSON body.
            }
            if (!response.ok) {
                throw new Error(payload?.detail || `Update check failed (HTTP ${response.status})`);
            }
            return payload;
        } catch (error) {
            return rejectWithValue(error instanceof Error ? error.message : 'Update check failed');
        }
    }
);

const updateSlice = createSlice({
    name: 'updateCheck',
    initialState: {
        data: {
            currentVersion: null,
            latestVersion: null,
            latestTag: null,
            latestUrl: null,
            publishedAt: null,
            checkedAt: null,
            isUpdateAvailable: false,
        },
        loading: false,
        error: null,
        lastChecked: null,
        lastAttempted: null,
    },
    reducers: {},
    extraReducers: (builder) => {
        builder
            .addCase(fetchUpdateCheck.pending, (state) => {
                state.loading = true;
                state.error = null;
                state.lastAttempted = Date.now();
            })
            .addCase(fetchUpdateCheck.fulfilled, (state, action) => {
                state.loading = false;
                state.data = action.payload || state.data;
                state.lastChecked = Date.now();
            })
            .addCase(fetchUpdateCheck.rejected, (state, action) => {
                state.loading = false;
                state.error = action.payload || action.error?.message || 'Update check failed';
            });
    },
});

export default updateSlice.reducer;
