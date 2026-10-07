/**
 * @license
 * Copyright (c) 2026 Efstratios Goudelis
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import * as React from 'react';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {
    Alert,
    Box,
    CircularProgress,
    IconButton,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Tooltip,
    Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import {useSelector} from 'react-redux';
import {useTranslation} from 'react-i18next';
import {useSocket} from '../common/socket.jsx';
import {formatDateTime} from '../../utils/date-time.js';

const normalizeForecastHours = (value) => {
    const hours = Number(value);
    return Number.isFinite(hours) && hours > 0 ? hours : 24;
};

const formatDuration = (pass) => {
    if (pass?.is_geostationary || pass?.is_geosynchronous) return '∞';
    if (!pass?.event_start || !pass?.event_end) return '—';

    const start = new Date(pass?.event_start).getTime();
    const end = new Date(pass?.event_end).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';

    const seconds = Math.floor((end - start) / 1000);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
};

const formatNumber = (value, digits, suffix) => {
    if (value == null || value === '') return '—';
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(digits)}${suffix}` : '—';
};

const SatellitePasses = ({noradId, enabled = true}) => {
    const {t, i18n} = useTranslation('satellites');
    const {socket} = useSocket();
    const configuredHours = useSelector((state) => state.targetSatTrack?.nextPassesHours);
    const timezone = useSelector((state) => {
        const timezonePreference = state.preferences?.preferences?.find((preference) => preference.name === 'timezone');
        return timezonePreference?.value || 'UTC';
    });
    const hours = normalizeForecastHours(configuredHours);
    const [passes, setPasses] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const [refreshSequence, setRefreshSequence] = useState(0);

    const requestPasses = useCallback((forceRecalculate = false) => {
        if (!enabled || !socket || noradId == null) return () => {};

        let cancelled = false;
        setLoading(true);
        setError(false);

        socket.emit('api.call', {
            cmd: 'fetch-next-passes',
            data: {
                norad_id: Number(noradId),
                hours,
                force_recalculate: forceRecalculate,
            },
        }, (response) => {
            if (cancelled) return;
            if (response?.success) {
                setPasses(Array.isArray(response.data) ? response.data : []);
                setError(false);
            } else {
                setPasses([]);
                setError(true);
            }
            setLoading(false);
        });

        return () => {
            cancelled = true;
        };
    }, [enabled, hours, noradId, socket]);

    useEffect(() => {
        if (!enabled) {
            setPasses([]);
            setLoading(false);
            setError(false);
            return undefined;
        }
        return requestPasses(refreshSequence > 0);
    }, [enabled, refreshSequence, requestPasses]);

    const dateTimeOptions = useMemo(() => ({
        timezone,
        locale: i18n.language,
        options: {
            dateStyle: 'medium',
            timeStyle: 'medium',
        },
    }), [i18n.language, timezone]);

    const handleRefresh = () => {
        setRefreshSequence((sequence) => sequence + 1);
    };

    return (
        <Box
            data-testid="satellite-future-passes"
            sx={{
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 2,
                bgcolor: 'background.paper',
                overflow: 'hidden',
            }}
        >
            <Box sx={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 0.75}}>
                <Typography variant="subtitle1" sx={{fontWeight: 600}}>
                    {t('satellite_info.future_passes.title', {hours})}
                </Typography>
                <Tooltip title={t('satellite_info.future_passes.refresh')}>
                    <span>
                        <IconButton
                            size="small"
                            aria-label={t('satellite_info.future_passes.refresh')}
                            disabled={loading || !enabled || noradId == null}
                            onClick={handleRefresh}
                        >
                            <RefreshIcon fontSize="small" />
                        </IconButton>
                    </span>
                </Tooltip>
            </Box>

            {loading && passes.length === 0 && (
                <Box sx={{minHeight: 112, display: 'grid', placeItems: 'center'}}>
                    <CircularProgress size={28} aria-label={t('satellite_info.future_passes.loading')} />
                </Box>
            )}

            {!loading && error && (
                <Alert severity="error" sx={{borderRadius: 0}}>
                    {t('satellite_info.future_passes.error')}
                </Alert>
            )}

            {!loading && !error && passes.length === 0 && (
                <Box sx={{minHeight: 96, display: 'grid', placeItems: 'center', px: 2, textAlign: 'center'}}>
                    <Typography variant="body2" color="text.secondary">
                        {t('satellite_info.future_passes.empty', {hours})}
                    </Typography>
                </Box>
            )}

            {passes.length > 0 && (
                <TableContainer sx={{maxHeight: 320, borderTop: '1px solid', borderColor: 'divider'}}>
                    <Table stickyHeader size="small" aria-label={t('satellite_info.future_passes.table_label')}>
                        <TableHead>
                            <TableRow>
                                <TableCell>{t('satellite_info.future_passes.aos')}</TableCell>
                                <TableCell>{t('satellite_info.future_passes.los')}</TableCell>
                                <TableCell align="center">{t('satellite_info.future_passes.duration')}</TableCell>
                                <TableCell align="center">{t('satellite_info.future_passes.max_elevation')}</TableCell>
                                <TableCell align="center" sx={{display: {xs: 'none', md: 'table-cell'}}}>
                                    {t('satellite_info.future_passes.azimuth')}
                                </TableCell>
                                <TableCell align="center" sx={{display: {xs: 'none', sm: 'table-cell'}}}>
                                    {t('satellite_info.future_passes.closest_distance')}
                                </TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {passes.map((pass, index) => (
                                <TableRow key={pass.id ?? `${pass.event_start}-${index}`} hover>
                                    <TableCell sx={{whiteSpace: 'nowrap'}}>
                                        {formatDateTime(pass.event_start, dateTimeOptions) || '—'}
                                    </TableCell>
                                    <TableCell sx={{whiteSpace: 'nowrap'}}>
                                        {formatDateTime(pass.event_end, dateTimeOptions) || '—'}
                                    </TableCell>
                                    <TableCell align="center" sx={{whiteSpace: 'nowrap'}}>
                                        {formatDuration(pass)}
                                    </TableCell>
                                    <TableCell align="center" sx={{whiteSpace: 'nowrap'}}>
                                        {formatNumber(pass.peak_altitude, 1, '°')}
                                    </TableCell>
                                    <TableCell align="center" sx={{display: {xs: 'none', md: 'table-cell'}, whiteSpace: 'nowrap'}}>
                                        {formatNumber(pass.start_azimuth, 0, '°')} → {formatNumber(pass.end_azimuth, 0, '°')}
                                    </TableCell>
                                    <TableCell align="center" sx={{display: {xs: 'none', sm: 'table-cell'}, whiteSpace: 'nowrap'}}>
                                        {formatNumber(pass.distance_at_peak, 0, ' km')}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}
        </Box>
    );
};

export default SatellitePasses;
