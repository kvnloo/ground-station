import React from 'react';
import { Tooltip, IconButton } from '@mui/material';
import { UAParser } from 'ua-parser-js';
import { useWakeLockContext } from './wake-lock-provider.jsx';
import ScreenLockPortraitIcon from '@mui/icons-material/ScreenLockPortrait';
import StayPrimaryPortraitIcon from '@mui/icons-material/StayPrimaryPortrait';

const isMobileOrTablet = () => {
    const deviceType = new UAParser(navigator.userAgent).getDevice().type;

    // iPadOS can identify itself as a Mac when requesting desktop websites.
    return deviceType === 'mobile' || deviceType === 'tablet' ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

const WakeLockStatus = ({ size = 'medium' }) => {
    const {
        isSupported,
        isActive,
        activeRequests,
        hasManualRequest,
        forceRelease,
        requestManualWakeLock,
    } = useWakeLockContext();

    if (!isSupported || !isMobileOrTablet()) {
        return null;
    }

    const handleClick = async () => {
        if (isActive) {
            // Release all wake locks
            forceRelease();
        } else {
            // Manually acquire wake lock
            await requestManualWakeLock();
        }
    };

    const getTooltipText = () => {
        if (hasManualRequest && activeRequests > 0) {
            return `Manual + ${activeRequests} component wake lock${activeRequests !== 1 ? 's' : ''} active. Click to release all.`;
        } else if (hasManualRequest) {
            return 'Manual wake lock active. Click to release.';
        } else if (activeRequests > 0) {
            return `${activeRequests} component wake lock${activeRequests !== 1 ? 's' : ''} active. Click to release all.`;
        } else {
            return 'Screen can sleep. Click to manually activate wake lock.';
        }
    };

    return (
        <Tooltip title={getTooltipText()}>
            <IconButton
                onClick={handleClick}
                size={size}
            >
                {isActive ? <ScreenLockPortraitIcon color="primary" /> : <StayPrimaryPortraitIcon color="action" />}
            </IconButton>
        </Tooltip>
    );
};

export default WakeLockStatus;
