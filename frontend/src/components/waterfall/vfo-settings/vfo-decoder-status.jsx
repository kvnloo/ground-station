/**
 * VFO Decoder Status Component
 *
 * Displays two-line status for decoders and transcription
 */

import React from 'react';
import { Box, Tooltip, Typography } from '@mui/material';
import { VFO_AUDIO_STATUS } from '../vfo-audio-status.js';

/**
 * Decoder Status Display Component
 * Shows active decoder/transcription status with metrics
 */
export const DecoderStatusDisplay = ({
    vfo,
    decoderInfo,
    audioStatus = VFO_AUDIO_STATUS.NO_AUDIO,
    compact = false,
    hideWhenIdle = false,
}) => {
    const hasConfiguredStatus = Boolean(
        decoderInfo
        || vfo?.transcriptionEnabled
        || (vfo?.decoder && vfo.decoder !== 'none')
        || (vfo?.mode && vfo.mode !== 'none')
    );

    if (hideWhenIdle && !hasConfiguredStatus) {
        return null;
    }

    // Build a single status line so the VFO controls remain scannable while
    // still exposing decoder, transcription, and progress details.
    let statusText = 'NO DECODER';
    let borderColor = 'divider';
    let textColor = 'text.disabled';

    // Check if this is a transcription decoder
    if (decoderInfo && decoderInfo.decoder_type === 'transcription') {
        const info = decoderInfo.info || {};
        const status = decoderInfo.status || 'unknown';

        const statusParts = [];
        statusParts.push(status.toUpperCase());

        // Show language flow: source -> target
        if (info.language) {
            const langDisplay = info.language.toUpperCase();
            const translateDisplay = info.translate_to ? info.translate_to.toUpperCase() : null;
            if (translateDisplay && translateDisplay !== 'NONE') {
                statusParts.push(`${langDisplay} → ${translateDisplay}`);
            } else {
                statusParts.push(langDisplay);
            }
        }

        // Transcription request stats
        if (info.transcriptions_sent !== undefined && info.transcriptions_received !== undefined) {
            const successRate = info.transcriptions_sent > 0
                ? Math.round((info.transcriptions_received / info.transcriptions_sent) * 100)
                : 0;
            statusParts.push(`${info.transcriptions_received}/${info.transcriptions_sent} (${successRate}%)`);
        }

        // Show errors if any
        if (info.errors !== undefined && info.errors > 0) {
            statusParts.push(`ERR:${info.errors}`);
        }

        statusText = statusParts.join(' • ');

        borderColor = status === 'transcribing' ? 'success.dark' : 'warning.dark';
        textColor = 'text.secondary';
    } else if (vfo && vfo.transcriptionEnabled) {
        // Transcription enabled but not active
        statusText = 'TRANSCRIPTION • WAITING';
        borderColor = 'warning.dark';
        textColor = 'warning.main';
    } else if (vfo && vfo.decoder && vfo.decoder !== 'none') {
        // Data decoder (existing logic)
        if (decoderInfo) {
            const info = decoderInfo.info || {};
            const status = decoderInfo.status || 'unknown';

            const statusParts = [];
            statusParts.push(status.toUpperCase());
            const decoderLabel = info.transmitter_mode || vfo.decoder || decoderInfo.decoder_type;
            if (decoderLabel) {
                statusParts.push(String(decoderLabel).toUpperCase());
            }
            if (info.framing !== undefined && info.framing !== null) {
                statusParts.push(info.framing.toUpperCase());
            }

            if (info.baudrate !== undefined && info.baudrate !== null) {
                statusParts.push(`${info.baudrate}bd`);
            }

            if (decoderInfo.progress !== undefined && decoderInfo.progress !== null) {
                statusParts.push(`${decoderInfo.progress}%`);
            }

            if (info.wpm !== undefined && info.wpm !== null) {
                statusParts.push(`${info.wpm} WPM`);
            }
            if (info.character_count !== undefined && info.character_count !== null && info.character_count > 0) {
                statusParts.push(`CHAR:${info.character_count}`);
            }

            if (info.packets_decoded !== undefined && info.packets_decoded !== null) {
                statusParts.push(`PKT:${info.packets_decoded}`);
            }
            if (info.signal_power_dbfs !== undefined && info.signal_power_dbfs !== null) {
                statusParts.push(`${info.signal_power_dbfs.toFixed(1)}dB`);
            }
            statusText = statusParts.join(' • ');

            borderColor = (status === 'decoding' || status === 'transcribing') ? 'success.dark' : 'warning.dark';
            textColor = 'text.secondary';
        } else {
            // Decoder selected but not running
            statusText = `${vfo.decoder.toUpperCase()} • WAITING`;
            borderColor = 'warning.dark';
            textColor = 'warning.main';
        }
    } else if (vfo?.mode && vfo.mode !== 'none') {
        const audioStatusLabel = {
            [VFO_AUDIO_STATUS.PLAYING]: 'PLAYING',
            [VFO_AUDIO_STATUS.MUTED]: 'MUTED',
            [VFO_AUDIO_STATUS.SQUELCHED]: 'SQUELCHED',
            [VFO_AUDIO_STATUS.NO_AUDIO]: 'WAITING FOR AUDIO',
        }[audioStatus] || 'WAITING FOR AUDIO';

        statusText = `AUDIO • ${String(vfo.mode).toUpperCase()} • ${audioStatusLabel}`;
        borderColor = audioStatus === VFO_AUDIO_STATUS.PLAYING ? 'success.dark' : 'warning.dark';
        textColor = audioStatus === VFO_AUDIO_STATUS.PLAYING ? 'text.secondary' : 'warning.main';
    }

    return (
        <Box sx={{
            mt: compact ? 0.5 : 1,
            px: compact ? 0.75 : 1,
            py: compact ? 0.35 : 0.5,
            backgroundColor: compact ? 'action.hover' : 'rgba(0, 0, 0, 0.2)',
            borderRadius: 0.5,
            border: compact ? 0 : '1px solid',
            borderColor: compact ? 'transparent' : borderColor,
            minHeight: compact ? 0 : 30,
            display: 'flex',
            alignItems: compact ? 'flex-start' : 'center',
            justifyContent: 'center'
        }}>
            <Tooltip title={statusText} disableHoverListener={statusText.length < 42}>
                <Typography
                    variant="caption"
                    sx={{
                        fontSize: compact ? '0.65rem' : '0.7rem',
                        fontFamily: 'monospace',
                        color: textColor,
                        display: 'block',
                        textAlign: compact ? 'left' : 'center',
                        lineHeight: 1.25,
                        maxWidth: '100%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {statusText}
                </Typography>
            </Tooltip>
        </Box>
    );
};
