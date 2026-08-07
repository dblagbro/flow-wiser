import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'

import { Button, Dialog, DialogActions, DialogContent, DialogContentText, OutlinedInput, DialogTitle } from '@mui/material'
import { StyledButton } from '@/ui-component/button/StyledButton'

// ==============================|| TAG FLOW VERSION DIALOG ||============================== //

// Names a version so it can be found again later — REQUIREMENTS-VERSIONING.md §6, "named checkpoints".
const TagFlowVersionDialog = ({ show, dialogProps, onCancel, onConfirm }) => {
    const portalElement = document.getElementById('portal')

    const [label, setLabel] = useState('')

    useEffect(() => {
        if (show) setLabel('')
    }, [show])

    const isReadyToSave = label.trim().length > 0

    const component = show ? (
        <Dialog
            open={show}
            fullWidth
            maxWidth='xs'
            onClose={onCancel}
            aria-labelledby='tag-version-dialog-title'
            aria-describedby='tag-version-dialog-description'
            disableRestoreFocus // needed due to StrictMode
        >
            <DialogTitle sx={{ fontSize: '1rem' }} id='tag-version-dialog-title'>
                {dialogProps.title}
            </DialogTitle>
            <DialogContent>
                <DialogContentText id='tag-version-dialog-description' sx={{ fontSize: '0.85rem' }}>
                    Name version {dialogProps.shortOid} so you can find it again.
                </DialogContentText>
                <OutlinedInput
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    sx={{ mt: 2 }}
                    id='flow-version-label'
                    type='text'
                    fullWidth
                    placeholder='before RAG prompt rewrite'
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    onKeyDown={(e) => {
                        if (isReadyToSave && e.key === 'Enter') onConfirm(label.trim())
                    }}
                />
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel}>{dialogProps.cancelButtonName}</Button>
                <StyledButton disabled={!isReadyToSave} variant='contained' onClick={() => onConfirm(label.trim())}>
                    {dialogProps.confirmButtonName}
                </StyledButton>
            </DialogActions>
        </Dialog>
    ) : null

    return createPortal(component, portalElement)
}

TagFlowVersionDialog.propTypes = {
    show: PropTypes.bool,
    dialogProps: PropTypes.object,
    onCancel: PropTypes.func,
    onConfirm: PropTypes.func
}

export default TagFlowVersionDialog
