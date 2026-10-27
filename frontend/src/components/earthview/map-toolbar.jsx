/**
 * @license
 * Copyright (c) 2026 Efstratios Goudelis
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Box, Divider, IconButton, Paper, Stack, Tooltip} from '@mui/material';
import HomeIcon from '@mui/icons-material/Home';
import FilterCenterFocusIcon from '@mui/icons-material/FilterCenterFocus';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import TrackChangesIcon from '@mui/icons-material/TrackChanges';
import PanToolIcon from '@mui/icons-material/PanTool';
import ZoomInMapIcon from '@mui/icons-material/ZoomInMap';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import HistoryIcon from '@mui/icons-material/History';
import RouteIcon from '@mui/icons-material/Route';
import RadarIcon from '@mui/icons-material/Radar';
import GridOnIcon from '@mui/icons-material/GridOn';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import {useDispatch, useSelector} from 'react-redux';
import {useTranslation} from 'react-i18next';
import {useSocket} from '../common/socket.jsx';
import {
    setEarthViewMapSetting, setEnableMapDragging, setEnableMapZooming,
    setShowPastOrbitPath, setShowFutureOrbitPath, setShowSatelliteCoverage, setShowGrid,
} from './earthview-slice.jsx';

function ToolbarButton({label, icon, onClick, disabled = false, pressed, tooltipContainer}) {
    return (
        <Tooltip title={label} slotProps={{popper: {container: tooltipContainer}}}>
            <span>
                <IconButton size="small" color={pressed ? 'warning' : 'primary'} onClick={onClick}
                            disabled={disabled} aria-label={label}
                            {...(pressed !== undefined ? {'aria-pressed': pressed} : {})}
                            sx={{borderRadius: 0}}>
                    {icon}
                </IconButton>
            </span>
        </Tooltip>
    );
}

function MapToolbar({homeDisabled, followDisabled, following, onHome, onCenter, onFitEarth,
                     onToggleFollow, onZoomIn, onZoomOut, onFullscreen, isFullscreen, tooltipContainer}) {
    const {t} = useTranslation('earthview');
    const {socket} = useSocket();
    const dispatch = useDispatch();
    const {enableMapDragging, enableMapZooming, showPastOrbitPath, showFutureOrbitPath,
        showSatelliteCoverage, showGrid} = useSelector((state) => state.earthViewTrack);
    const scrollViewportRef = useRef(null);
    const [scrollState, setScrollState] = useState({hasOverflow: false, atStart: true, atEnd: true});

    const updateScrollState = useCallback(() => {
        const viewport = scrollViewportRef.current;
        if (!viewport) return;
        const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
        const nextState = {hasOverflow: maxScrollLeft > 2, atStart: viewport.scrollLeft <= 2,
            atEnd: viewport.scrollLeft >= maxScrollLeft - 2};
        setScrollState((current) => current.hasOverflow === nextState.hasOverflow
            && current.atStart === nextState.atStart && current.atEnd === nextState.atEnd
            ? current : nextState);
    }, []);

    useEffect(() => {
        const viewport = scrollViewportRef.current;
        if (!viewport) return undefined;
        const frame = requestAnimationFrame(updateScrollState);
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScrollState);
        observer?.observe(viewport);
        window.addEventListener('resize', updateScrollState);
        viewport.addEventListener('scroll', updateScrollState, {passive: true});
        return () => {
            cancelAnimationFrame(frame);
            observer?.disconnect();
            window.removeEventListener('resize', updateScrollState);
            viewport.removeEventListener('scroll', updateScrollState);
        };
    }, [updateScrollState]);

    const scrollToolbar = (direction) => {
        const viewport = scrollViewportRef.current;
        viewport?.scrollBy({left: direction * Math.max(160, viewport.clientWidth * 0.75), behavior: 'smooth'});
    };

    const toggleSetting = (action, value) => {
        dispatch(action(!value));
        // Quick toggles persist through the same backend setting as the dialog.
        if (socket) dispatch(setEarthViewMapSetting({socket, key: 'earth-view-map-settings'}));
    };

    const buttons = [
        {key: 'home', label: t('map_controls.go_home'), icon: <HomeIcon />, onClick: onHome, disabled: homeDisabled},
        {key: 'center', label: t('map_controls.go_to_center'), icon: <FilterCenterFocusIcon />, onClick: onCenter},
        {key: 'fit', label: t('map_controls.fit_earth'), icon: <FitScreenIcon />, onClick: onFitEarth},
        {key: 'follow', label: t('map_controls.follow_selected'), icon: <TrackChangesIcon />, onClick: onToggleFollow, disabled: followDisabled, pressed: following},
        {key: 'divider-1'},
        {key: 'pan', label: t('map_controls.enable_panning'), icon: <PanToolIcon />, onClick: () => toggleSetting(setEnableMapDragging, enableMapDragging), pressed: enableMapDragging},
        {key: 'gesture-zoom', label: t('map_controls.enable_gesture_zoom'), icon: <ZoomInMapIcon />, onClick: () => toggleSetting(setEnableMapZooming, enableMapZooming), pressed: enableMapZooming},
        {key: 'zoom-out', label: t('map_controls.zoom_out'), icon: <ZoomOutIcon />, onClick: onZoomOut},
        {key: 'zoom-in', label: t('map_controls.zoom_in'), icon: <ZoomInIcon />, onClick: onZoomIn},
        {key: 'divider-2'},
        {key: 'past', label: t('map_controls.show_past_path'), icon: <HistoryIcon />, onClick: () => toggleSetting(setShowPastOrbitPath, showPastOrbitPath), pressed: showPastOrbitPath},
        {key: 'future', label: t('map_controls.show_future_path'), icon: <RouteIcon />, onClick: () => toggleSetting(setShowFutureOrbitPath, showFutureOrbitPath), pressed: showFutureOrbitPath},
        {key: 'coverage', label: t('map_controls.show_coverage'), icon: <RadarIcon />, onClick: () => toggleSetting(setShowSatelliteCoverage, showSatelliteCoverage), pressed: showSatelliteCoverage},
        {key: 'grid', label: t('map_controls.show_grid'), icon: <GridOnIcon />, onClick: () => toggleSetting(setShowGrid, showGrid), pressed: showGrid},
        {key: 'divider-3'},
        {key: 'fullscreen', label: t(isFullscreen ? 'map_controls.exit_fullscreen' : 'map_controls.go_fullscreen'), icon: isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />, onClick: onFullscreen, pressed: isFullscreen},
    ];

    return (
        <Paper elevation={1} sx={{width: '100%', borderBottom: '1px solid', borderColor: 'divider', borderRadius: 0}}>
            <Box sx={{display: 'flex', alignItems: 'center', overflow: 'hidden'}}>
                {scrollState.hasOverflow && <ToolbarButton label={t('map_controls.scroll_left')} icon={<ChevronLeftIcon />} onClick={() => scrollToolbar(-1)} disabled={scrollState.atStart} tooltipContainer={tooltipContainer} />}
                <Box ref={scrollViewportRef} sx={{minWidth: 0, flex: 1, overflowX: 'auto', scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch', '&::-webkit-scrollbar': {display: 'none'}}}>
                    <Stack direction="row" spacing={0} role="toolbar" aria-label={t('map_controls.toolbar')} sx={{minWidth: 'min-content', flexWrap: 'nowrap'}}>
                        {buttons.map((button) => button.label
                            ? <ToolbarButton key={button.key} {...button} tooltipContainer={tooltipContainer} />
                            : <Divider key={button.key} orientation="vertical" flexItem sx={{mx: 0.5}} />)}
                    </Stack>
                </Box>
                {scrollState.hasOverflow && <ToolbarButton label={t('map_controls.scroll_right')} icon={<ChevronRightIcon />} onClick={() => scrollToolbar(1)} disabled={scrollState.atEnd} tooltipContainer={tooltipContainer} />}
            </Box>
        </Paper>
    );
}

export default React.memo(MapToolbar);
