import express, { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { DataSource } from 'typeorm'
import { AuditOutcome, AuditSubjectType } from '../../database/entities/identity/AuditEvent'
import { User } from '../../database/entities/identity/User'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { AuditService } from '../services/AuditService'
import {
    detectChallengeKind,
    MfaActorContext,
    MfaAuditAction,
    MfaChallengeKind,
    MfaOutcome,
    MfaPolicyService
} from '../services/MfaPolicyService'
import { RecoveryCodeService } from '../services/RecoveryCodeService'
import { TOTP_PERIOD_SECONDS, TotpService } from '../services/TotpService'
import { AuthenticatedUser } from '../rbac/types'
import { verify as verifyPassword, verifyDummy } from '../crypto/passwords'

/**
 * Identity — MFA routes (requirements §8).
 *
 * Net-new surface. §8 records that "Flowise has no MFA at all … there is nothing to reimplement and
 * nothing to be clean-room about", so unlike every other identity route there is no wire contract to
 * satisfy and the shape below is chosen rather than inherited.
 *
 * ── This router is the SELF-SERVICE surface, not the login challenge ─────────────────────────
 * That distinction is the most important thing in this file, and it follows directly from §8: "MFA
 * is evaluated after primary auth (local or SSO) and BEFORE a session is issued, so a session never
 * exists in a half-authenticated state."
 *
 * A login-time `POST /mfa/verify` would have to authenticate its caller somehow, and the caller has
 * just proved a password but holds no session — so it would need a short-lived "MFA pending" token.
 * That token IS the half-authenticated state §8 forbids: a bearer credential that exists between
 * the first and second factor, that can be stolen, replayed or accepted by a route that forgot to
 * check its kind.
 *
 * So the login challenge is not an endpoint at all. `POST /auth/login` accepts the code alongside
 * the password and the login service runs the sequence documented on `MfaEvaluation` — evaluate,
 * verify, then `SessionService.issue({ mfaSatisfied: true, mfaFactorId, mfaSatisfiedDate })`. What
 * this feature exposes to that service is the three service classes, not an HTTP hop.
 *
 * Everything HERE is for a caller who already holds a session: enrol a device, confirm it, step up,
 * remove it, replace the recovery codes, see the state. `POST /mfa/verify` is therefore a STEP-UP
 * check, and it is what makes re-authentication possible for an SSO-only account that has no local
 * password to re-present.
 *
 * ── Not mounted ──────────────────────────────────────────────────────────────────────────────
 * Deliberately not registered in `routes/index.ts`. The MFA UI (§8: "this needs new UI — an
 * enrolment screen and a challenge step") and the auth layer that populates `req.user` land
 * separately; wiring a router whose authentication middleware does not exist yet would expose these
 * paths with `req.user` permanently undefined.
 */

/** §8: "Re-authentication required to disable MFA or regenerate codes." */
const REAUTHENTICATION_REQUIRED = 'Re-authentication is required for this operation'

/**
 * How recent a step-up TOTP proof may be when it stands in for a password.
 *
 * Only reached by accounts with no local credential (SSO-only), where `POST /mfa/verify` is the
 * only re-authentication available. Five minutes is long enough to complete a form and short
 * enough that a walked-away-from browser is not a standing authorisation.
 */
const REAUTHENTICATION_MAX_AGE_MS = 5 * 60 * 1000

const router = express.Router()

/**
 * The authenticated caller, plus the two fields the audit trail needs that `AuthenticatedUser` does
 * not carry.
 *
 * `rbac/types.ts` fixes `AuthenticatedUser` to what the Apache-2.0 construction site builds, and
 * narrowing locally rather than widening that type keeps this router independent of whatever the
 * session layer eventually declares — the same reasoning `rbac/PermissionCheck.ts` records for
 * reading `req.user` through a local narrowing.
 */
type MfaPrincipal = AuthenticatedUser & { sessionId?: string; email?: string }

const getPrincipal = (req: Request): MfaPrincipal | undefined => (req as Request & { user?: MfaPrincipal }).user

/** Route identity for the audit record. `originalUrl` is avoided: it carries the query string. */
const describeRoute = (req: Request): string => `${req.method} ${req.baseUrl || ''}${req.path || ''}`

const clientIp = (req: Request): string | null => req.ip ?? req.socket?.remoteAddress ?? null

interface MfaServices {
    totp: TotpService
    recovery: RecoveryCodeService
    policy: MfaPolicyService
    audit: AuditService
    dataSource: DataSource
}

/**
 * Services are resolved per request rather than at module load.
 *
 * Constructing them at import time would resolve the DataSource before the application has one, and
 * would make this module impossible to import in a test without booting the server — the same
 * problem the services themselves solve with a lazy `require`.
 */
const services = (): MfaServices => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
    const dataSource: DataSource = getRunningExpressApp().AppDataSource
    const audit = new AuditService({ dataSource })
    return {
        totp: new TotpService({ dataSource, audit }),
        recovery: new RecoveryCodeService({ dataSource, audit }),
        policy: new MfaPolicyService({ dataSource, audit }),
        audit,
        dataSource
    }
}

