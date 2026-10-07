import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSdrTakeoverDialog } from '../use-sdr-takeover-dialog.jsx';

function DialogHarness({ onChoice }) {
    const { requestTakeoverConfirmation, takeoverDialog } = useSdrTakeoverDialog();
    return <>
        <button onClick={() => requestTakeoverConfirmation({
            sdr_id: 'sdr-a',
            other_session_count: 1,
            includes_internal_observation: true,
        }, 'select this SDR').then(onChoice)}>Select SDR</button>
        {takeoverDialog}
    </>;
}

describe('SDR access dialog', () => {
    it.each([
        ['Cancel', 'cancel'],
        ['Watch', 'watch'],
        ['Take Over', 'takeover'],
    ])('returns %s without conflating access choices', async (label, expected) => {
        const onChoice = vi.fn();
        render(<DialogHarness onChoice={onChoice} />);

        fireEvent.click(screen.getByRole('button', { name: 'Select SDR' }));
        expect(screen.getByText('Automated observation active')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: label }));

        await waitFor(() => expect(onChoice).toHaveBeenCalledWith(expected));
    });
});
