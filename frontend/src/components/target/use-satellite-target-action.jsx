import { useSelector, useDispatch } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { useSocket } from '../common/socket.jsx';
import { toast } from '../../utils/toast-with-timestamp.jsx';
import { setRotator, setTrackerId, setTrackingStateInBackend } from './target-slice.jsx';
import { useTargetRotatorSelectionDialog } from './use-target-rotator-selection-dialog.jsx';

// Keep the satellite target action identical wherever satellite details are shown.
export const useSatelliteTargetAction = ({ satellite, groupId = null }) => {
    const dispatch = useDispatch();
    const { socket } = useSocket();
    const { t } = useTranslation('earthview');
    const { trackingState, satelliteId, trackerViews } = useSelector((state) => state.targetSatTrack || {});
    const trackerInstances = useSelector((state) => state.trackerInstances?.instances || []);
    const { requestRotatorForTarget, dialog } = useTargetRotatorSelectionDialog();
    const noradId = satellite?.norad_id;
    const isCurrentlyTargeted = noradId != null && String(satelliteId) === String(noradId);

    const setAsTarget = async () => {
        if (noradId == null || !socket) return;

        const selectedAssignment = await requestRotatorForTarget(satellite?.name || String(noradId));
        if (!selectedAssignment) return;

        const isCreateNewSlot = selectedAssignment.action === 'create_new_slot';
        const trackerId = String(selectedAssignment.trackerId || '');
        const rotatorId = String(selectedAssignment.rotatorId || 'none');
        const assignmentRigId = String(selectedAssignment.rigId || 'none');
        if (!trackerId) return;

        const selectedTrackerInstance = trackerInstances.find(
            (instance) => String(instance?.tracker_id || '') === trackerId
        );
        const selectedTrackerView = trackerViews?.[trackerId] || {};
        const selectedTrackerState = selectedTrackerView.trackingState || selectedTrackerInstance?.tracking_state || {};
        const nextRigId = isCreateNewSlot
            ? assignmentRigId
            : String(
                selectedTrackerView.selectedRadioRig
                ?? selectedTrackerState.rig_id
                ?? assignmentRigId
            );
        const nextRotatorId = isCreateNewSlot ? 'none' : rotatorId;
        const nextTransmitterId = isCreateNewSlot
            ? 'none'
            : String(selectedTrackerState.transmitter_id || 'none');
        const nextGroupId = groupId || satellite?.group_id || selectedTrackerState.group_id || trackingState?.group_id || '';
        const targetName = String(satellite?.name || noradId).trim();
        const satelliteTargetPatch = {
            target_type: 'satellite',
            target_name: targetName || String(noradId),
            command: null,
            body_id: null,
        };

        // Preserve a slot's hardware and transmitter selection when retargeting it.
        const newTrackingState = isCreateNewSlot
            ? {
                tracker_id: trackerId,
                norad_id: noradId,
                group_id: nextGroupId,
                ...satelliteTargetPatch,
                rig_id: nextRigId,
                rotator_id: nextRotatorId,
                transmitter_id: 'none',
                rig_state: 'disconnected',
                rotator_state: 'disconnected',
                rig_vfo: 'none',
                vfo1: 'uplink',
                vfo2: 'downlink',
            }
            : {
                ...selectedTrackerState,
                tracker_id: trackerId,
                norad_id: noradId,
                group_id: nextGroupId,
                ...satelliteTargetPatch,
                rig_id: nextRigId,
                rotator_id: nextRotatorId,
                transmitter_id: nextTransmitterId,
            };

        dispatch(setTrackerId(trackerId));
        dispatch(setRotator({ value: nextRotatorId, trackerId }));
        try {
            await dispatch(setTrackingStateInBackend({ socket, data: newTrackingState })).unwrap();
        } catch (error) {
            toast.error(
                `${t('satellite_info.failed_tracking')}: ${error?.message || error?.error || 'Unknown error'}`
            );
        }
    };

    return { setAsTarget, isCurrentlyTargeted, dialog };
};
