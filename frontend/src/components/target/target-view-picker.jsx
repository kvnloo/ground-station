/**
 * @license
 * Copyright (c) 2026 Efstratios Goudelis
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import React, {useMemo} from 'react';
import {Box, IconButton, ToggleButton, ToggleButtonGroup, Tooltip, useMediaQuery, useTheme} from '@mui/material';
import MapIcon from '@mui/icons-material/Map';
import PublicIcon from '@mui/icons-material/Public';
import NightsStayIcon from '@mui/icons-material/NightsStay';
import AutoModeIcon from '@mui/icons-material/AutoMode';
import WbSunnyIcon from '@mui/icons-material/WbSunny';
import {useDispatch, useSelector} from 'react-redux';
import {useTranslation} from 'react-i18next';
import {useSocket} from '../common/socket.jsx';
import {
    setAutoSwitchPlanetariumByVisibility,
    setMapEngine,
    setTargetMapSetting,
    setTargetViewMode,
    TARGET_VIEW_MODE_PLANETARIUM,
    TARGET_VIEW_MODE_SOLAR_SYSTEM,
} from './target-slice.jsx';

const MAP_ENGINE_LEAFLET = 'leaflet';
const MAP_ENGINE_MAPLIBRE = 'maplibre';
const MAP_ENGINE_MAPLIBRE_GLOBE = 'maplibre-globe';
const MAP_ENGINE_PLANETARIUM = 'planetarium';

const SATELLITE_VIEW_OPTIONS = [
    {id: 'map', labelKey: 'view_picker.map', fallback: '2D map', Icon: MapIcon},
    {id: 'globe', labelKey: 'view_picker.globe', fallback: 'Globe', Icon: PublicIcon},
    {id: 'sky', labelKey: 'view_picker.sky', fallback: 'Sky', Icon: NightsStayIcon},
    {id: 'auto', labelKey: 'view_picker.automatic', fallback: 'Auto by visibility', Icon: AutoModeIcon},
];

const CELESTIAL_VIEW_OPTIONS = [
    {id: TARGET_VIEW_MODE_SOLAR_SYSTEM, labelKey: 'view_picker.solar_system', fallback: 'Solar system', Icon: WbSunnyIcon},
    {id: TARGET_VIEW_MODE_PLANETARIUM, labelKey: 'view_picker.sky', fallback: 'Sky', Icon: NightsStayIcon},
];

const resolveSatelliteViewId = ({mapEngine, autoSwitchPlanetariumByVisibility}) => {
    if (autoSwitchPlanetariumByVisibility) return 'auto';
    if (mapEngine === MAP_ENGINE_PLANETARIUM) return 'sky';
    if (mapEngine === MAP_ENGINE_MAPLIBRE_GLOBE) return 'globe';
    return 'map';
};

/**
 * View selection is deliberately immediate: it is the primary task in this
 * island, while the settings dialog is reserved for secondary preferences.
 */
