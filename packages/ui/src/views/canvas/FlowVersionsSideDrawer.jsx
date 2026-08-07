import { useCallback, useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { useDispatch } from 'react-redux'
import moment from 'moment/moment'

// material-ui
import { useTheme } from '@mui/material/styles'
import { Box, Button, Chip, CircularProgress, Divider, Stack, SwipeableDrawer, Tooltip, Typography } from '@mui/material'
import {
    Timeline,
    TimelineConnector,
    TimelineContent,
    TimelineDot,
    TimelineItem,
    TimelineOppositeContent,
    timelineOppositeContentClasses,
    TimelineSeparator
} from '@mui/lab'

// icons
import { IconRefresh, IconSquareRoundedChevronsRight, IconTag } from '@tabler/icons-react'

// project imports
import FlowVersionDiffView from './FlowVersionDiffView'
import TagFlowVersionDialog from '@/ui-component/dialog/TagFlowVersionDialog'
import { StyledButton } from '@/ui-component/button/StyledButton'

// API
import flowVersionsApi from '@/api/flowversions.api'

// Hooks
import useApi from '@/hooks/useApi'
import useConfirm from '@/hooks/useConfirm'

// store
import { closeSnackbar as closeSnackbarAction, enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'

// ==============================|| FLOW VERSIONS SIDE DRAWER ||============================== //

/**
 * Version history for one flow — REQUIREMENTS-VERSIONING.md Phase 2.
 *
 * Versions come back newest first. Selecting one diffs it against the flow's CURRENT saved state,
 * which is the comparison actually wanted before deciding whether to restore.
 */
const FlowVersionsSideDrawer = ({ show, dialogProps, onClose, onRestored }) => {
    const theme = useTheme()
    const dispatch = useDispatch()
    const { confirm } = useConfirm()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const chatflowId = dialogProps?.chatflowId

    const [versions, setVersions] = useState([])
    const [selectedOid, setSelectedOid] = useState(null)
    const [promptsOnly, setPromptsOnly] = useState(false)
    const [isRestoring, setRestoring] = useState(false)
    const [tagDialogOpen, setTagDialogOpen] = useState(false)
    const [tagTarget, setTagTarget] = useState(null)

    const getVersionsApi = useApi(flowVersionsApi.getVersions)
    const getDiffApi = useApi(flowVersionsApi.getDiff)

    const notifyError = useCallback(
        (error, fallback) => {
            const message =
                typeof error?.response?.data === 'object' ? error.response.data.message : error?.response?.data || error?.message
            enqueueSnackbar({
                message: message || fallback,
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'error',
                    persist: true,
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            Close
                        </Button>
                    )
                }
            })
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []
    )

    // Load history whenever the drawer opens for a flow.
    useEffect(() => {
        if (show && chatflowId) {
            setSelectedOid(null)
            getVersionsApi.request(chatflowId)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [show, chatflowId])

    useEffect(() => {
        if (getVersionsApi.data) setVersions(getVersionsApi.data.versions ?? [])
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getVersionsApi.data])

    // The diff is always "this version → what is saved right now", refreshed when the prompt-only
    // filter is toggled so the toggle costs one request rather than a second client-side pass.
    useEffect(() => {
        if (selectedOid && chatflowId) getDiffApi.request(chatflowId, selectedOid, null, promptsOnly)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedOid, promptsOnly, chatflowId])

    const refreshHistory = () => {
        if (chatflowId) getVersionsApi.request(chatflowId)
    }

    const handleRestore = async (version) => {
        const isConfirmed = await confirm({
            title: 'Restore this version?',
            description: (
                <>
                    <div>
                        The flow will be set back to <strong>{version.shortOid}</strong>, saved{' '}
                        {moment(version.timestamp).format('DD-MMM-YYYY, hh:mm:ss A')}.
                    </div>
                    <br />
                    <div>
                        <strong>Nothing is deleted.</strong> The version you are on now stays in this history permanently and can be
                        restored again at any time — restoring records a new version rather than rewriting the old ones.
                    </div>
                </>
            ),
            confirmButtonName: 'Restore',
            cancelButtonName: 'Cancel'
        })
        if (!isConfirmed) return

        setRestoring(true)
        try {
            const response = await flowVersionsApi.restoreVersion(chatflowId, version.oid)
            enqueueSnackbar({
                message: response.data?.note || 'Restored.',
                options: { key: new Date().getTime() + Math.random(), variant: 'success' }
            })
            setSelectedOid(null)
            refreshHistory()
            if (onRestored) onRestored(response.data?.chatflow)
        } catch (error) {
            notifyError(error, 'Failed to restore this version')
        } finally {
            setRestoring(false)
        }
    }

    const handleTag = async (label) => {
        const version = tagTarget
        setTagDialogOpen(false)
        if (!version) return
        try {
            await flowVersionsApi.tagVersion(chatflowId, version.oid, label)
            enqueueSnackbar({
                message: `Checkpoint "${label}" saved.`,
                options: { key: new Date().getTime() + Math.random(), variant: 'success' }
            })
            refreshHistory()
        } catch (error) {
            notifyError(error, 'Failed to name this version')
        }
    }

    const isLoading = getVersionsApi.loading

    return (
        <>
            <SwipeableDrawer anchor='right' open={show} onClose={onClose} onOpen={() => {}}>
                <Box sx={{ width: { xs: '100vw', sm: 560, md: 780 }, p: 2 }} role='presentation'>
                    <Stack direction='row' alignItems='center' justifyContent='space-between'>
                        <Button startIcon={<IconSquareRoundedChevronsRight />} onClick={onClose}>
                            Close
                        </Button>
                        <Button size='small' startIcon={<IconRefresh size={16} />} onClick={refreshHistory}>
                            Refresh
                        </Button>
                    </Stack>

                    <Typography variant='h3' sx={{ mt: 1 }}>
                        Version history
                    </Typography>
                    <Typography variant='body2' sx={{ color: theme.palette.text.secondary }}>
                        {dialogProps?.chatflowName}
                    </Typography>

                    <Divider sx={{ my: 2 }} />

                    {isLoading && versions.length === 0 && (
                        <Stack direction='row' alignItems='center' sx={{ gap: 1 }}>
                            <CircularProgress size={16} />
                            <Typography variant='body2'>Loading history…</Typography>
                        </Stack>
                    )}

                    {!isLoading && versions.length === 0 && (
                        <Typography variant='body2' sx={{ color: theme.palette.text.secondary }}>
                            No versions captured yet. The next time this flow is saved, a version is recorded automatically.
                        </Typography>
                    )}

                    <Timeline
                        sx={{
                            p: 0,
                            [`& .${timelineOppositeContentClasses.root}`]: {
                                flex: 0,
                                minWidth: 120,
                                pl: 0
                            }
                        }}
                    >
                        {versions.map((version, index) => {
                            const isSelected = version.oid === selectedOid
                            const [subject, ...rest] = version.message.split('\n')
                            const body = rest.join('\n').trim()

                            return (
                                <TimelineItem key={version.oid}>
                                    <TimelineOppositeContent color='textSecondary' sx={{ mt: 0.5 }}>
                                        <Tooltip title={moment(version.timestamp).format('DD-MMM-YYYY, hh:mm:ss A')}>
                                            <Typography variant='body2'>{moment(version.timestamp).fromNow()}</Typography>
                                        </Tooltip>
                                    </TimelineOppositeContent>
                                    <TimelineSeparator style={{ marginTop: 5 }}>
                                        <TimelineDot color={isSelected ? 'primary' : 'grey'} />
                                        {index !== versions.length - 1 && <TimelineConnector />}
                                    </TimelineSeparator>
                                    <TimelineContent sx={{ pb: 3 }}>
                                        <Typography variant='subtitle1' sx={{ wordBreak: 'break-word' }}>
                                            {subject}
                                        </Typography>
                                        {body && (
                                            <Typography variant='body2' sx={{ color: theme.palette.text.secondary, mt: 0.25 }}>
                                                {body}
                                            </Typography>
                                        )}
                                        <Stack direction='row' alignItems='center' flexWrap='wrap' sx={{ gap: 0.5, mt: 0.5 }}>
                                            <Chip size='small' variant='outlined' label={version.shortOid} />
                                            <Typography variant='body2' sx={{ color: theme.palette.text.secondary }}>
                                                {version.author?.name}
                                            </Typography>
                                            {(version.tags ?? []).map((tag) => (
                                                <Chip
                                                    key={tag}
                                                    size='small'
                                                    color='primary'
                                                    variant='outlined'
                                                    icon={<IconTag size={14} />}
                                                    label={tag}
                                                />
                                            ))}
                                        </Stack>
                                        <Stack direction='row' alignItems='center' flexWrap='wrap' sx={{ gap: 1, mt: 1 }}>
                                            <Button
                                                size='small'
                                                variant='outlined'
                                                onClick={() => setSelectedOid(isSelected ? null : version.oid)}
                                            >
                                                {isSelected ? 'Hide changes' : 'View changes'}
                                            </Button>
                                            <Button
                                                size='small'
                                                onClick={() => {
                                                    setTagTarget(version)
                                                    setTagDialogOpen(true)
                                                }}
                                            >
                                                Name checkpoint
                                            </Button>
                                            <StyledButton
                                                size='small'
                                                variant='contained'
                                                disabled={isRestoring}
                                                onClick={() => handleRestore(version)}
                                            >
                                                Restore
                                            </StyledButton>
                                        </Stack>
                                        {isSelected && (
                                            <FlowVersionDiffView
                                                diff={getDiffApi.data}
                                                loading={getDiffApi.loading}
                                                promptsOnly={promptsOnly}
                                                onTogglePromptsOnly={setPromptsOnly}
                                                compareLabel={`${version.shortOid} → current`}
                                            />
                                        )}
                                    </TimelineContent>
                                </TimelineItem>
                            )
                        })}
                    </Timeline>
                </Box>
            </SwipeableDrawer>
            <TagFlowVersionDialog
                show={tagDialogOpen}
                dialogProps={{
                    title: 'Name this checkpoint',
                    shortOid: tagTarget?.shortOid,
                    confirmButtonName: 'Save',
                    cancelButtonName: 'Cancel'
                }}
                onCancel={() => setTagDialogOpen(false)}
                onConfirm={handleTag}
            />
        </>
    )
}

FlowVersionsSideDrawer.propTypes = {
    show: PropTypes.bool,
    dialogProps: PropTypes.object,
    onClose: PropTypes.func,
    onRestored: PropTypes.func
}

export default FlowVersionsSideDrawer
