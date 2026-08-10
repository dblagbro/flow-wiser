import { Component } from 'react'
import PropTypes from 'prop-types'
import { Box, Button, Card, Stack, Typography } from '@mui/material'

/**
 * A real React error boundary, wrapped around every routed view.
 *
 * ── Why this exists, and why the existing ErrorBoundary was not enough ───────────────────────
 *
 * `@/ErrorBoundary` is a *display* component: a view catches an API error, puts it in state, and
 * renders `<ErrorBoundary error={error} />`. That covers the errors a view anticipated. It cannot
 * catch an exception thrown during render or inside an effect, because nothing calls it.
 *
 * `/sso-config` threw `Cannot read properties of undefined (reading 'find')` in a useEffect — the
 * loginmethod endpoint returns `[]` on an instance with no SSO configured, and the code read
 * `data.providers`. With no boundary above it, React unmounted the entire tree: the whole
 * application went blank white. No shell, no sidebar, no message, and nothing failed in the network
 * log, so from the server it looked perfectly healthy (UI-02).
 *
 * The specific bug is fixed at its source. This exists so that the next one — and in a UI this size
 * there will be a next one — costs a single page instead of the entire application.
 *
 * Deliberately a class: `getDerivedStateFromError` and `componentDidCatch` have no hook equivalent.
 */
class RouteErrorBoundary extends Component {
    constructor(props) {
        super(props)
        this.state = { error: null }
    }

    static getDerivedStateFromError(error) {
        return { error }
    }

    componentDidCatch(error, info) {
        // Kept to the console rather than shipped anywhere: an error boundary that tries to report
        // over the network is an error boundary that can fail while handling a failure.
        // eslint-disable-next-line no-console
        console.error('[route] unhandled error while rendering', error, info?.componentStack)
    }

    render() {
        const { error } = this.state
        if (!error) return this.props.children

        return (
            <Box sx={{ p: 4, display: 'flex', justifyContent: 'center' }}>
                <Stack flexDirection='column' sx={{ alignItems: 'center', gap: 2, maxWidth: 720 }}>
                    <Typography variant='h2'>This page failed to load</Typography>
                    <Typography variant='body1' sx={{ textAlign: 'center' }}>
                        The rest of the application is still working — use the navigation to continue.
                    </Typography>
                    <Card variant='outlined' sx={{ width: '100%' }}>
                        <Box sx={{ px: 2, py: 2 }}>
                            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
                                {String(error?.message || error)}
                            </pre>
                        </Box>
                    </Card>
                    <Button variant='outlined' onClick={() => this.setState({ error: null })}>
                        Try again
                    </Button>
                </Stack>
            </Box>
        )
    }
}

RouteErrorBoundary.propTypes = {
    children: PropTypes.node
}

export default RouteErrorBoundary