const TargetViewPicker = ({targetType}) => {
    const dispatch = useDispatch();
    const {socket} = useSocket();
    const {t} = useTranslation('target');
    const theme = useTheme();
    const isCompactHeader = useMediaQuery(theme.breakpoints.down('lg'));
    const isTightHeader = useMediaQuery(theme.breakpoints.down('md'));
    const {mapEngine, autoSwitchPlanetariumByVisibility, targetViewMode} = useSelector(
        (state) => state.targetSatTrack,
    );
    const isSatelliteTarget = targetType === 'satellite';
    const selectedViewId = useMemo(
        () => (isSatelliteTarget
            ? resolveSatelliteViewId({mapEngine, autoSwitchPlanetariumByVisibility})
            : (targetViewMode === TARGET_VIEW_MODE_PLANETARIUM
                ? TARGET_VIEW_MODE_PLANETARIUM
                : TARGET_VIEW_MODE_SOLAR_SYSTEM)),
        [autoSwitchPlanetariumByVisibility, isSatelliteTarget, mapEngine, targetViewMode],
    );
    const options = isSatelliteTarget ? SATELLITE_VIEW_OPTIONS : CELESTIAL_VIEW_OPTIONS;

    const persist = () => {
        // The view should still react locally when the socket is reconnecting.
        // A subsequent settings save will persist the current Redux state.
        if (socket) {
            dispatch(setTargetMapSetting({socket, key: 'target-map-settings'}));
        }
    };

    const handleSelect = (viewId) => {
        if (isSatelliteTarget) {
            if (viewId === 'auto') {
                dispatch(setMapEngine(MAP_ENGINE_MAPLIBRE_GLOBE));
                dispatch(setAutoSwitchPlanetariumByVisibility(true));
            } else {
                dispatch(setAutoSwitchPlanetariumByVisibility(false));
                if (viewId === 'sky') dispatch(setMapEngine(MAP_ENGINE_PLANETARIUM));
                if (viewId === 'globe') dispatch(setMapEngine(MAP_ENGINE_MAPLIBRE_GLOBE));
                if (viewId === 'map') {
                    // Preserve the user's chosen 2D implementation where possible.
                    dispatch(setMapEngine(mapEngine === MAP_ENGINE_LEAFLET ? MAP_ENGINE_LEAFLET : MAP_ENGINE_MAPLIBRE));
                }
            }
        } else {
            dispatch(setTargetViewMode(viewId));
            // A legacy planetarium engine routes directly to the satellite sky
            // island, which would otherwise prevent the selected celestial view
            // from taking effect for a mission or body target.
            if (mapEngine === MAP_ENGINE_PLANETARIUM) {
                dispatch(setMapEngine(MAP_ENGINE_MAPLIBRE));
            }
        }
        persist();
    };

    return (
        <>
            <ToggleButtonGroup
                exclusive
                size="small"
                value={selectedViewId}
                aria-label={t('view_picker.label', {defaultValue: 'View'})}
                onChange={(_event, nextViewId) => {
                    // MUI emits null when an active exclusive button is pressed.
                    // A view must always remain selected, so ignore that action.
                    if (nextViewId) handleSelect(nextViewId);
                }}
                sx={{
                    flexShrink: 0,
                    gap: 0.5,
                    // The island can be narrow even when the browser viewport is wide.
                    '@container target-view-header (max-width: 650px)': {display: 'none'},
                    '& .MuiToggleButtonGroup-grouped': {
                        // Keep the same individual outlined/contained treatment as
                        // the quick filters in the passes-table title bar.
                        minHeight: isTightHeader ? 20 : (isCompactHeader ? 22 : 24),
                        height: isTightHeader ? 20 : (isCompactHeader ? 22 : 24),
                        minWidth: 'auto',
                        px: isTightHeader ? 0.7 : (isCompactHeader ? 0.85 : 1),
                        textTransform: 'none',
                        whiteSpace: 'nowrap',
                        fontSize: isTightHeader ? '0.64rem' : (isCompactHeader ? '0.68rem' : '0.72rem'),
                        color: 'primary.main',
                        borderColor: 'primary.main',
                        borderRadius: 1,
                        '&:not(:first-of-type)': {
                            borderLeft: '1px solid',
                            borderLeftColor: 'primary.main',
                            ml: 0,
                        },
                        '&:hover': {
                            bgcolor: 'action.hover',
                            borderColor: 'primary.main',
                        },
                        '&.Mui-selected': {
                            color: 'primary.contrastText',
                            bgcolor: 'primary.main',
                            borderColor: 'primary.main',
                            '&:hover': {
                                bgcolor: 'primary.dark',
                            },
                        },
                    },
                }}
            >
                {options.map((option) => (
                    <ToggleButton key={option.id} value={option.id} aria-label={t(option.labelKey, {defaultValue: option.fallback})}>
                        {t(option.labelKey, {defaultValue: option.fallback})}
                    </ToggleButton>
                ))}
            </ToggleButtonGroup>
            <Box
                role="group"
                aria-label={t('view_picker.label', {defaultValue: 'View'})}
                sx={{
                    display: 'none',
                    alignItems: 'center',
                    gap: 0.5,
                    flexShrink: 0,
                    '@container target-view-header (max-width: 650px)': {display: 'flex'},
                }}
            >
                {options.map((option) => {
                    const label = t(option.labelKey, {defaultValue: option.fallback});
                    const selected = option.id === selectedViewId;
                    return (
                        <Tooltip key={option.id} title={label}>
                            <IconButton
                                size="small"
                                aria-label={label}
                                aria-pressed={selected}
                                onClick={() => {
                                    if (!selected) handleSelect(option.id);
                                }}
                                sx={{
                                    width: 24,
                                    height: 24,
                                    p: 0.25,
                                    border: '1px solid',
                                    borderColor: 'primary.main',
                                    borderRadius: 1,
                                    color: selected ? 'primary.contrastText' : 'primary.main',
                                    bgcolor: selected ? 'primary.main' : 'transparent',
                                    '&:hover': {
                                        bgcolor: selected ? 'primary.dark' : 'action.hover',
                                    },
                                }}
                            >
                                <option.Icon sx={{fontSize: 16}}/>
                            </IconButton>
                        </Tooltip>
                    );
                })}
            </Box>
        </>
    );
};

export default TargetViewPicker;
