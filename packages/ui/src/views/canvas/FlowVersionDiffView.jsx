import PropTypes from 'prop-types'
import { useSelector } from 'react-redux'

// material-ui
import { useTheme, alpha } from '@mui/material/styles'
import { Box, Chip, CircularProgress, FormControlLabel, Stack, Switch, Tooltip, Typography } from '@mui/material'

// icons
import { IconInfoCircle } from '@tabler/icons-react'

// ==============================|| FLOW VERSION DIFF VIEW ||============================== //

/**
 * Renders the `hunks` returned by `GET /flow-versions/:id/diff` as a readable line diff.
 *
 * Colours come from the theme palette rather than literals so both light and dark mode work — the
 * palette already swaps its own values on `isDarkMode`, and the alpha weights are lifted per mode
 * because a tint that reads clearly on white disappears on a dark surface.
 */
const FlowVersionDiffView = ({ diff, loading, promptsOnly, onTogglePromptsOnly, compareLabel }) => {
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)
    const isDark = customization.isDarkMode

    const tint = (color) => alpha(color, isDark ? 0.22 : 0.12)
    const gutterColor = isDark ? alpha(theme.palette.grey[300], 0.4) : theme.palette.grey[500]

    const backgroundFor = (op) => {
        if (op === 'add') return tint(theme.palette.success.main)
        if (op === 'remove') return tint(theme.palette.error.main)
        return 'transparent'
    }

    const signFor = (op) => (op === 'add' ? '+' : op === 'remove' ? '-' : ' ')

    const hunks = diff?.hunks ?? []
    const hasChanges = hunks.length > 0

    return (
        <Box sx={{ mt: 1 }}>
            <Stack direction='row' alignItems='center' justifyContent='space-between' flexWrap='wrap' sx={{ gap: 1 }}>
                <Stack direction='row' alignItems='center' sx={{ gap: 1 }}>
                    <Typography variant='subtitle2' sx={{ color: theme.palette.text.secondary }}>
                        {compareLabel}
                    </Typography>
                    {diff && (
                        <>
                            <Chip
                                size='small'
                                label={`+${diff.added}`}
                                sx={{
                                    backgroundColor: tint(theme.palette.success.main),
                                    // `success.dark` is not mode-swapped by the palette, so on a dark
                                    // surface it lands dark-on-dark. The tinted background already
                                    // carries the add/remove meaning; the label just has to be legible.
                                    color: isDark ? theme.palette.text.primary : theme.palette.success.dark,
                                    fontWeight: 600
                                }}
                            />
                            <Chip
                                size='small'
                                label={`-${diff.removed}`}
                                sx={{
                                    backgroundColor: tint(theme.palette.error.main),
                                    color: isDark ? theme.palette.text.primary : theme.palette.error.dark,
                                    fontWeight: 600
                                }}
                            />
                        </>
                    )}
                </Stack>
                <Stack direction='row' alignItems='center'>
                    <FormControlLabel
                        control={
                            <Switch
                                size='small'
                                checked={promptsOnly}
                                onChange={(event) => onTogglePromptsOnly(event.target.checked)}
                                inputProps={{ 'aria-label': 'Prompt changes only' }}
                            />
                        }
                        label={<Typography variant='body2'>Prompt changes only</Typography>}
                        sx={{ mr: 0.5 }}
                    />
                    <Tooltip title='Hide everything except changes inside prompt and template fields.'>
                        <Box sx={{ display: 'flex', color: theme.palette.text.secondary }}>
                            <IconInfoCircle size={16} />
                        </Box>
                    </Tooltip>
                </Stack>
            </Stack>

            {loading && (
                <Stack direction='row' alignItems='center' sx={{ gap: 1, mt: 2 }}>
                    <CircularProgress size={16} />
                    <Typography variant='body2'>Comparing…</Typography>
                </Stack>
            )}

            {!loading && diff && !hasChanges && (
                <Typography variant='body2' sx={{ mt: 2, color: theme.palette.text.secondary }}>
                    {promptsOnly
                        ? 'No prompt or template field changed between these two versions.'
                        : 'These two versions are identical.'}
                </Typography>
            )}

            {!loading && hasChanges && (
                <Box
                    sx={{
                        mt: 1.5,
                        border: 1,
                        borderColor: theme.palette.divider,
                        borderRadius: 2,
                        overflow: 'auto',
                        maxHeight: 420,
                        backgroundColor: isDark ? alpha(theme.palette.common.black, 0.2) : theme.palette.grey[50],
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        fontSize: '0.75rem',
                        lineHeight: 1.6
                    }}
                >
                    {hunks.map((hunk, hunkIndex) => (
                        <Box key={`${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`}>
                            <Box
                                sx={{
                                    px: 1,
                                    py: 0.5,
                                    color: theme.palette.text.secondary,
                                    backgroundColor: isDark ? alpha(theme.palette.common.white, 0.06) : theme.palette.grey[200],
                                    borderTop: hunkIndex === 0 ? 0 : 1,
                                    borderColor: theme.palette.divider
                                }}
                            >
                                {`@@ -${hunk.oldStart} +${hunk.newStart} @@`}
                            </Box>
                            {hunk.lines.map((line, lineIndex) => (
                                <Box
                                    key={`${hunkIndex}-${lineIndex}`}
                                    data-diff-op={line.op}
                                    sx={{
                                        display: 'flex',
                                        alignItems: 'flex-start',
                                        backgroundColor: backgroundFor(line.op),
                                        color: theme.palette.text.primary
                                    }}
                                >
                                    <Box
                                        component='span'
                                        sx={{
                                            flex: '0 0 4.5rem',
                                            textAlign: 'right',
                                            pr: 1,
                                            color: gutterColor,
                                            userSelect: 'none'
                                        }}
                                    >
                                        {`${line.oldLine ?? ''} ${line.newLine ?? ''}`}
                                    </Box>
                                    <Box component='span' sx={{ flex: '0 0 1rem', color: gutterColor, userSelect: 'none' }}>
                                        {signFor(line.op)}
                                    </Box>
                                    <Box
                                        component='span'
                                        sx={{ flex: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', pr: 1 }}
                                    >
                                        {line.text}
                                    </Box>
                                </Box>
                            ))}
                        </Box>
                    ))}
                </Box>
            )}
        </Box>
    )
}

FlowVersionDiffView.propTypes = {
    diff: PropTypes.object,
    loading: PropTypes.bool,
    promptsOnly: PropTypes.bool,
    onTogglePromptsOnly: PropTypes.func,
    compareLabel: PropTypes.string
}

export default FlowVersionDiffView