/** 401 rather than 403 for an unauthenticated caller — the client's generic handler redirects to login on 401. */
const requirePrincipal = (req: Request): MfaPrincipal => {
    const principal = getPrincipal(req)
    if (!principal?.id) throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Authentication is required')
    return principal
}

const contextFor = async (req: Request, principal: MfaPrincipal, dataSource: DataSource): Promise<MfaActorContext> => {
    const user = await dataSource.getRepository(User).findOne({ where: { id: principal.id as string }, select: { id: true, email: true } })
    return {
        userId: principal.id as string,
        email: user?.email ?? principal.email ?? null,
        sessionId: principal.sessionId ?? null,
        organizationId: principal.activeOrganizationId ?? null,
        workspaceId: principal.activeWorkspaceId ?? null,
        route: describeRoute(req),
        ipAddress: clientIp(req),
        userAgent: req.get('user-agent') ?? null
    }
}

/**
 * §8's re-authentication gate, guarding the two destructive operations: disabling MFA and replacing
 * the recovery codes.
 *
 * Both are ways to turn the second factor off — one directly, one by minting ten fresh bearer codes
 * — so both must cost more than a hijacked, already-open session. The proof is one of:
 *
 *   1. the account password, presented in THIS request. That is what "recent password verification"
 *      means at its strongest: not a flag set earlier, but the credential itself, verified now.
 *   2. a fresh TOTP code, for an account that has no local password at all. §7 requires local and
 *      SSO accounts to coexist, and an SSO-only user (`User.credential` is null) has no password to
 *      re-present — refusing them the operation entirely would mean SSO users can never rotate
 *      their recovery codes.
 *
 * Both paths are audited, failures included. The failure path deliberately burns
 * `verifyDummy()` time when there is no stored credential, for the reason `crypto/passwords.ts`
 * gives: an account with a null credential must be indistinguishable from a wrong password.
 */
const requireReauthentication = async (
    req: Request,
    principal: MfaPrincipal,
    context: MfaActorContext,
    svc: MfaServices
): Promise<void> => {
    const password = typeof req.body?.password === 'string' ? req.body.password : null
    const code = typeof req.body?.reauthCode === 'string' ? req.body.reauthCode : null

    const recordOutcome = async (outcome: AuditOutcome, method: string, reason: string | null) => {
        await svc.audit.record({
            action: MfaAuditAction.REAUTHENTICATE,
            outcome,
            subject: { type: AuditSubjectType.USER, id: context.userId, label: context.email, sessionId: context.sessionId ?? null },
            target: { type: 'user', id: context.userId },
            scope: { organizationId: context.organizationId ?? null, workspaceId: context.workspaceId ?? null },
            route: context.route ?? null,
            ipAddress: context.ipAddress ?? null,
            userAgent: context.userAgent ?? null,
            reason,
            // The method, never the credential. `redaction.ts` would strip a password anyway; not
            // passing one is stronger than relying on that.
            detail: { method },
            message: `MFA re-authentication ${outcome} for user ${context.userId}`
        })
    }

    if (password) {
        const stored = await svc.dataSource
            .getRepository(User)
            .findOne({ where: { id: context.userId }, select: { id: true, credential: true } })
        const ok = stored?.credential ? await verifyPassword(password, stored.credential) : await verifyDummy()
        await recordOutcome(ok ? AuditOutcome.SUCCESS : AuditOutcome.FAILURE, 'password', ok ? null : 'incorrect_credential')
        if (!ok) throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, REAUTHENTICATION_REQUIRED)
        return
    }

    if (code) {
        const verification = await svc.totp.verify({ userId: context.userId, code, context })
        const fresh = verification.ok && Date.now() - verification.step * TOTP_PERIOD_SECONDS * 1000 <= REAUTHENTICATION_MAX_AGE_MS
        await recordOutcome(fresh ? AuditOutcome.SUCCESS : AuditOutcome.FAILURE, 'totp', fresh ? null : 'incorrect_second_factor')
        if (!fresh) throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, REAUTHENTICATION_REQUIRED)
        return
    }

    await recordOutcome(AuditOutcome.FAILURE, 'none', 'no_proof_presented')
    throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, REAUTHENTICATION_REQUIRED)
}

