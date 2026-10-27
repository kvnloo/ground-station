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

import {IconButton, Tooltip} from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import {useTranslation} from 'react-i18next';

export default function MapTitleControls({onSettings, tooltipContainer}) {
    const {t} = useTranslation('earthview');
    const label = t('map_settings.title');

    return (
        <Tooltip title={label} slotProps={{popper: {container: tooltipContainer}}}>
            <IconButton size="small" sx={{p: '2px'}} aria-label={label} onClick={onSettings} onMouseDown={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()}>
                <SettingsIcon fontSize="small" />
            </IconButton>
        </Tooltip>
    );
}
