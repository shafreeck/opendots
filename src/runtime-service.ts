import { projectTaskDetail, type TaskDetail } from './task-detail.ts';
import { AuthoredDocuments } from './authored-documents.ts';
import { AuthoredDocumentHost } from './authored-document-host.ts';
import { ObjectiveInput, type ObjectiveInputRequest, type ObjectiveInputDestination } from './objective-input.ts';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AttachmentUploads, attachmentUploadLimits, type AttachmentUploadInput } from './attachment-upload.ts';
import { NotificationOutbox } from './notification-outbox.ts';
import { Artifacts } from './artifacts.ts';
import { ArtifactVersions, type CreateArtifactDocumentInput, type AppendArtifactVersionInput } from './artifact-versions.ts';
import { MemoryView } from './memory-view.ts';
import { Reminders, type ReminderInput } from './reminders.ts';
import { CalendarReminders, CalendarReminderError, previewCalendar, validateCalendarRule, type CalendarControlInput } from './calendar-reminders.ts';
import { CalendarProposals, CalendarProposalError } from './calendar-proposals.ts';
import { CalendarProposalHost } from './calendar-proposal-host.ts';
import type { NativeHostAuthority } from './native-host-authority.ts';
import { LocalOperatorAdapter, MorphzError, type RuntimeObjective } from './morphz-adapter.ts';
import { RuntimeStore, type InputCommand, type UserBinding } from './runtime-store.ts';
import { DraftProjection } from './runtime-stream.ts';
import { ModelSettings } from './model-settings.ts';
import { ConflictError, MissingError } from './store.ts';

export class RuntimeUnavailableError extends Error {
  readonly status = 503;
  constructor(message = 'Morphz Runtime is unavailable. Your command is saved; retry with the same key.') { super(message); }
}
export interface RuntimeServiceOptions {
  dbPath: string;
  baseUrl?: string;
  operatorToken?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  pollIntervalMs?: number;
  autoStart?: boolean;
  streamEnabled?: boolean;
  streamTransport?: 'application_ws' | 'typed_io';
  calendarNow?: () => number;
}
export interface RuntimeStatus {
  status: 'connecting' | 'ready' | 'unavailable' | 'configuration_required';
  message: string; lastSyncedAt: number | null;
  verification: 'runtime_connection_only';
}

/** Single-user application host. This is not a public tenant gateway.
 * Browser calls cannot select a Principal, Agent, Context or arbitrary Session.
 * The operator adapter is confined to the fixed binding created by this host.
 */