/**
 * `POST /mfa/enroll` — phase one: generate a secret and return the provisioning URI (§8).
 *
 * The response carries the secret exactly once. It is not retrievable afterwards: the stored copy is
 * AEAD ciphertext and there is no endpoint that decrypts it, which is the whole point of §9 listing
 * "MFA/TOTP seeds" among the values encrypted at rest.
 *
 * Refused when the organization's policy is `off`, which "disables enrolment outright"
 * (Organization.ts) — allowing enrolment under `off` would let a user create a factor that is never
 * challenged, i.e. a credential that does nothing but exist.
 */
router.post('/enroll', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const principal = requirePrincipal(req)
        const svc = services()
        const context = await contextFor(req, principal, svc.dataSource)

        const evaluation = await svc.policy.evaluate(context.userId, context.organizationId, context)
        if (!evaluation.enrolmentAllowed) {
            throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'MFA enrolment is disabled for this organization')
        }

        const enrolment = await svc.totp.enrol({
            userId: context.userId,
            accountName: context.email ?? context.userId,
            label: typeof req.body?.label === 'string' ? req.body.label : null,
            issuer: typeof req.body?.issuer === 'string' ? req.body.issuer : undefined,
            context
        })
        return res.status(StatusCodes.CREATED).json(enrolment)
    } catch (error) {
        next(error)
    }
})

/**
 * `POST /mfa/confirm` — phase two: one correct code promotes the pending factor to confirmed (§8).
 *
 * Recovery codes are issued HERE and only here, on the first factor a user confirms, and the
 * plaintext is in this response and nowhere else (§8: "shown once"). Issuing them at enrolment
 * start would hand out a working bypass for a factor the user never finished setting up.
 */
router.post('/confirm', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const principal = requirePrincipal(req)
        const svc = services()
        const context = await contextFor(req, principal, svc.dataSource)

        const factorId = typeof req.body?.factorId === 'string' ? req.body.factorId : null
        const code = typeof req.body?.code === 'string' ? req.body.code : ''
        if (!factorId) throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, 'factorId is required')

        const result = await svc.totp.confirm({ userId: context.userId, factorId, code, context })
        if (!result.ok) throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'The verification code was not accepted')

        const existing = await svc.recovery.status(context.userId)
        const batch = existing.enrolled ? null : await svc.recovery.generate({ userId: context.userId, context })

        return res.status(StatusCodes.OK).json({
            factorId: result.factorId,
            status: 'confirmed',
            // Present only on the first confirmation. A client must persist them at this point;
            // there is no second chance and no endpoint that can produce them again.
            recoveryCodes: batch?.codes ?? null,
            recoveryBatchId: batch?.batchId ?? existing.batchId
        })
    } catch (error) {
        next(error)
    }
})

/**
 * `POST /mfa/verify` — step-up verification for a caller who already holds a session.
 *
 * Accepts either a TOTP code or a recovery code and routes on shape, never on a client-supplied
 * type (`detectChallengeKind`): letting the caller declare the kind would let them aim a mistyped
 * authenticator code at the recovery path, which is the expensive one.
 *
 * This is NOT the login challenge — see the module header for why that one is not an endpoint.
 */
