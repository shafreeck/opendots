import type { RuntimeObjective } from './morphz-adapter.ts';

export class ObjectiveInputError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export interface ObjectiveInputBinding { agentId: string; contextId: string; sessionId: string; principalId: string }
export interface ObjectiveInputRequest { text: string; idempotencyKey: string; expectedGeneration: number; replyToRequestId?: string }
export interface ObjectiveInputDestination { kind: 'objective'; objective_id: string; generation: number; reply_to_request_id?: string }
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;

/** Directed supplemental human input only. This does not amend goal criteria,
 * grant permissions, resume a paused Objective, cancel physical actions, create
 * follow-up work or choose the latest active Thread heuristically.
 */
export class ObjectiveInput {
  private binding: ObjectiveInputBinding;
  constructor(binding: ObjectiveInputBinding) { this.binding = { ...binding }; }
  target(objective: RuntimeObjective) {
    const binding = this.binding;
    if (!binding.principalId || !objective || !identifier(objective.id) || objective.agent_id !== binding.agentId || objective.context_id !== binding.contextId || objective.coordinator_session_id !== binding.sessionId
      || (objective.initiating_principal_id !== undefined && objective.initiating_principal_id !== null && objective.initiating_principal_id !== binding.principalId)) throw new ObjectiveInputError(403, 'objective_scope_conflict', 'The Objective input route is outside the saved Principal/Session/Context');
    if (!positive(objective.generation) || !Number.isSafeInteger(objective.revision) || objective.revision < 0) throw new ObjectiveInputError(502, 'objective_counter_invalid', 'Objective generation or revision is unavailable');
    const available = objective.status === 'active';
    const reason = available ? null : objective.status === 'paused' || objective.status === 'blocked' ? 'resume_required' : ['completed','cancelled','failed'].includes(objective.status) ? 'objective_terminal' : 'objective_state_unconfirmed';
    const wait = object(objective.wait_condition);
    let replyRequestId: string | null = null;
    if (available && wait?.kind === 'user_input' && wait.session_id === binding.sessionId) {
      // Exact pinned Runtime steering::input_request_id compatibility formula.
      if (wait.request_id === undefined || wait.request_id === null) replyRequestId = `legacy:${objective.id}:${objective.generation}:${objective.revision}`;
      else if (typeof wait.request_id === 'string' && wait.request_id.length > 0 && wait.request_id.length <= 512) replyRequestId = wait.request_id;
    }
    // The pinned wait DTO has no exact question text. A lifecycle rationale or
    // latest chat reply is not proof of the content that this request ID names.
    return { objectiveId: objective.id, generation: objective.generation, revision: objective.revision, status: objective.status, available, reason, replyRequestId, replyAvailable: false, questionText: null, replyReason: replyRequestId ? 'question_text_unavailable' : 'no_current_question' };
  }
  prepare(objective: RuntimeObjective, input: ObjectiveInputRequest) {
    if (!object(input) || Object.keys(input).some(key => !['text','idempotencyKey','expectedGeneration','replyToRequestId'].includes(key)) || typeof input.text !== 'string' || !input.text.trim() || input.text.trim().length > 4000 || typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey) || !positive(input.expectedGeneration)) throw new ObjectiveInputError(400, 'invalid_objective_input', 'Text, stable command key and the displayed Objective generation are required');
    const target = this.target(objective);
    if (!target.available) throw new ObjectiveInputError(409, target.reason!, 'The Objective is not active. No supplemental input was sent; keep the draft and explicitly review its state.');
    if (target.generation !== input.expectedGeneration) throw new ObjectiveInputError(409, 'objective_generation_changed', 'The Objective execution generation changed. Refresh the target without silently retargeting this draft.');
    if (input.replyToRequestId !== undefined && (typeof input.replyToRequestId !== 'string' || input.replyToRequestId.length < 1 || input.replyToRequestId.length > 512)) throw new ObjectiveInputError(400, 'invalid_question_identity', 'Use the exact displayed question identity');
    if (input.replyToRequestId !== undefined && target.replyRequestId !== input.replyToRequestId) throw new ObjectiveInputError(409, 'objective_question_changed', 'This exact question is no longer waiting for a reply in the current Session');
    if (input.replyToRequestId !== undefined && !target.replyAvailable) throw new ObjectiveInputError(409, 'objective_question_text_unavailable', 'The exact question content is unavailable. Supplemental input remains separate and does not confirm this question.');
    const destination: ObjectiveInputDestination = { kind: 'objective', objective_id: objective.id, generation: input.expectedGeneration, ...(input.replyToRequestId !== undefined ? { reply_to_request_id: input.replyToRequestId } : {}) };
    return { text: input.text.trim(), idempotencyKey: input.idempotencyKey, destination };
  }
}
