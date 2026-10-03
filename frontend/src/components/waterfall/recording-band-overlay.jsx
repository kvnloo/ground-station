/**
 * @license
 * Copyright (c) 2026 Efstratios Goudelis
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, useTheme } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useTranslation } from 'react-i18next';

/**
 * Draws the centered portion of the live SDR spectrum that an IQ recording
 * retains after decimation. It is intentionally visual-only: the containing
 * waterfall canvas group supplies pan and zoom through its shared transform.
 */
const RecordingBandOverlay = ({
    inputSampleRate,
    decimationFactor,
    selectionEnabled = false,
    centerOffsetHz = 0,
    dragStepHz = 1000,
    onCenterOffsetChange,
    isRecording = false,
    containerWidth,
    transformTick = 0,
    interactionActive = false,
    allowInteractionMeasure = false,
    interactionMeasureTick = 0,
    height,
    topPadding = 0,
}) => {
    const theme = useTheme();
    const { t } = useTranslation('waterfall');
    const canvasRef = useRef(null);
    const containerRef = useRef(null);
    const dragRef = useRef(null);
    const [actualWidth, setActualWidth] = useState(2048);
    const lastMeasuredWidthRef = useRef(0);
    const factor = Number(decimationFactor) || 1;
    const inputRate = Number(inputSampleRate);
    const hasInputRate = Number.isFinite(inputRate) && inputRate > 0;
    const isVisible = hasInputRate && (selectionEnabled || isRecording);
    const maxOffsetHz = hasInputRate ? Math.max(0, (inputRate - inputRate / factor) / 2) : 0;
    const selectedOffsetHz = Math.max(
        -maxOffsetHz,
        Math.min(maxOffsetHz, Number(centerOffsetHz) || 0)
    );
    const statusColor = isRecording ? theme.palette.error.main : theme.palette.info.main;
    const statusText = isRecording
        ? t('recording.statusRecording', 'Recording')
        : t('recording.statusReady', 'Ready');

    const formatSampleRate = (rate) => {
        if (rate >= 1000000) {
            return `${(rate / 1000000).toFixed(rate % 1000000 === 0 ? 0 : 1)} MS/s`;
        }
        return `${Math.round(rate / 1000)} kS/s`;
    };

    const outputRate = formatSampleRate(Number(inputSampleRate) / factor);

    const updateOffsetFromPointer = useCallback((clientX) => {
        const drag = dragRef.current;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!drag || !rect?.width || !inputRate || !onCenterOffsetChange) return;

        // The bandscope is transformed for pan/zoom. Its screen width already
        // includes that transform, so this maps pointer movement back to Hz.
        const deltaHz = ((clientX - drag.startClientX) / rect.width) * inputRate;
        const rawOffsetHz = Math.max(
            -maxOffsetHz,
            Math.min(maxOffsetHz, drag.startOffsetHz + deltaHz)
        );
        const stepHz = Number(dragStepHz);
        const snappedOffsetHz = Number.isFinite(stepHz) && stepHz > 0
            ? Math.round(rawOffsetHz / stepHz) * stepHz
            : rawOffsetHz;
        onCenterOffsetChange(Math.max(-maxOffsetHz, Math.min(maxOffsetHz, snappedOffsetHz)));
    }, [dragStepHz, inputRate, maxOffsetHz, onCenterOffsetChange]);

    const startMouseDrag = useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        dragRef.current = {
            startClientX: event.clientX,
            startOffsetHz: selectedOffsetHz,
        };
    }, [selectedOffsetHz]);

    const startTouchDrag = useCallback((event) => {
        if (event.touches.length !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        dragRef.current = {
            startClientX: event.touches[0].clientX,
            startOffsetHz: selectedOffsetHz,
        };
    }, [selectedOffsetHz]);

    useEffect(() => {
        const handleMouseMove = (event) => {
            if (!dragRef.current) return;

            // The bandscope pans from a window listener. Capture the event at
            // document before it reaches that listener, matching VFO drags.
            event.preventDefault();
            event.stopPropagation();
            updateOffsetFromPointer(event.clientX);
        };
        const handleMouseUp = (event) => {
            if (!dragRef.current) return;
            event.stopPropagation();
            dragRef.current = null;
        };
        const handleTouchMove = (event) => {
            if (!dragRef.current) return;

            event.preventDefault();
            event.stopPropagation();
            if (event.touches.length === 1) {
                updateOffsetFromPointer(event.touches[0].clientX);
            }
        };

        document.addEventListener('mousemove', handleMouseMove, { capture: true });
        document.addEventListener('mouseup', handleMouseUp, { capture: true });
        document.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
        document.addEventListener('touchend', handleMouseUp, { capture: true });
        document.addEventListener('touchcancel', handleMouseUp, { capture: true });
        return () => {
            document.removeEventListener('mousemove', handleMouseMove, { capture: true });
            document.removeEventListener('mouseup', handleMouseUp, { capture: true });
            document.removeEventListener('touchmove', handleTouchMove, { capture: true });
            document.removeEventListener('touchend', handleMouseUp, { capture: true });
            document.removeEventListener('touchcancel', handleMouseUp, { capture: true });
        };
    }, [updateOffsetFromPointer]);

    const updateActualWidth = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        const width = Math.round(rect?.width || 0);
        if (width > 0 && width !== lastMeasuredWidthRef.current) {
            lastMeasuredWidthRef.current = width;
            setActualWidth(width);
        }
    }, []);

    useEffect(() => {
        if (!interactionActive) {
            updateActualWidth();
        }
    }, [containerWidth, transformTick, interactionActive, updateActualWidth]);

    useEffect(() => {
        if (interactionActive && allowInteractionMeasure) {
            updateActualWidth();
        }
    }, [interactionActive, allowInteractionMeasure, interactionMeasureTick, updateActualWidth]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const targetHeight = Math.max(1, height);
        if (canvas.width !== actualWidth) canvas.width = actualWidth;
        if (canvas.height !== targetHeight) canvas.height = targetHeight;
    }, [actualWidth, height]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!isVisible) return;

        const drawTop = Math.max(0, topPadding);
        const drawHeight = Math.max(0, canvas.height - drawTop);
        const recordedWidth = canvas.width / factor;
        const centerX = canvas.width / 2 + (selectedOffsetHz / inputRate) * canvas.width;
        const leftEdge = centerX - recordedWidth / 2;
        const rightEdge = leftEdge + recordedWidth;
        // Keep the selected bandwidth legible across the full spectrum. The
        // tint deliberately fades toward the trace, so a zoomed-in retained
        // region remains readable instead of becoming a uniform grey wash.
        const fillGradient = ctx.createLinearGradient(0, drawTop, 0, canvas.height);
        fillGradient.addColorStop(0, 'rgba(48, 196, 255, 0.14)');
        fillGradient.addColorStop(0.22, 'rgba(48, 196, 255, 0.065)');
        fillGradient.addColorStop(1, 'rgba(48, 196, 255, 0.012)');
        ctx.fillStyle = fillGradient;
        ctx.fillRect(leftEdge, drawTop, recordedWidth, drawHeight);

        // A full-bandwidth recording reaches both canvas boundaries. Those
        // are not recording-band edges, and the right-hand stroke would be
        // clipped because its coordinate is canvas.width.
        if (recordedWidth < canvas.width) {
            ctx.fillStyle = alpha(statusColor, 0.82);
            ctx.fillRect(Math.round(leftEdge), drawTop, 1, drawHeight);
            ctx.fillRect(Math.round(rightEdge), drawTop, 1, drawHeight);
        }

        // This identifies the selected recording frequency even when the
        // selection spans the complete SDR bandwidth and has no movable edges.
        ctx.fillStyle = alpha(statusColor, 0.9);
        ctx.fillRect(Math.round(centerX), drawTop, 1, drawHeight);

        // Draw the status in this canvas, as bookmark and band-plan labels are.
        // The backing store tracks the transformed width, preventing CSS zoom
        // from stretching the pill or its text.
        const pillHeight = 18;
        const pillY = drawTop + 2;
        const statusLabel = statusText.toUpperCase();
        ctx.save();
        ctx.textBaseline = 'middle';
        ctx.font = '700 10px Arial, sans-serif';
        const statusWidth = ctx.measureText(statusLabel).width;
        ctx.font = '10px Arial, sans-serif';
        const rateWidth = ctx.measureText(outputRate).width;
        const pillWidth = 31 + statusWidth + rateWidth;
        const pillX = Math.max(2, Math.min(canvas.width - pillWidth - 2, centerX - pillWidth / 2));

        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillWidth, pillHeight, 4);
        ctx.fillStyle = alpha(theme.palette.background.paper, 0.9);
        ctx.fill();
        ctx.strokeStyle = alpha(statusColor, 0.7);
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(pillX + 9, pillY + pillHeight / 2, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = statusColor;
        ctx.fill();

        const statusX = pillX + 17;
        ctx.font = '700 10px Arial, sans-serif';
        ctx.fillStyle = theme.palette.text.primary;
        ctx.fillText(statusLabel, statusX, pillY + pillHeight / 2 + 0.25);

        const dividerX = statusX + statusWidth + 6;
        ctx.strokeStyle = alpha(theme.palette.text.primary, 0.22);
        ctx.beginPath();
        ctx.moveTo(dividerX, pillY + 3);
        ctx.lineTo(dividerX, pillY + pillHeight - 3);
        ctx.stroke();

        ctx.font = '10px Arial, sans-serif';
        ctx.fillStyle = theme.palette.text.secondary;
        ctx.fillText(outputRate, dividerX + 6, pillY + pillHeight / 2 + 0.25);
        ctx.restore();

    }, [
        actualWidth,
        factor,
        height,
        isVisible,
        inputRate,
        outputRate,
        selectedOffsetHz,
        statusColor,
        statusText,
        theme.palette.background.paper,
        theme.palette.text.primary,
        theme.palette.text.secondary,
        topPadding,
    ]);

    // Stay mounted so transform ticks keep this layer's backing store in sync
    // while a user turns recording-band selection on and off.
    return (
        <Box
            ref={containerRef}
            aria-hidden={!isVisible}
            aria-label={t('recording.statusAriaLabel', {
                status: statusText,
                rate: outputRate,
                defaultValue: `IQ recording ${statusText.toLowerCase()}, ${outputRate}`,
            })}
            role={selectionEnabled && !isRecording ? undefined : 'img'}
            sx={{
                position: 'absolute',
                inset: 0,
                height: `${height}px`,
                pointerEvents: 'none',
                // VFO markers occupy the bandscope at z-index 400. The
                // selection's hit target must sit above that canvas while it
                // is enabled, otherwise the VFO layer receives every drag.
                zIndex: 500,
            }}
        >
            <canvas
                className="recording-band-overlay"
                ref={canvasRef}
                width={actualWidth}
                height={height}
                style={{ display: 'block', width: '100%', height: '100%' }}
            />
            {hasInputRate && selectionEnabled && !isRecording && factor > 1 && (
                <Box
                    aria-label={t('recording.dragBand', 'Drag recording band')}
                    // Capture prevents the bandscope's native pan-start
                    // listener from claiming the same gesture first.
                    onMouseDownCapture={startMouseDrag}
                    onTouchStartCapture={startTouchDrag}
                    sx={{
                        position: 'absolute',
                        top: `${topPadding}px`,
                        bottom: 0,
                        // Values are clamped above, so the draggable element
                        // always remains within the available SDR bandwidth.
                        left: `${(0.5 + selectedOffsetHz / inputRate - 1 / (2 * factor)) * 100}%`,
                        width: `${100 / factor}%`,
                        cursor: 'ew-resize',
                        pointerEvents: 'auto',
                        touchAction: 'none',
                    }}
                />
            )}
        </Box>
    );
};

export default React.memo(RecordingBandOverlay);