router.post('/verify', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const principal = requirePrincipal(req)
        const svc = services()
        const context = await contextFor(req, principal, svc.dataSource)

        const code = typeof req.body?.code === 'string' ? req.body.code : ''
        if (!code) throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, 'code is required')

        if (detectChallengeKind(code) === MfaChallengeKind.TOTP) {
            const result = await svc.totp.verify({ userId: context.userId, code, context })
            if (!result.ok) throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'The verification code was not accepted')
            return res.status(StatusCodes.OK).json({ verified: true, method: MfaChallengeKind.TOTP, factorId: result.factorId })
        }

        const redeemed = await svc.recovery.consume({ userId: context.userId, code, sessionId: context.sessionId ?? null, context })
        if (!redeemed.ok) throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'The verification code was not accepted')
        return res
            .status(StatusCodes.OK)
            .json({ verified: true, method: MfaChallengeKind.RECOVERY, remainingRecoveryCodes: redeemed.remaining })
    } catch (error) {
        next(error)
    }
})

/**
 * `POST /mfa/disable` — remove a factor, or every factor (§8: re-authentication required).
 *
 * Removing the LAST factor also invalidates the recovery codes, by issuing nothing and leaving the
 * old batch superseded — a recovery code whose only purpose is to stand in for an authenticator
 * that no longer exists is a password-equivalent bearer token with no second factor behind it.
 * Rather than delete history, the codes are simply no longer reachable: `consume()` scopes to the
 * current batch, and re-enrolling issues a new one.
 */
router.post('/disable', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const principal = requirePrincipal(req)
        const svc = services()
        const context = await contextFor(req, principal, svc.dataSource)
        await requireReauthentication(req, principal, context, svc)

        const factorId = typeof req.body?.factorId === 'string' ? req.body.factorId : null
        const removed = await svc.totp.disable({ userId: context.userId, factorId, context })
        if (removed === 0) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'No matching MFA factor')

        const remaining = await svc.totp.list(context.userId)
        return res.status(StatusCodes.OK).json({ removed, remainingFactors: remaining })
    } catch (error) {
        next(error)
    }
})

/**
 * `POST /mfa/recovery-codes/regenerate` — replace the batch (§8: re-authentication required).
 *
 * The response is the only time the new codes exist outside a hash, and issuing them invalidates
 * every earlier batch (`RecoveryCodeService.generate`).
 */
router.post('/recovery-codes/regenerate', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const principal = requirePrincipal(req)
        const svc = services()
        const context = await contextFor(req, principal, svc.dataSource)
        await requireReauthentication(req, principal, context, svc)

        const batch = await svc.recovery.generate({ userId: context.userId, context })
        return res.status(StatusCodes.OK).json({ batchId: batch.batchId, codes: batch.codes, generatedDate: batch.generatedDate })
    } catch (error) {
        next(error)
    }
})

/**
 * `GET /mfa/status` — everything an account screen or an enrolment gate needs, in one call.
 *
 * Reports the effective policy, not just the user's own state, so the client can tell "you may
 * enrol" from "you must enrol" without re-deriving the two-axis rule (Organization.ts) in
 * JavaScript — where it would inevitably drift from the server's answer.
 *
 * Carries no secret and no hash: factor summaries omit the seed columns entirely, and the recovery
 * codes are reported as counts.
 */
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const principal = requirePrincipal(req)
        const svc = services()
        const context = await contextFor(req, principal, svc.dataSource)

        const [evaluation, factors, recovery] = await Promise.all([
            svc.policy.evaluate(context.userId, context.organizationId, context),
            svc.totp.list(context.userId),
            svc.recovery.status(context.userId)
        ])

        return res.status(StatusCodes.OK).json({
            policy: evaluation.policy,
            required: evaluation.required,
            exempt: evaluation.exempt,
            enrolmentAllowed: evaluation.enrolmentAllowed,
            outcome: evaluation.outcome,
            enrolled: evaluation.hasConfirmedFactor,
            mustEnrol: evaluation.outcome === MfaOutcome.ENROLMENT_REQUIRED,
            factors,
            recoveryCodes: { total: recovery.total, remaining: recovery.remaining, generatedDate: recovery.generatedDate }
        })
    } catch (error) {
        next(error)
    }
})

export default router
