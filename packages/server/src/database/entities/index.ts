import { ChatFlow } from './ChatFlow'
import { ChatMessage } from './ChatMessage'
import { ChatMessageFeedback } from './ChatMessageFeedback'
import { Credential } from './Credential'
import { Tool } from './Tool'
import { Assistant } from './Assistant'
import { Variable } from './Variable'
import { DocumentStore } from './DocumentStore'
import { DocumentStoreFileChunk } from './DocumentStoreFileChunk'
import { Lead } from './Lead'
import { UpsertHistory } from './UpsertHistory'
import { Dataset } from './Dataset'
import { DatasetRow } from './DatasetRow'
import { EvaluationRun } from './EvaluationRun'
import { Evaluation } from './Evaluation'
import { Evaluator } from './Evaluator'
import { ApiKey } from './ApiKey'
import { CustomTemplate } from './CustomTemplate'
import { Execution } from './Execution'
import { CustomMcpServer } from './CustomMcpServer'
// Apache-2.0 identity layer. These replace the commercially-licensed entities that
// previously bound these same class names. Their tables are `identity_`-prefixed, so the
// outgoing tables are left intact for the data migration -- see docs/REQUIREMENTS-MIGRATION.md.
import {
    User,
    Organization,
    OrganizationUser,
    Workspace,
    WorkspaceUser,
    Role,
    LoginMethod,
    LoginActivity,
    Session,
    Token,
    MfaFactor,
    MfaRecoveryCode,
    AuditEvent,
    WorkspaceShared
} from './identity'
import { LoginMethod } from '../../database/entities/identity'
import { LoginSession } from '../../database/entities/identity'
import { ScheduleRecord } from './ScheduleRecord'
import { ScheduleTriggerLog } from './ScheduleTriggerLog'

export const entities = {
    ChatFlow,
    ChatMessage,
    ChatMessageFeedback,
    Credential,
    Tool,
    Assistant,
    Variable,
    UpsertHistory,
    DocumentStore,
    DocumentStoreFileChunk,
    Lead,
    Dataset,
    DatasetRow,
    Evaluation,
    EvaluationRun,
    Evaluator,
    ApiKey,
    User,
    WorkspaceUser,
    LoginActivity,
    WorkspaceShared,
    CustomTemplate,
    Execution,
    CustomMcpServer,
    Organization,
    Role,
    OrganizationUser,
    Workspace,
    LoginMethod,
    Session,
    Token,
    MfaFactor,
    MfaRecoveryCode,
    AuditEvent,
    ScheduleRecord,
    ScheduleTriggerLog
}