export class RuntimeService {
  readonly store: RuntimeStore;
  readonly adapter?: LocalOperatorAdapter;
  private binding?: UserBinding;
  private initialized = false;
  private models?: ModelSettings;
  private reminders?: Reminders;
  private calendar?: CalendarReminders;
  private calendarProposals?: CalendarProposals;
  private calendarNow: () => number;
  private calendarReconciling?: Promise<Awaited<ReturnType<CalendarReminders['reconcile']>>>;
  private calendarLastAttempt = 0;
  private calendarStatus: {status:'idle'|'running'|'unavailable';lastReconciledAt:number|null} = {status:'idle',lastReconciledAt:null};
  private memories?: MemoryView;
  private notifications?: NotificationOutbox;
  private artifacts?: Artifacts;
  private artifactVersions?: ArtifactVersions;
  private authoredDocuments?: AuthoredDocuments;
  private taskReads = new Map<string,Promise<TaskDetail>>();
  private uploads?: AttachmentUploads;
  private dbPath: string;
  private initializing?: Promise<void>;
  private syncing?: Promise<void>;
  private inFlight = new Map<string, Promise<InputCommand>>();
  private timer?: ReturnType<typeof setInterval>;
  private pollIntervalMs: number;
  private closed = false;
  private requestAuthorization = new AsyncLocalStorage<(() => void) | undefined>();
  private streamEnabled: boolean;
  private streamTransport: 'application_ws' | 'typed_io';
  private streamAbort?: AbortController;
  private streamPromise?: Promise<void>;
  private drafts?: DraftProjection;
  private historyProjection = { incomplete: false, pageBudget: 16 };
  private objectiveProjection = { truncated: false, limit: 2000 };
  private streamStatus: 'disabled' | 'connected' | 'reconnecting' = 'disabled';
  status: RuntimeStatus;
  constructor(options: RuntimeServiceOptions) {
    this.calendarNow = options.calendarNow ?? Date.now;
    this.store = new RuntimeStore(options.dbPath);
    this.dbPath = options.dbPath;
    this.pollIntervalMs = options.pollIntervalMs ?? 1200;
    this.streamEnabled = options.streamEnabled ?? options.autoStart !== false;
    this.streamTransport = options.streamTransport ?? 'application_ws';
    this.status = { status: options.baseUrl ? 'connecting' : 'configuration_required', message: options.baseUrl ? 'Connecting to Morphz Runtime. No model call has been made.' : 'Set MORPHZ_URL to your local Morphz Runtime origin and MORPHZ_OPERATOR_TOKEN when authentication is enabled. Demo mode requires npm run demo.', lastSyncedAt: null, verification: 'runtime_connection_only' };
    try {
      if (options.baseUrl) {
        const fetcher = options.fetch ?? globalThis.fetch;
        this.adapter = new LocalOperatorAdapter({ baseUrl: options.baseUrl, operatorToken: options.operatorToken, fetch: async (...args) => {
          this.assertRequestAuthorized();
          const response = await fetcher(...args);
          this.assertRequestAuthorized();
          return response;
        }, timeoutMs: options.timeoutMs });
        this.binding = this.store.ensureBinding(this.adapter.baseUrl);
        this.drafts = new DraftProjection(this.binding.sessionId);
      }
    } catch (error) { this.store.close(); throw error; }
    const savedBinding=this.store.binding();
    if(savedBinding)this.notifications=new NotificationOutbox(this.dbPath,{userId:savedBinding.userId,sessionId:savedBinding.sessionId,contextId:savedBinding.contextId,agentId:savedBinding.agentId});
    if (options.autoStart !== false) this.start();
  }
  /** Explicit host lifecycle boundary, after authentication configuration guards. */
  start() {
    if (this.closed || this.timer || !this.adapter) return;
    this.timer = setInterval(() => { void this.refresh(); }, this.pollIntervalMs);
    this.timer.unref(); void this.refresh();
  }
  /** Per-request capability, isolated across concurrent callers. No global user
   * switch. Native dispatch and local admission recheck after asynchronous reads. */
  withRequestAuthorization<T>(assertAuthorized: () => void, operation: () => T): T { assertAuthorized(); return this.requestAuthorization.run(assertAuthorized, operation); }
  private assertRequestAuthorized() { this.requestAuthorization.getStore()?.(); }
  private requireAdapter(): LocalOperatorAdapter {
    if (!this.adapter) throw new RuntimeUnavailableError(this.status.message);
    return this.adapter;
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    // Fixed Runtime bootstrap is host lifecycle, not a browser device's task.
    this.initializing = this.requestAuthorization.run(undefined, () => this.bootstrap().finally(() => { this.initializing = undefined; }));
    return this.initializing;
  }
  private async bootstrap() {
    const adapter = this.requireAdapter(); const binding = this.binding!;
    await adapter.getCapabilities();
    let session;
    try { session = await adapter.getSession(binding.sessionId); }
    catch (error) {
      if (!(error instanceof MorphzError) || error.status !== 404) throw error;
      // Existing verified identity must never be recreated on a changed/empty backend.
      if (binding.verified) throw new ConflictError('The saved Session is missing from this Runtime. Restore the matching Runtime data before continuing.');
      const agents = await adapter.listAgents();
      const existing = agents.agents.find(value => value.id === binding.agentId);
      if (existing) throw new ConflictError('The saved Agent exists but its Session cannot be authorized. Resolve the Runtime binding before retrying; no replacement was created.');
      try {
        const bundle = await adapter.createAgentBundle({ id: binding.agentId, root_context_id: binding.contextId, initial_session_id: binding.sessionId, title: 'opendots', root_context_title: 'opendots personal context', initial_session_title: 'opendots conversation' });
        session = bundle.initial_session;
      } catch (createError) {
        // A lost response is not evidence of failure. Read fixed identity before retry.
        try { session = await adapter.getSession(binding.sessionId); }
        catch { throw createError; }
      }
    }
    const principal = await adapter.getPrincipal(binding.sessionId);
    if (principal.session_id !== binding.sessionId || principal.context_id !== binding.contextId) throw new ConflictError('Runtime principal scope does not match the saved binding');
    this.binding = this.store.verifyBinding(session, principal.principal_id);
    this.initialized = true;
  }
  private checkObjective(value: RuntimeObjective) {
    const binding = this.binding!;
    if (!value || value.agent_id !== binding.agentId || value.context_id !== binding.contextId || !value.id || !Number.isSafeInteger(value.revision)) throw new ConflictError('Runtime Objective is outside the local binding');
  }
  private async overview() {
    const binding = this.binding!;
    const [overview, scheduler] = await Promise.all([
      this.requireAdapter().getContextOverview(binding.contextId, binding.sessionId),
      this.requireAdapter().getContextScheduler(binding.contextId),
    ]);
    if (overview.context?.id !== binding.contextId || overview.context.agent_id !== binding.agentId || !Array.isArray(overview.objectives) || scheduler.context_id !== binding.contextId || !Array.isArray(scheduler.objectives)) throw new ConflictError('Runtime Context does not match the local binding');
    // Context overview intentionally excludes terminal objectives. Scheduler is the
    // authoritative bounded inventory INCLUDING terminal state; never treat omission as active.
    const objectives = new Map(overview.objectives.map(value => [value.id, value]));
    for (const row of scheduler.objectives) objectives.set(row.objective.id, row.objective);
    this.objectiveProjection = { truncated: scheduler.detail_bounds?.has_more_objectives === true, limit: scheduler.detail_bounds?.limit ?? 2000 };
    for (const objective of objectives.values()) { this.checkObjective(objective); this.store.setView('objective', objective.id, objective); }
    for (const previous of this.store.objectives()) {
      if (!objectives.has(previous.id) && !['completed', 'cancelled', 'failed'].includes(previous.status)) {
        this.store.setView('objective', previous.id, { ...previous, status: 'unknown', last_known_status: previous.last_known_status ?? previous.status, status_reason: 'Not present in the current bounded Runtime inventory. No terminal status has been inferred.' });
      }
    }
    return { ...overview, objectives: [...objectives.values()], objectivesTruncated: this.objectiveProjection.truncated };
  }
  async refresh(): Promise<void> {
    if (this.closed || !this.adapter) return;
    if (this.syncing) return this.syncing;
    this.syncing = this.requestAuthorization.run(undefined, () => this.synchronize().finally(() => { this.syncing = undefined; }));
    return this.syncing;
  }
  private async synchronize() {
    try {
      await this.initialize();
      const binding = this.binding!; const adapter = this.requireAdapter();
      // Recover only idempotent admissions. Control/approval uncertainty needs an explicit retry.
      for (const command of this.store.recoverableCommands().filter(value => value.errorCode !== 'upstream_authorization_denied')) {
        if (Date.now() - command.updatedAt < Math.min(30_000, 1000 * 2 ** Math.min(command.attempts, 5))) continue;
        await this.dispatch(command).catch(() => undefined);
      }
      // A page may contain zero rendered events but a changed opaque cursor.
      // Keep traversing until the cursor is unchanged, bounded per tick for responsiveness.
      this.historyProjection.incomplete = true;
      for (let pageNumber = 0; pageNumber < this.historyProjection.pageBudget; pageNumber++) {
        const previous = this.store.cursor(binding.sessionId);
        const page = await adapter.listEvents(binding.sessionId, previous);
        this.store.ingest(binding.sessionId, page, previous);
        if (page.cursor === previous) { this.historyProjection.incomplete = false; break; }
      }
      const [, approvals] = await Promise.all([this.overview(), adapter.listApprovals(binding.sessionId)]);
      this.store.replaceApprovals(approvals.approvals);
      this.notifications?.sync({sessionId:binding.sessionId,approvals:{items:approvals.approvals,complete:!approvals.truncated},objectives:this.store.objectives()});
      const roots = new Set(this.store.events(binding.sessionId).map(event => event.root_turn_id).filter((value): value is string => typeof value === 'string'));
      // Thread state is obtained from the principal-scoped authority, not guessed from text.
      for (const root of [...roots].slice(-50)) {
        try {
          const result = await adapter.getTurnThread(binding.sessionId, root);
          this.store.setView('thread', root, { ...result, root_turn_id: root });
        } catch (error) { if (!(error instanceof MorphzError) || error.status !== 404) throw error; }
      }
      this.startObservation();
      this.status = { ...this.status, status: 'ready', message: 'Connected to Morphz Runtime. Provider configuration and model quality are not verified by connection readiness.', lastSyncedAt: Date.now() };
      this.reconcileCalendarLifecycle();
    } catch (error) {
      if (error instanceof MorphzError && [401, 403].includes(error.status)) { this.initialized = false; this.streamAbort?.abort(); }
      this.status = { ...this.status, status: error instanceof ConflictError ? 'configuration_required' : 'unavailable', message: safeFailure(error) };
    }
  }
  private startObservation() {
    if (!this.streamEnabled || this.streamPromise || this.closed || !this.binding) return;
    const controller = new AbortController(); this.streamAbort = controller; this.streamStatus = 'reconnecting'; this.drafts!.clear();
    // Bounded connection lifetime also refreshes authorization and catches dead peers.
    const lifetime = setTimeout(() => controller.abort(), 300_000); lifetime.unref();
    const receive = (event: Record<string, unknown>) => {
      this.streamStatus = 'connected'; this.drafts!.consume(event);
      // Stream event IDs are not installed as history cursors. The durable page consumer owns checkpoints.
      if (['input.accepted', 'output.committed', 'run.state', 'execution.event'].includes(String(event.type))) void this.refresh();
    };
    const observing = this.streamTransport === 'application_ws'
      ? this.requireAdapter().observeApplication(this.binding.sessionId, controller.signal, receive)
      : this.requireAdapter().observe(this.binding.sessionId, this.store.cursor(this.binding.sessionId), controller.signal, receive);
    this.streamPromise = observing.catch(() => undefined).finally(() => {
      clearTimeout(lifetime); this.drafts!.clear(); this.streamPromise = undefined; this.streamAbort = undefined; this.initialized = false; this.streamStatus = this.closed ? 'disabled' : 'reconnecting';
    });
  }
  private async dispatch(command: InputCommand): Promise<InputCommand> {
    const current = this.store.command(command.id)!;
    if (current.status === 'accepted') return current;
    if (current.status === 'rejected') throw new ConflictError('This command was rejected. Review its status before submitting a new command.');
    if (current.errorCode === 'upstream_authorization_denied') throw new ConflictError('Runtime authorization rejected this command. Automatic or explicit replay is blocked until authority is reviewed.');
    if (current.kind === 'objective_control' && this.store.laterControlReview(current.id)) throw new ConflictError('A later reviewed control exists. The historical unknown command must not be dispatched again.');
    const running = this.inFlight.get(command.id); if (running) return running;
    // The durable command is already admitted for this fixed owner. Revoking a
    // browser must not silently cancel or replay admitted background work.
    const operation = this.requestAuthorization.run(undefined, () => this.execute(current).finally(() => this.inFlight.delete(command.id)));
    this.inFlight.set(command.id, operation); return operation;
  }
  private async execute(command: InputCommand): Promise<InputCommand> {
    try { await this.initialize(); }
    catch (error) {
      if (error instanceof MorphzError && [401,403].includes(error.status)) this.store.record(command.id,command.status==='unknown'?'unknown':'rejected',command.receipt,'upstream_authorization_denied');
      this.status = { ...this.status, status: 'unavailable', message: safeFailure(error) }; throw new RuntimeUnavailableError(safeFailure(error));
    }
    const adapter = this.requireAdapter(); const binding = this.binding!; const payload = command.payload;
    this.store.attempted(command.id);
    try {
      let receipt: unknown;
      if (command.kind === 'chat') {
        const accepted = await adapter.sendMessage(binding.sessionId, String(payload.text), typeof payload.clientMessageId === 'string' ? payload.clientMessageId : command.id, 'parallel', payload.attachments as Array<{ stage_id: string }> | undefined);
        if (accepted.session_id !== binding.sessionId || accepted.status !== 'accepted' || accepted.accepted !== true || !accepted.event_id) throw new Error('Invalid Runtime admission receipt');
        receipt = accepted; // Do not copy accepted.cursor into the history cursor.
      } else if (command.kind === 'objective_input') {
        const accepted = await adapter.sendObjectiveInput(binding.sessionId, String(payload.text), command.id, payload.destination as ObjectiveInputDestination);
        if (accepted.session_id !== binding.sessionId || accepted.status !== 'accepted' || accepted.accepted !== true || !accepted.event_id) throw new Error('Invalid directed input admission receipt');
        receipt = accepted;
      } else if (command.kind === 'objective') {
        const id = `objective-${command.id}`;
        const overview = await this.overview();
        let objective = overview.objectives.find(value => value.id === id);
        if (objective) {
          if (objective.stated_objective !== payload.prompt || objective.coordinator_session_id !== binding.sessionId || objective.delivery_session_id !== binding.sessionId) throw new ConflictError('Existing Objective does not match this durable command');
          receipt = { objective, recovered: true };
        } else {
          if (command.attempts > 0 && overview.objectivesTruncated) throw new RuntimeUnavailableError('Objective reconciliation is incomplete because Runtime inventory is bounded. No duplicate creation was attempted.');
          const created = await adapter.createObjective({ id, coordinator_session_id: binding.sessionId, delivery_session_id: binding.sessionId, stated_objective: String(payload.prompt) });
          this.checkObjective(created.objective); objective = created.objective; receipt = created;
        }
        this.store.setView('objective', objective.id, objective);
      } else if (command.kind === 'objective_control') {
        const overview = await this.overview();
        const objective = overview.objectives.find(value => value.id === payload.objectiveId);
        if (!objective) throw new MissingError('Objective not found in the local Context');
        this.checkObjective(objective);
        if (objective.coordinator_session_id !== binding.sessionId || (objective.initiating_principal_id != null && objective.initiating_principal_id !== binding.principalId)) throw new ConflictError('Objective control is outside the saved owner Session');
        const actions = objective.status === 'active' ? ['pause','cancel'] : ['paused','blocked'].includes(objective.status) ? ['resume','cancel'] : [];
        if (objective.revision !== payload.expectedRevision || !actions.includes(String(payload.action))) throw new ConflictError('The original Objective revision or action is no longer current.');
        receipt = await adapter.controlObjective(objective.id, payload.action as 'pause' | 'resume' | 'cancel', Number(payload.expectedRevision));
        const value = receipt as { objective?: RuntimeObjective };
        if (value.objective) { this.checkObjective(value.objective); this.store.setView('objective', value.objective.id, value.objective); }
        // Cancellation has no full record response; fetch actual terminal state.
        // Refresh the projection separately: a failed follow-up read must not erase a known receipt.
      } else if (command.kind === 'approval') {
        // Runtime revalidates revision, action and authority; renderer cannot supply scope/paths.
        const approval = await adapter.getApproval(binding.sessionId, String(payload.approvalId));
        if (approval.id !== payload.approvalId || approval.revision !== payload.expectedRevision || approval.status !== 'pending_human' || (payload.decision === 'allow_once' && !approval.available_scopes?.includes('once'))) throw new ConflictError('Approval scope, revision or pending decision changed');
        receipt = await adapter.decideApproval(binding.sessionId, approval.id, { expected_revision: Number(payload.expectedRevision), decision: payload.decision as 'allow_once' | 'deny' });
        this.store.setView('approval', approval.id, receipt);
      } else if (command.kind === 'turn_cancel') {
        const root = String(payload.rootTurnId);
        if (!this.store.events(binding.sessionId).some(event => event.root_turn_id === root)) throw new MissingError('Turn not found in the local Session');
        receipt = await adapter.cancelTurn(binding.sessionId, root, Number(payload.expectedRevision));
        this.store.setView('thread', root, { ...(receipt as Record<string, unknown>), root_turn_id: root });
      }
      this.store.record(command.id, 'accepted', receipt);
      void this.refresh(); return this.store.command(command.id)!;
    } catch (error) {
      const definitive = error instanceof ConflictError || error instanceof MissingError || (error instanceof MorphzError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status));
      // A later refusal proves only that this attempt was refused. It cannot
      // establish whether a response-lost predecessor caused an external effect.
      const status = command.status === 'unknown' ? 'unknown' : definitive ? 'rejected' : 'unknown';
      const code = error instanceof MorphzError && [401,403].includes(error.status) ? 'upstream_authorization_denied' : error instanceof MorphzError ? error.code ?? `upstream_${error.status}` : definitive ? 'scope_or_revision_conflict' : 'upstream_result_unknown';
      this.store.record(command.id, status, command.receipt, code);
      if (error instanceof MorphzError && [401, 403].includes(error.status)) this.initialized = false;
      throw error;
    }
  }
  async sendChat(text: string, key: string, attachmentDraft?: { draftKey: string; uploadIds: string[] }) {
    this.requireAdapter();
    if (!attachmentDraft) return this.dispatch(this.store.prepare('chat', key, { text }));
    const { draftKey, uploadIds } = attachmentDraft;
    const existing = this.store.commandByKey(key);
    if (existing) {
      if (existing.kind !== 'chat' || existing.payload.text !== text || existing.payload.draftKey !== draftKey || JSON.stringify(existing.payload.uploadIds) !== JSON.stringify(uploadIds)) throw new ConflictError('Command key already names another message or attachment set');
      return this.dispatch(existing);
    }
    const uploads = await this.uploadFacade();
    const envelope = await uploads.prepareSend(draftKey, uploadIds);
    const payload = { text, draftKey, uploadIds, ...envelope };
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    this.assertRequestAuthorized();
    const command = this.store.prepare('chat', key, payload, () => uploads.seal(draftKey, uploadIds, key, fingerprint));
    return this.dispatch(command);
  }
  private async uploadFacade() {
    await this.verifiedIdentity(); // Recheck the fixed native Principal/Session, never browser identity.
    return this.uploads ??= new AttachmentUploads(this.store.db, this.requireAdapter(), { userId: this.binding!.userId, sessionId: this.binding!.sessionId, principalId: this.binding!.principalId! });
  }
  async listUploads() { return { uploads: (await this.uploadFacade()).list(), limits: attachmentUploadLimits }; }
  async createUpload(input: AttachmentUploadInput) { return (await this.uploadFacade()).create(input); }
  async uploadChunk(id: string, offset: number, bytes: Uint8Array) { return (await this.uploadFacade()).upload(id, offset, bytes); }
  async reconcileUpload(id: string) { return (await this.uploadFacade()).reconcile(id); }
  async cancelUpload(id: string) { return (await this.uploadFacade()).cancel(id); }
  async createObjective(prompt: string, key: string) { this.requireAdapter(); return this.dispatch(this.store.prepare('objective', key, { prompt })); }
  private async objectiveInputContext(objectiveId: string) {
    await this.verifiedIdentity();
    const overview = await this.overview();
    const objective = overview.objectives.find(value => value.id === objectiveId);
    if (!objective) throw new MissingError('Objective not found in current Runtime inventory');
    const binding = this.binding!;
    const input = new ObjectiveInput({ agentId: binding.agentId, contextId: binding.contextId, sessionId: binding.sessionId, principalId: binding.principalId! });
    return { objective, input };
  }
  async objectiveInputTarget(objectiveId: string) {
    const { objective, input } = await this.objectiveInputContext(objectiveId);
    const target = input.target(objective);
    const capabilities = await this.requireAdapter().getCapabilities();
    return capabilities.directed_input === true ? target : { ...target, available: false, replyAvailable: false, waitInputAvailable: false, reason: 'directed_input_unavailable' };
  }
  async sendObjectiveInput(objectiveId: string, input: ObjectiveInputRequest) {
    if (!input || typeof input.text !== 'string' || Object.keys(input).some(k=>!['text','idempotencyKey','expectedGeneration','replyToRequestId','acknowledgeQuestionUnavailable','expectedSessionId'].includes(k))) throw new ConflictError('Invalid task input');
    const existing = this.store.commandByKey(input.idempotencyKey);
    if (existing) {
      const payload = existing.payload;
      if (existing.kind !== 'objective_input' || payload.objectiveId !== objectiveId || payload.text !== input.text.trim() || payload.expectedGeneration !== input.expectedGeneration || payload.replyToRequestId !== input.replyToRequestId || payload.acknowledgeQuestionUnavailable !== input.acknowledgeQuestionUnavailable || (input.expectedSessionId !== undefined && payload.sessionId !== input.expectedSessionId)) throw new ConflictError('This command key already names a different task input');
      return this.dispatch(existing); // Preserve original native receipt identity even after task generation advances.
    }
    const context = await this.objectiveInputContext(objectiveId);
    const prepared = context.input.prepare(context.objective, input);
    const payload = { objectiveId, sessionId: this.binding!.sessionId, text: prepared.text, expectedGeneration: input.expectedGeneration, ...(input.acknowledgeQuestionUnavailable !== undefined ? {acknowledgeQuestionUnavailable:input.acknowledgeQuestionUnavailable} : {}), ...(input.replyToRequestId !== undefined ? { replyToRequestId: input.replyToRequestId } : {}), destination: prepared.destination };
    this.assertRequestAuthorized();
    return this.dispatch(this.store.prepare('objective_input', input.idempotencyKey, payload));
  }
  async controlObjective(objectiveId: string, action: 'pause' | 'resume' | 'cancel', expectedRevision: number, key: string, review: {reviewedUnknownControlKey?:string;acknowledgeUncertainOutcome?:boolean} = {}) {
    this.requireAdapter(); this.assertRequestAuthorized();
    if (!['pause','resume','cancel'].includes(action) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key) || Object.keys(review).some(k=>!['reviewedUnknownControlKey','acknowledgeUncertainOutcome'].includes(k))) throw new ConflictError('Invalid task control');
    if ((review.reviewedUnknownControlKey === undefined) !== (review.acknowledgeUncertainOutcome === undefined) || (review.acknowledgeUncertainOutcome !== undefined && review.acknowledgeUncertainOutcome !== true)) throw new ConflictError('A reviewed unknown outcome requires exact predecessor and acknowledgement');
    const payload = {objectiveId,action,expectedRevision,...review};
    const existing = this.store.commandByKey(key);
    if (existing) return this.dispatch(this.store.prepare('objective_control',key,payload));
    if (review.reviewedUnknownControlKey !== undefined) {
      const binding = await this.verifiedIdentity();
      const scheduler = await this.requireAdapter().getContextScheduler(binding.contextId);
      if (scheduler.context_id !== binding.contextId) throw new ConflictError('Fresh task Context does not match saved binding');
      const objective = scheduler.objectives.find(row=>row.objective.id===objectiveId)?.objective;
      if (!objective) throw new ConflictError('Exact task is absent from the bounded authoritative scheduler');
      this.checkObjective(objective);
      if (objective.id !== objectiveId || objective.coordinator_session_id !== binding.sessionId || objective.delivery_session_id !== binding.sessionId || (objective.initiating_principal_id != null && objective.initiating_principal_id !== binding.principalId) || objective.revision !== expectedRevision) throw new ConflictError('Fresh authoritative task review does not match the displayed owner or revision');
      const actions = objective.status === 'active' ? ['pause','cancel'] : ['paused','blocked'].includes(objective.status) ? ['resume','cancel'] : [];
      if (!actions.includes(action)) throw new ConflictError('The current native task state does not permit that control');
      this.store.setView('objective',objective.id,objective);
    }
    this.assertRequestAuthorized();
    return this.dispatch(this.store.prepare('objective_control', key, payload));
  }
  async decideApproval(approvalId: string, decision: 'allow_once' | 'deny', expectedRevision: number, key: string) {
    this.requireAdapter(); this.assertRequestAuthorized();
    if (!['allow_once','deny'].includes(decision) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new ConflictError('Invalid approval decision');
    return this.dispatch(this.store.prepare('approval', key, { approvalId, decision, expectedRevision }));
  }
  commandLookup(key: string) { this.assertRequestAuthorized(); return this.store.commandLookup(key); }
  messagesPage(input: {before?:string;limit?:number} = {}) { this.assertRequestAuthorized(); return this.store.messagesPage(input); }
  async cancelTurn(rootTurnId: string, expectedRevision: number, key: string) {
    this.requireAdapter(); return this.dispatch(this.store.prepare('turn_cancel', key, { rootTurnId, expectedRevision }));
  }
  async verifiedIdentity(): Promise<UserBinding> {
    await this.initialize();
    const binding = this.binding!;
    const principal = await this.requireAdapter().getPrincipal(binding.sessionId);
    this.assertRequestAuthorized();
    if (principal.principal_id !== binding.principalId || principal.session_id !== binding.sessionId || principal.context_id !== binding.contextId) throw new ConflictError('Runtime authority no longer matches saved identity');
    return { ...binding };
  }
  async voiceContext() {
    const binding = await this.verifiedIdentity();
    return { sessionId: binding.sessionId, principalId: binding.principalId!, events: this.store.events(binding.sessionId) };
  }
  private async artifactFacade() {
    await this.initialize();
    return this.artifacts ??= new Artifacts(this.requireAdapter(), this.binding!.sessionId, () => this.store.events(this.binding!.sessionId));
  }
  async listArtifacts() {
    const artifacts = await this.artifactFacade(); await this.refresh();
    return { artifacts: artifacts.list(), stale: this.status.status !== 'ready', runtimeStatus: this.status.status, maximumDownloadBytes: 32 * 1024 * 1024 };
  }
  async downloadArtifact(id: string) {
    const artifacts = await this.artifactFacade();
    const principal = await this.requireAdapter().getPrincipal(this.binding!.sessionId);
    if (principal.principal_id !== this.binding!.principalId || principal.session_id !== this.binding!.sessionId || principal.context_id !== this.binding!.contextId) throw new ConflictError('Runtime resource authority no longer matches the saved identity');
    return artifacts.download(id);
  }
  private artifactVersionFacade() {
    if (this.closed) throw new RuntimeUnavailableError('Product host is closing');
    this.assertRequestAuthorized();
    const binding = this.store.binding();
    if (!binding?.verified) throw new RuntimeUnavailableError('A verified assistant identity is required for document versions');
    return this.artifactVersions ??= new ArtifactVersions({
      db: this.store.db,
      binding: { ownerId: binding.userId, sessionId: binding.sessionId, verified: true },
      assertAuthorized: () => this.assertRequestAuthorized(),
      resolveArtifact: async id => {
        await this.verifiedIdentity(); await this.refresh();
        if (this.status.status !== 'ready') throw new RuntimeUnavailableError('Fresh Runtime resource verification is required before saving a version');
        const result = await this.downloadArtifact(id); this.assertRequestAuthorized();
        return { sessionId: binding.sessionId, artifact: result.artifact };
      },
      downloadArtifact: async id => ({ ...await this.downloadArtifact(id), sessionId: binding.sessionId }),
    });
  }
  listArtifactDocuments(page: {limit?:number;after?:string} = {}) { return this.artifactVersionFacade().list(page); }
  artifactDocumentHistory(id: string, page: {limit?:number;after?:string} = {}) { return this.artifactVersionFacade().history(id, page); }
  artifactCommandReceipt(key: string) { return { receipt: this.artifactVersionFacade().receiptByKey(key) }; }
  createArtifactDocument(input: CreateArtifactDocumentInput) { return this.artifactVersionFacade().create(input); }
  appendArtifactVersion(id: string, input: AppendArtifactVersionInput) { return this.artifactVersionFacade().append(id, input); }
  downloadArtifactVersion(id: string, version: string) { return this.artifactVersionFacade().downloadVersion(id, version); }
  private authoredDocumentFacade() {
    this.assertRequestAuthorized();
    if (this.closed) throw new RuntimeUnavailableError('Product host is closing');
    const b=this.store.binding();
    if (!b?.verified || !b.principalId) throw new RuntimeUnavailableError('A verified owner is required for authored documents');
    return this.authoredDocuments ??= new AuthoredDocuments({db:this.store.db,binding:{ownerId:b.userId,sessionId:b.sessionId,principalId:b.principalId,agentId:b.agentId,contextId:b.contextId,verified:true},assertAuthorized:()=>this.assertRequestAuthorized()});
  }
  listAuthoredDocuments(page:{afterId?:string;limit?:number}={}) { return this.authoredDocumentFacade().list(page); }
  authoredDocumentHistory(id:string,page:{afterId?:string;limit?:number}={}) { return this.authoredDocumentFacade().history(id,page); }
  downloadAuthoredVersion(id:string,version:string) { return this.authoredDocumentFacade().downloadVersion(id,version); }
  createAuthoredDocumentHost(authority:NativeHostAuthority,authorize:()=>Promise<void>,assertAuthorized:()=>void) {
    const documents=this.authoredDocumentFacade();
    const guard=()=>{
      if(this.closed)throw new RuntimeUnavailableError('Product host is closing');
      const result:unknown=assertAuthorized();
      if(result!==undefined){
        if(result&&typeof(result as {then?:unknown}).then==='function')void Promise.resolve(result).catch(()=>undefined);
        throw new RuntimeUnavailableError('Host policy admission must be synchronous');
      }
    };
    // Install policy only around native receipt/transaction admission. The same
    // document facade remains readable offline through browser owner admission.
    return new AuthoredDocumentHost({documents:{
      receipt:(...args)=>this.requestAuthorization.run(guard,()=>documents.receipt(...args)),
      execute:(...args)=>this.requestAuthorization.run(guard,()=>documents.execute(...args)),
    },authority,authorize:()=>this.requestAuthorization.run(undefined,async()=>{await authorize();await this.verifiedIdentity();if(this.closed)throw new RuntimeUnavailableError('Product host is closing');})});
  }
  async taskDetail(id:string):Promise<TaskDetail> {
    this.assertRequestAuthorized();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new MissingError('Task not found');
    if (this.closed) throw new RuntimeUnavailableError('Product host is closing');
    let operation=this.taskReads.get(id);
    if(!operation){operation=this.readTaskDetail(id).finally(()=>this.taskReads.delete(id));this.taskReads.set(id,operation);}
    const detail=await operation;this.assertRequestAuthorized();return detail;
  }
  private async readTaskDetail(id:string):Promise<TaskDetail> {
    const cached=this.store.views<TaskDetail>('task_detail').find(value=>value.objective.id===id);
    try {
      const b=await this.verifiedIdentity(),adapter=this.requireAdapter();
      await this.refresh();this.assertRequestAuthorized();
      const scheduler=await adapter.getContextScheduler(b.contextId);
      if(scheduler.context_id!==b.contextId||!Array.isArray(scheduler.objectives))throw new ConflictError('Task scheduler does not match fixed Context');
      const objective=scheduler.objectives.find(row=>row.objective.id===id)?.objective;
      if(!objective)throw new MissingError('Exact task is not present in the bounded native scheduler');
      const reasons:string[]=this.historyProjection.incomplete?['typed_history_page_budget']:[];let nativeEvents:Array<Record<string,unknown>>=[];
      try {const page=await adapter.getNativeSessionEvents(b.sessionId);if(!Array.isArray(page.events))throw new Error('Invalid native event page');nativeEvents=page.events;if(page.next_before_sequence!==null&&page.next_before_sequence!==undefined)reasons.push('native_history_window');}
      catch(error){if(error instanceof MorphzError&&[401,403].includes(error.status))throw error;reasons.push('native_history_unavailable');}
      const ioEvents=this.store.events(b.sessionId),artifacts=new Artifacts(adapter,b.sessionId,()=>ioEvents).list();
      let detail=projectTaskDetail({binding:b,objective,scheduler,nativeEvents,ioEvents,artifacts,approvals:this.store.views('approval'),previous:cached,reasons});
      // Focused reads improve bounded scheduler evidence only for already proven
      // exact task Threads. Never enumerate unrelated Context work by inference.
      const snapshots=new Map((scheduler.threads??[]).map(row=>[String((row.thread as any)?.id),row]));
      for(const thread of detail.threads.slice(0,25)){
        try {const result=await adapter.getContextThread(b.contextId,thread.id),snapshot=result.snapshot as Record<string,any>|undefined;if(result.context_id!==b.contextId||snapshot?.thread?.id!==thread.id)throw new ConflictError('Focused task Thread scope changed');snapshots.set(thread.id,snapshot!);}
        catch(error){if(error instanceof ConflictError||(error instanceof MorphzError&&[401,403].includes(error.status)))throw error;reasons.push('focused_thread_unavailable');}
      }
      if(detail.threads.length>25)reasons.push('focused_thread_limit');
      detail=projectTaskDetail({binding:b,objective,scheduler:{...scheduler,threads:[...snapshots.values()]},nativeEvents,ioEvents,artifacts,approvals:this.store.views('approval'),previous:cached,reasons});
      const allJobIds=[...new Set<string>(detail.threads.flatMap(t=>t.activations.flatMap((a:any)=>a.jobs.map((j:any)=>j.id))))],jobIds=allJobIds.slice(0,2000);
      const authored=this.authoredDocumentFacade().forTask({objectiveId:id,jobIds,threadIds:[...new Set<string>(detail.threads.map(t=>t.id))]});
      detail.authoredDocuments={...authored,truncated:authored.truncated||allJobIds.length>2000};
      if(allJobIds.length>2000)detail.bounds={incomplete:true,reasons:[...new Set([...detail.bounds.reasons,'authored_job_lookup_limit'])]};
      this.assertRequestAuthorized();this.store.setView('objective',objective.id,objective);this.store.setView('task_detail',id,detail);return detail;
    } catch(error) {
      this.assertRequestAuthorized();
      if(error instanceof ConflictError||(error instanceof MorphzError&&[401,403].includes(error.status)))throw error;
      if(!cached)throw error;
      return {...cached,freshness:{fresh:false,checkedAt:Date.now(),reason:'runtime_evidence_unavailable'},bounds:{incomplete:true,reasons:[...new Set([...cached.bounds.reasons,'runtime_evidence_unavailable'])]}};
    }
  }
  private async modelFacade() { await this.initialize(); this.assertRequestAuthorized(); return this.models ??= new ModelSettings(this.requireAdapter(), this.binding!.agentId); }
  listNotifications(limit=100,after?:string) { if(!this.notifications)throw new RuntimeUnavailableError('No assistant identity is configured for notifications');return this.notifications.snapshot(limit,after); }
  acknowledgeNotifications(ids:string[]) { if(!this.notifications)throw new RuntimeUnavailableError('No assistant identity is configured for notifications');return this.notifications.acknowledge(ids); }
  setNotificationMode(mode:'all'|'off') { if(!this.notifications)throw new RuntimeUnavailableError('No assistant identity is configured for notifications');return this.notifications.setMode(mode); }
  private async memoryFacade() { await this.initialize(); return this.memories ??= new MemoryView(this.requireAdapter(),this.binding!.contextId,this.binding!.sessionId); }
  async searchMemory(query: string, cursor?: string) { return (await this.memoryFacade()).search(query,cursor); }
  async readMemory(frameId: string) { return (await this.memoryFacade()).read(frameId); }
  private async reminderFacade() { await this.initialize(); this.assertRequestAuthorized(); return this.reminders ??= new Reminders(this.dbPath, this.requireAdapter(), this.binding!.sessionId); }
  async listReminders() { return (await this.reminderFacade()).refresh(); }
  async createReminder(input: ReminderInput) { return (await this.reminderFacade()).create(input); }
  async controlReminder(id: string, action: 'pause' | 'resume' | 'cancel', expectedRevision: number) { return (await this.reminderFacade()).control(id, action, expectedRevision); }
  private async calendarFacade() {
    if(this.closed)throw new CalendarReminderError('calendar_closed');
    const binding = await this.verifiedIdentity(); this.assertRequestAuthorized();
    if(this.closed)throw new CalendarReminderError('calendar_closed');
    return this.calendar ??= new CalendarReminders({ db:this.store.db,adapter:this.requireAdapter(),binding:{ownerId:binding.userId,sessionId:binding.sessionId},now:this.calendarNow,authorize:async()=>{
      if(this.closed)throw new CalendarReminderError('calendar_closed');
      const current=await this.verifiedIdentity(),saved=this.store.binding();
      if(!saved?.verified||saved.userId!==binding.userId||saved.sessionId!==binding.sessionId||current.userId!==binding.userId||current.sessionId!==binding.sessionId||current.contextId!==binding.contextId||current.agentId!==binding.agentId||current.principalId!==binding.principalId)throw new CalendarReminderError('calendar_binding_changed');
    }});
  }
  previewCalendarReminder(rule:unknown,count=3) {
    this.assertRequestAuthorized();
    const preview=previewCalendar(rule,this.calendarNow(),count);
    const previewFingerprint=createHash('sha256').update(JSON.stringify([preview.rule,preview.calculationVersion,preview.occurrences[0]?.instant??null])).digest('hex');
    return {...preview,previewFingerprint};
  }
  async listCalendarReminders(input:{limit?:number;afterId?:string}={}) {return (await this.calendarFacade()).list(input);}
  async calendarReminderHistory(id:string) {return {occurrences:await (await this.calendarFacade()).history(id)};}
  async createCalendarReminder(input:{rule:unknown;idempotencyKey:string;confirmed:true;previewFingerprint?:string}) {
    return this.admitCalendarRule(input);
  }
  private async admitCalendarRule(input:{rule:unknown;idempotencyKey:string;confirmed:true;previewFingerprint?:string},proposalGuard?:()=>void) {
    if(input.confirmed!==true)throw new CalendarReminderError('calendar_confirmation_required');
    const rule=validateCalendarRule(input.rule),admissionGuard=this.requestAuthorization.getStore()??(()=>{});
    const calendar=await this.calendarFacade();
    const guard=({existing}:{existing:boolean})=>{admissionGuard();if(!existing){const preview=this.previewCalendarReminder(rule,1);if(!preview.occurrences.length)throw new CalendarReminderError('calendar_no_future_occurrence');if(input.previewFingerprint!==preview.previewFingerprint)throw new CalendarReminderError('calendar_preview_changed');}proposalGuard?.();};
    // Browser authority is explicit at the synchronous transaction boundary;
    // accepted recurrence intent then runs under fixed native owner authority.
    return this.requestAuthorization.run(undefined,()=>calendar.create({...rule,idempotencyKey:input.idempotencyKey},guard));
  }
  private proposalStore(){const b=this.store.binding();if(!b?.verified)throw new CalendarProposalError('calendar_proposal_binding_required',503);return this.calendarProposals??=new CalendarProposals({db:this.store.db,ownerId:b.userId,sessionId:b.sessionId,now:this.calendarNow});}
  private async proposalFacade(){await this.verifiedIdentity();this.assertRequestAuthorized();if(this.closed)throw new CalendarProposalError('calendar_proposal_closed',503);return this.proposalStore();}
  calendarProposalCount(){if(!this.binding||!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calendar_proposals'").get())return 0;return this.proposalStore().countPending();}
  createCalendarProposalHost(authority:NativeHostAuthority,authorize:()=>Promise<void>){const proposals=this.proposalStore();return new CalendarProposalHost({authority,proposals,now:this.calendarNow,authorize:()=>this.requestAuthorization.run(undefined,async()=>{await authorize();await this.verifiedIdentity();if(this.closed)throw new CalendarProposalError('calendar_proposal_closed',503);}),listSeries:input=>this.requestAuthorization.run(undefined,()=>this.listCalendarReminders(input)),seriesForProposal:id=>this.requestAuthorization.run(undefined,async()=>{const c=proposals.confirmation(id);return(await this.calendarFacade()).findByCreateKey(c.seriesKey);})});}
  async listCalendarProposals(input:{afterId?:string;limit?:number}={}){const store=await this.proposalFacade();return{...store.list(input),pendingCount:store.countPending()};}
  async calendarProposalStatus(id:string){const store=await this.proposalFacade(),c=store.confirmation(id);return{proposal:c.proposal,series:c.proposal.state==='admitted'?await(await this.calendarFacade()).findByCreateKey(c.seriesKey):null};}
  async previewCalendarProposal(id:string,expectedRevision:number){const store=await this.proposalFacade(),p=store.read(id);if(p.state!=='pending_owner_confirmation'||p.revision!==expectedRevision)throw new CalendarProposalError('calendar_proposal_revision_conflict');return{proposalId:p.proposalId,proposalRevision:p.revision,ruleFingerprint:p.ruleFingerprint,...this.previewCalendarReminder(p.rule)};}
  async confirmCalendarProposal(id:string,input:{expectedRevision:number;ruleFingerprint:string;previewFingerprint?:string;confirmed:true}){
    if(input.confirmed!==true)throw new CalendarProposalError('calendar_confirmation_required',400);
    const store=await this.proposalFacade(),c=store.confirmation(id);
    if(c.proposal.ruleFingerprint!==input.ruleFingerprint)throw new CalendarProposalError('calendar_proposal_revision_conflict');
    const guard=()=>{const current=store.read(id);if(current.state==='pending_owner_confirmation'){const fresh=this.previewCalendarReminder(current.rule,1);if(!fresh.occurrences.length||fresh.previewFingerprint!==input.previewFingerprint)throw new CalendarReminderError('calendar_preview_changed');}store.confirmInsideAdmission(id,input.expectedRevision,input.ruleFingerprint);};
    const series=await this.admitCalendarRule({rule:c.proposal.rule,idempotencyKey:c.seriesKey,confirmed:true,previewFingerprint:input.previewFingerprint},guard);
    return{proposal:store.read(id),series};
  }
  async dismissCalendarProposal(id:string,expectedRevision:number){const admissionGuard=this.requestAuthorization.getStore()??(()=>{}),store=await this.proposalFacade();return{proposal:store.dismiss(id,expectedRevision,admissionGuard)};}
  async controlCalendarReminder(id:string,input:CalendarControlInput&{confirmed:true}) {
    if(input.confirmed!==true)throw new CalendarReminderError('calendar_confirmation_required');
    const admissionGuard=this.requestAuthorization.getStore()??(()=>{}),calendar=await this.calendarFacade();
    const {confirmed:_,...command}=input;
    return this.requestAuthorization.run(undefined,()=>calendar.control(id,command,admissionGuard));
  }
  async reconcileCalendarReminders() {
    if(this.closed)throw new CalendarReminderError('calendar_closed');
    this.assertRequestAuthorized();
    if(this.calendarReconciling)return this.calendarReconciling;
    this.calendarLastAttempt=Date.now();this.calendarStatus={...this.calendarStatus,status:'running'};
    const task=this.requestAuthorization.run(undefined,async()=>{const result=await(await this.calendarFacade()).reconcile({limit:50});this.calendarStatus={status:'idle',lastReconciledAt:Date.now()};return result;});
    this.calendarReconciling=task.catch(error=>{this.calendarStatus={...this.calendarStatus,status:'unavailable'};throw error;}).finally(()=>{this.calendarReconciling=undefined;});
    return this.calendarReconciling;
  }
  private reconcileCalendarLifecycle() {
    if(this.closed||this.calendarReconciling||Date.now()-this.calendarLastAttempt<30_000||!this.binding)return;
    const exists=this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calendar_series'").get();
    if(!exists||!this.store.db.prepare('SELECT 1 FROM calendar_series WHERE owner_id=? AND session_id=? LIMIT 1').get(this.binding.userId,this.binding.sessionId))return;
    void this.requestAuthorization.run(undefined,()=>this.reconcileCalendarReminders()).catch(()=>undefined);
  }
  async modelSettings() { return (await this.modelFacade()).read(); }
  async selectModel(input: { model: string; expectedCurrent: string; reasoningEffort?: string }) { return (await this.modelFacade()).select(input); }
  async bindProvider(input: { accountId: string }) { return (await this.modelFacade()).bind(input); }
  async connectProvider(input: unknown) { return (await this.modelFacade()).connect(input); }
  snapshot() { return { mode: 'runtime', disclaimer: 'Actual Morphz transport. Runtime admission is not task completion.', runtime: { ...this.status }, ...this.store.snapshot(), drafts: this.drafts?.snapshot() ?? [], stream: { status: this.streamStatus, transport: this.streamTransport, reconnectBehavior: this.streamTransport === 'application_ws' ? 'discard_unfinished_until_fresh_start_or_durable_output' : 'replace_from_snapshot' }, objectiveProjection: { ...this.objectiveProjection }, historyProjection: {...this.historyProjection}, calendar:{...this.calendarStatus}, notifications:this.notifications?.snapshot()??null }; }
  async close() {
    this.closed = true; if (this.timer) clearInterval(this.timer); this.streamAbort?.abort();
    const calendarClosed=this.calendar?.close();
    const artifactVersionsClosed=this.artifactVersions?.close();
    await this.syncing; await this.initializing; await Promise.allSettled([...this.inFlight.values()]); await this.streamPromise; await Promise.allSettled([...this.taskReads.values()]); this.authoredDocuments?.close(); await this.calendarReconciling?.catch(()=>undefined); await calendarClosed; await artifactVersionsClosed; this.reminders?.close(); this.notifications?.close(); this.uploads?.close(); this.store.close();
  }
}
function safeFailure(error: unknown): string {
  if (error instanceof ConflictError) return error.message;
  if (error instanceof MorphzError && [401, 403].includes(error.status)) return 'Morphz authentication was rejected. Check the local operator token; no gateway privilege elevation is attempted.';
  if (error instanceof MorphzError) return `Morphz returned HTTP ${error.status}. Saved state is retained; inspect Runtime configuration and retry.`;
  return 'Cannot confirm the Morphz connection. Check that the local Runtime is running with Session IO enabled. Saved state is retained.';
}
