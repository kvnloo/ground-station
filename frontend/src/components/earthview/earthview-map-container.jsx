/**
 * @license
 * Copyright (c) 2025 Efstratios Goudelis
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
 *
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useDispatch, useSelector} from 'react-redux';
import {useTranslation} from 'react-i18next';
import {normalizeMapEngine} from '../common/tile-layers.jsx';
import {
    MapLoadErrorDialog,
    MapRendererErrorBoundary,
    useMapLoadFailure,
} from '../common/map-load-error.jsx';
import LeafletEarthViewMapRenderer from './earthview-map-leaflet.jsx';
import MapLibreEarthViewMapRenderer from './earthview-map-maplibre.jsx';
import {useSocket} from '../common/socket.jsx';
import {toast} from '../../utils/toast-with-timestamp.jsx';
import RowContextMenu from './rowcontextmenu.jsx';
import SatelliteEditDialog from '../satellites/satellite-edit-dialog.jsx';
import TransmittersDialog from '../satellites/transmitters-dialog.jsx';
import {SatelliteInfoDialog} from '../satellites/satellite-info-page.jsx';
import {fetchSatellite} from '../satellites/satellite-slice.jsx';
import {
    fetchSatellitesByGroupId,
    setEarthViewMapSetting,
    setMapEngine,
    setSatelliteData,
    setSelectedSatelliteId,
} from './earthview-slice.jsx';
import {
    setDialogOpen,
    setMonitoredSatelliteDialogOpen,
    setSelectedMonitoredSatellite,
    setSelectedObservation,
} from '../scheduler/scheduler-slice.jsx';

const EarthViewMapContainer = ({handleSetTrackingOnBackend}) => {
    const dispatch = useDispatch();
    const {socket} = useSocket();
    const {t} = useTranslation('earthview');
    const {t: commonT} = useTranslation('common');
    const {t: satellitesT} = useTranslation('satellites');
    const mapEngine = useSelector((state) => state.earthViewTrack?.mapEngine);
    const tileLayerID = useSelector((state) => state.earthViewTrack?.tileLayerID);
    const selectedSatGroupId = useSelector((state) => state.earthViewTrack?.selectedSatGroupId);
    const selectedSatelliteId = useSelector((state) => state.earthViewTrack?.selectedSatelliteId);
    const selectedSatellitePositions = useSelector((state) => state.earthViewTrack?.selectedSatellitePositions);
    const normalizedMapEngine = normalizeMapEngine(mapEngine);
    const Renderer = normalizedMapEngine === 'maplibre'
        ? MapLibreEarthViewMapRenderer
        : LeafletEarthViewMapRenderer;
    const engineName = normalizedMapEngine === 'maplibre' ? 'MapLibre' : 'Leaflet';
    const mapLoadFailure = useMapLoadFailure({
        engine: engineName,
        loadKey: `${normalizedMapEngine}:${tileLayerID || ''}`,
    });

    const [satelliteContextMenu, setSatelliteContextMenu] = useState(null);
    const [satelliteEditDialogOpen, setSatelliteEditDialogOpen] = useState(false);
    const [transmittersDialogOpen, setTransmittersDialogOpen] = useState(false);
    const [contextSatelliteForDialogs, setContextSatelliteForDialogs] = useState(null);
    const latestDialogSatelliteRequestRef = useRef(0);
    const [infoSatellite, setInfoSatellite] = useState(null);
    const latestInfoRequestRef = useRef(0);

    useEffect(() => () => {
        // A pending request must not reopen the dialog after the map unmounts.
        latestInfoRequestRef.current += 1;
    }, []);

    const handleOpenSatelliteInfo = useCallback(async (satellite) => {
        const noradId = Number(satellite?.norad_id ?? satellite?.noradId);
        if (!socket || !Number.isInteger(noradId) || noradId <= 0) return;

        // Only the latest clicked satellite may open the dialog.
        const requestId = ++latestInfoRequestRef.current;
        setInfoSatellite(null);
        try {
            const response = await dispatch(fetchSatellite({socket, noradId})).unwrap();
            if (latestInfoRequestRef.current !== requestId) return;
            if (Number(response?.details?.norad_id) !== noradId) {
                throw new Error('Satellite details unavailable');
            }
            setInfoSatellite({
                ...response.details,
                position: response.position || null,
                transmitters: response.transmitters || [],
            });
        } catch (error) {
            if (latestInfoRequestRef.current === requestId) {
                toast.error(satellitesT('satellite_database.failed_load'));
            }
        }
    }, [dispatch, satellitesT, socket]);

    const handleCloseSatelliteInfo = useCallback(() => {
        latestInfoRequestRef.current += 1;
        setInfoSatellite(null);
    }, []);

    const copyTextToClipboard = useCallback(async (text) => {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }

        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'absolute';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
    }, []);

    const normalizeSatelliteRow = useCallback((satellite) => {
        if (!satellite || typeof satellite !== 'object') {
            return null;
        }
        const noradId = satellite.norad_id ?? satellite.noradId;
        if (noradId == null) {
            return null;
        }
        return {
            ...satellite,
            norad_id: noradId,
            name: satellite.name || `NORAD ${noradId}`,
        };
    }, []);

    const handleCloseSatelliteContextMenu = useCallback(() => {
        setSatelliteContextMenu(null);
    }, []);

    const handleSuppressNativeContextMenu = useCallback((event) => {
        event.preventDefault();
        if (typeof event.stopPropagation === 'function') {
            event.stopPropagation();
        }
        setSatelliteContextMenu(null);
    }, []);

    const handleSatelliteMarkerContextMenu = useCallback((satellite, event) => {
        const row = normalizeSatelliteRow(satellite);
        if (!row) {
            return;
        }

        const nativeEvent = event?.originalEvent || event;
        nativeEvent?.preventDefault?.();
        nativeEvent?.stopPropagation?.();
        event?.preventDefault?.();
        event?.stopPropagation?.();

        // UX preference: the next right click closes the currently open menu.
        if (satelliteContextMenu) {
            setSatelliteContextMenu(null);
            return;
        }

        const rowNorad = Number(row.norad_id);
        if (!Number.isNaN(rowNorad)) {
            dispatch(setSelectedSatelliteId(rowNorad));
        } else {
            dispatch(setSelectedSatelliteId(row.norad_id));
        }

        setSatelliteContextMenu({
            mouseX: (nativeEvent?.clientX ?? 0) + 2,
            mouseY: (nativeEvent?.clientY ?? 0) - 6,
            row,
        });
    }, [dispatch, normalizeSatelliteRow, satelliteContextMenu]);

    const hydrateSatelliteForDialogs = useCallback((row) => {
        if (!row) {
            return;
        }

        setContextSatelliteForDialogs(row);
        const parsedNoradId = Number(row.norad_id);
        if (Number.isNaN(parsedNoradId) || !socket) {
            return;
        }

        const requestId = latestDialogSatelliteRequestRef.current + 1;
        latestDialogSatelliteRequestRef.current = requestId;
        dispatch(fetchSatellite({socket, noradId: parsedNoradId}))
            .unwrap()
            .then((response) => {
                if (latestDialogSatelliteRequestRef.current !== requestId) {
                    return;
                }
                const details = response?.details || {};
                const transmitters = Array.isArray(response?.transmitters)
                    ? response.transmitters
                    : (row?.transmitters || []);
                setContextSatelliteForDialogs({
                    ...row,
                    ...details,
                    transmitters,
                });
            })
            .catch(() => {
                // Keep using marker payload when details fetch fails.
            });
    }, [dispatch, socket]);

    const buildSchedulerSatellitePayload = useCallback((row) => {
        return {
            norad_id: row?.norad_id ?? '',
            name: row?.name || `NORAD ${row?.norad_id ?? ''}`,
            group_id: row?.group_id || selectedSatGroupId || '',
        };
    }, [selectedSatGroupId]);

    const handleOpenSatelliteEditDialog = useCallback((row) => {
        if (!row) {
            return;
        }
        setSatelliteEditDialogOpen(true);
        hydrateSatelliteForDialogs(row);
    }, [hydrateSatelliteForDialogs]);

    const handleOpenTransmittersDialog = useCallback((row) => {
        if (!row) {
            return;
        }
        setTransmittersDialogOpen(true);
        hydrateSatelliteForDialogs(row);
    }, [hydrateSatelliteForDialogs]);

    const handleScheduleObservation = useCallback((row) => {
        const satellite = buildSchedulerSatellitePayload(row);
        dispatch(setSelectedMonitoredSatellite(null));
        dispatch(setMonitoredSatelliteDialogOpen(false));
        dispatch(setSelectedObservation({
            name: `${satellite.name} observation`,
            enabled: true,
            satellite,
            pass: null,
            sessions: [],
            rotator: {
                id: null,
                tracking_enabled: false,
                unpark_before_tracking: false,
                park_after_observation: false,
            },
            rig: {id: null, doppler_correction: false, vfo: 'VFO_A'},
        }));
        dispatch(setDialogOpen(true));
    }, [buildSchedulerSatellitePayload, dispatch]);

    const handleMonitorSatellite = useCallback((row) => {
        const satellite = buildSchedulerSatellitePayload(row);
        dispatch(setSelectedObservation(null));
        dispatch(setDialogOpen(false));
        dispatch(setSelectedMonitoredSatellite({
            enabled: true,
            satellite,
            sessions: [],
            rotator: {
                id: null,
                tracking_enabled: false,
                unpark_before_tracking: false,
                park_after_observation: false,
            },
            rig: {id: null, doppler_correction: false, vfo: 'VFO_A'},
            min_elevation: 20,
            task_start_elevation: 10,
            lookahead_hours: 24,
        }));
        dispatch(setMonitoredSatelliteDialogOpen(true));
    }, [buildSchedulerSatellitePayload, dispatch]);

    const handleSatelliteSaved = useCallback(() => {
        if (!selectedSatGroupId || selectedSatGroupId === 'none' || !socket) {
            return;
        }
        dispatch(fetchSatellitesByGroupId({socket, satGroupId: selectedSatGroupId}));
    }, [dispatch, selectedSatGroupId, socket]);

    const handleSwitchMapEngine = useCallback(() => {
        const nextEngine = normalizedMapEngine === 'maplibre' ? 'leaflet' : 'maplibre';
        mapLoadFailure.dismiss();
        dispatch(setMapEngine(nextEngine));
        if (socket) {
            dispatch(setEarthViewMapSetting({socket, key: 'earth-view-map-settings'}));
        }
    }, [dispatch, mapLoadFailure, normalizedMapEngine, socket]);

    const handleMapSatelliteMenuAction = useCallback(async (action) => {
        const row = satelliteContextMenu?.row;
        if (!row) {
            return;
        }

        try {
            if (action === 'set-target') {
                await handleSetTrackingOnBackend?.({
                    noradId: row.norad_id,
                    satelliteName: row.name,
                });
                return;
            }

            if (action === 'edit-properties') {
                handleOpenSatelliteEditDialog(row);
                return;
            }

            if (action === 'edit-transmitters') {
                handleOpenTransmittersDialog(row);
                return;
            }

            if (action === 'schedule-observation') {
                handleScheduleObservation(row);
                return;
            }

            if (action === 'monitor-satellite') {
                handleMonitorSatellite(row);
                return;
            }

            if (action === 'copy-norad') {
                await copyTextToClipboard(String(row.norad_id ?? ''));
                toast.success('NORAD ID copied to clipboard');
                return;
            }

            if (action === 'copy-summary') {
                const totalTx = Array.isArray(row.transmitters) ? row.transmitters.length : 0;
                const activeTx = Array.isArray(row.transmitters)
                    ? row.transmitters.filter((tx) => tx.alive).length
                    : 0;
                const summary = `${row.name || '-'} | NORAD ${row.norad_id ?? '-'} | Status ${row.status || 'unknown'} | TX ${activeTx}/${totalTx}`;
                await copyTextToClipboard(summary);
                toast.success('Satellite summary copied to clipboard');
            }
        } catch (error) {
            toast.error(`Failed to process menu action: ${error?.message || 'Unknown error'}`);
        } finally {
            setSatelliteContextMenu(null);
        }
    }, [
        copyTextToClipboard,
        handleMonitorSatellite,
        handleOpenSatelliteEditDialog,
        handleOpenTransmittersDialog,
        handleScheduleObservation,
        handleSetTrackingOnBackend,
        satelliteContextMenu,
    ]);

    const mapSatelliteContextMenuItems = useMemo(() => ([
        {
            key: 'set-target',
            label: t('satellites_table.context_menu.set_as_target'),
            opensDialog: true,
            onClick: () => handleMapSatelliteMenuAction('set-target'),
        },
        {
            key: 'edit-properties',
            label: t('satellites_table.context_menu.edit_properties'),
            opensDialog: true,
            onClick: () => handleMapSatelliteMenuAction('edit-properties'),
        },
        {
            key: 'edit-transmitters',
            label: t('satellites_table.context_menu.edit_transmitters'),
            opensDialog: true,
            onClick: () => handleMapSatelliteMenuAction('edit-transmitters'),
        },
        {
            key: 'schedule-observation',
            label: t('satellites_table.context_menu.schedule_observation'),
            opensDialog: true,
            onClick: () => handleMapSatelliteMenuAction('schedule-observation'),
        },
        {
            key: 'monitor-satellite',
            label: t('satellites_table.context_menu.monitor_satellite'),
            opensDialog: true,
            onClick: () => handleMapSatelliteMenuAction('monitor-satellite'),
        },
        {type: 'divider', key: 'divider-copy'},
        {
            key: 'copy-norad',
            label: t('satellites_table.context_menu.copy_norad'),
            onClick: () => handleMapSatelliteMenuAction('copy-norad'),
        },
        {
            key: 'copy-summary',
            label: t('satellites_table.context_menu.copy_summary'),
            onClick: () => handleMapSatelliteMenuAction('copy-summary'),
        },
    ]), [handleMapSatelliteMenuAction, t]);

    return (
        <>
            <MapRendererErrorBoundary
                key={`${normalizedMapEngine}:${tileLayerID || ''}:${mapLoadFailure.attempt}`}
                onError={mapLoadFailure.reportError}
            >
                <Renderer
                    handleSetTrackingOnBackend={handleSetTrackingOnBackend}
                    onOpenSatelliteInfo={handleOpenSatelliteInfo}
                    onMapError={mapLoadFailure.reportError}
                    onMapLoaded={mapLoadFailure.reportLoaded}
                    onSatelliteMarkerContextMenu={handleSatelliteMarkerContextMenu}
                />
            </MapRendererErrorBoundary>
            <MapLoadErrorDialog
                failure={mapLoadFailure.failure}
                onClose={mapLoadFailure.dismiss}
                onRetry={mapLoadFailure.retry}
                onSwitchEngine={handleSwitchMapEngine}
                switchEngineLabel={normalizedMapEngine === 'maplibre'
                    ? commonT('map_load_error.switch_to_leaflet')
                    : commonT('map_load_error.switch_to_maplibre')}
            />
            <SatelliteInfoDialog
                open={Boolean(infoSatellite)}
                onClose={handleCloseSatelliteInfo}
                satelliteData={infoSatellite}
                targetGroupId={selectedSatGroupId}
                livePosition={infoSatellite
                    ? selectedSatellitePositions?.[infoSatellite.norad_id] || null
                    : null}
                onUpdated={(updatedSatellite) => {
                    if (Number(selectedSatelliteId) === Number(updatedSatellite?.details?.norad_id)) {
                        dispatch(setSatelliteData(updatedSatellite));
                    }
                }}
            />
            <RowContextMenu
                open={Boolean(satelliteContextMenu)}
                onClose={handleCloseSatelliteContextMenu}
                onSuppressNativeContextMenu={handleSuppressNativeContextMenu}
                anchorPosition={
                    satelliteContextMenu
                        ? {top: satelliteContextMenu.mouseY, left: satelliteContextMenu.mouseX}
                        : undefined
                }
                title={satelliteContextMenu?.row?.name || `NORAD ${satelliteContextMenu?.row?.norad_id ?? '-'}`}
                noradId={satelliteContextMenu?.row?.norad_id}
                items={mapSatelliteContextMenuItems}
            />
            <SatelliteEditDialog
                open={satelliteEditDialogOpen}
                onClose={() => setSatelliteEditDialogOpen(false)}
                satelliteData={contextSatelliteForDialogs}
                onSaved={handleSatelliteSaved}
            />
            <TransmittersDialog
                open={transmittersDialogOpen}
                onClose={() => setTransmittersDialogOpen(false)}
                title={t('satellites_table.context_menu.edit_transmitters_title', {
                    name: contextSatelliteForDialogs?.name || contextSatelliteForDialogs?.norad_id || '',
                })}
                satelliteData={contextSatelliteForDialogs}
                variant="paper"
                widthOffsetPx={20}
            />
        </>
    );
};

export default EarthViewMapContainer;
