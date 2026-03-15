import { TaskStatus, PhaseStatus } from '../models/index.js';

// --- Valid state transitions ---

const validTaskTransitions: Record<string, string[]> = {
  [TaskStatus.Pending]: [TaskStatus.InProgress, TaskStatus.Blocked, TaskStatus.Cancelled],
  [TaskStatus.InProgress]: [TaskStatus.InReview, TaskStatus.Done, TaskStatus.Blocked, TaskStatus.Cancelled],
  [TaskStatus.InReview]: [TaskStatus.Done, TaskStatus.InProgress, TaskStatus.Cancelled],
  [TaskStatus.Blocked]: [TaskStatus.Pending, TaskStatus.InProgress, TaskStatus.Cancelled],
  [TaskStatus.Done]: [],
  [TaskStatus.Cancelled]: [],
};

const validPhaseTransitions: Record<string, string[]> = {
  [PhaseStatus.Pending]: [PhaseStatus.Active],
  [PhaseStatus.Active]: [PhaseStatus.Completed, PhaseStatus.RolledBack],
  [PhaseStatus.Completed]: [PhaseStatus.RolledBack],
  [PhaseStatus.RolledBack]: [PhaseStatus.Active],
};

// --- Transition validation ---

export interface TransitionResult {
  valid: boolean;
  from: string;
  to: string;
  reason?: string;
}

export function canTaskTransition(from: string, to: string): TransitionResult {
  const allowed = validTaskTransitions[from];
  if (!allowed) {
    return { valid: false, from, to, reason: `Unknown task status: ${from}` };
  }
  if (!allowed.includes(to)) {
    return {
      valid: false,
      from,
      to,
      reason: `Task cannot transition from '${from}' to '${to}'. Allowed: [${allowed.join(', ')}]`,
    };
  }
  return { valid: true, from, to };
}

export function canPhaseTransition(from: string, to: string): TransitionResult {
  const allowed = validPhaseTransitions[from];
  if (!allowed) {
    return { valid: false, from, to, reason: `Unknown phase status: ${from}` };
  }
  if (!allowed.includes(to)) {
    return {
      valid: false,
      from,
      to,
      reason: `Phase cannot transition from '${from}' to '${to}'. Allowed: [${allowed.join(', ')}]`,
    };
  }
  return { valid: true, from, to };
}

export function getValidTaskTransitions(from: string): string[] {
  return validTaskTransitions[from] ?? [];
}

export function getValidPhaseTransitions(from: string): string[] {
  return validPhaseTransitions[from] ?? [];
}
