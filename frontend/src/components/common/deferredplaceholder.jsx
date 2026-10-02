import { Box, CircularProgress } from '@mui/material';

// Keeps deferred dashboard cells visually intentional without blocking route input.
const DeferredIslandPlaceholder = () => (
    <Box
        aria-label="Loading panel"
        sx={{
            width: '100%',
            height: '100%',
            minHeight: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
        }}
    >
        <CircularProgress size={24} thickness={4} />
    </Box>
);

export default DeferredIslandPlaceholder;
