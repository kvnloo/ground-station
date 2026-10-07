import {
    applySDRConfigParameters,
    setIsStreaming,
    setSelectedPlaybackRecording,
    selectSdrForWatch,
    setWatchingSdrId,
    updateSDRConfig,
} from './waterfall-slice.jsx';

export const callSdrApi = (socket, command, selectedSDRId) => new Promise((resolve) => {
    if (!socket) {
        resolve({ success: false, error: 'Socket is not connected' });
        return;
    }
    socket.emit('api.call', {
        cmd: `sdr.${command}`,
        data: { selectedSDRId },
    }, (response) => resolve(response || { success: false, error: 'No response from server' }));
});

export const liveConfigToUpdates = (config) => {
    if (!config) return {};
    const mapping = {
        center_freq: 'centerFrequency',
        sample_rate: 'sampleRate',
        fft_size: 'fftSize',
        fft_window: 'fftWindow',
        fft_averaging: 'fftAveraging',
        fft_overlap_percent: 'fftOverlapPercent',
        fft_overlap_depth: 'fftOverlapDepth',
        bias_t: 'biasT',
        tuner_agc: 'tunerAgc',
        rtl_agc: 'rtlAgc',
        soapy_agc: 'soapyAgc',
        offset_freq: 'offsetFrequency',
        antenna: 'antenna',
        sdr_settings: 'sdrSettings',
        recording_path: 'recordingPath',
    };
    const updates = {};
    for (const [backendKey, frontendKey] of Object.entries(mapping)) {
        if (config[backendKey] !== undefined) updates[frontendKey] = config[backendKey];
    }
    if (config.gain !== undefined) updates.gain = config.gain;
    return updates;
};

export const watchSdr = async (socket, dispatch, selectedSDRId) => {
    const response = await callSdrApi(socket, 'watch-sdr', selectedSDRId);
    if (response?.success) {
        const config = response.data?.config;
        dispatch(selectSdrForWatch(selectedSDRId));
        if (response.data?.parameters) {
            // Capability choices come from the pre-stream probe; the worker's
            // current config below remains authoritative for selected values.
            dispatch(applySDRConfigParameters({
                selectedSDRId,
                data: response.data.parameters,
            }));
        }
        if (selectedSDRId === 'sigmf-playback') dispatch(setSelectedPlaybackRecording(null));
        if (config) dispatch(updateSDRConfig({ ...config, force_live: true }));
        dispatch(setWatchingSdrId(selectedSDRId));
        dispatch(setIsStreaming(true));
    }
    return response;
};

export const unwatchSdr = async (socket, dispatch, selectedSDRId) => {
    const response = await callSdrApi(socket, 'unwatch-sdr', selectedSDRId);
    if (response?.success) {
        dispatch(setWatchingSdrId(null));
        dispatch(setIsStreaming(false));
    }
    return response;
};
