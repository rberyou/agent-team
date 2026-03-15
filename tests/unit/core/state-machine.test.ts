import { describe, it, expect } from 'vitest';
import {
  canTaskTransition,
  canPhaseTransition,
  getValidTaskTransitions,
  getValidPhaseTransitions,
} from '../../../src/core/state-machine/index.js';
import { TaskStatus, PhaseStatus } from '../../../src/core/models/index.js';

describe('Task state machine', () => {
  // --- Valid transitions ---
  it('pending → in_progress', () => {
    const r = canTaskTransition(TaskStatus.Pending, TaskStatus.InProgress);
    expect(r.valid).toBe(true);
  });

  it('pending → blocked', () => {
    const r = canTaskTransition(TaskStatus.Pending, TaskStatus.Blocked);
    expect(r.valid).toBe(true);
  });

  it('in_progress → in_review', () => {
    const r = canTaskTransition(TaskStatus.InProgress, TaskStatus.InReview);
    expect(r.valid).toBe(true);
  });

  it('in_progress → done (no review needed)', () => {
    const r = canTaskTransition(TaskStatus.InProgress, TaskStatus.Done);
    expect(r.valid).toBe(true);
  });

  it('in_review → done (review approved)', () => {
    const r = canTaskTransition(TaskStatus.InReview, TaskStatus.Done);
    expect(r.valid).toBe(true);
  });

  it('in_review → in_progress (review rejected, rework)', () => {
    const r = canTaskTransition(TaskStatus.InReview, TaskStatus.InProgress);
    expect(r.valid).toBe(true);
  });

  it('blocked → pending (unblocked)', () => {
    const r = canTaskTransition(TaskStatus.Blocked, TaskStatus.Pending);
    expect(r.valid).toBe(true);
  });

  it('any non-terminal → cancelled', () => {
    for (const status of [TaskStatus.Pending, TaskStatus.InProgress, TaskStatus.InReview, TaskStatus.Blocked]) {
      const r = canTaskTransition(status, TaskStatus.Cancelled);
      expect(r.valid).toBe(true);
    }
  });

  // --- Invalid transitions ---
  it('done → anything is invalid', () => {
    for (const target of [TaskStatus.Pending, TaskStatus.InProgress, TaskStatus.Cancelled]) {
      const r = canTaskTransition(TaskStatus.Done, target);
      expect(r.valid).toBe(false);
      expect(r.reason).toBeDefined();
    }
  });

  it('cancelled → anything is invalid', () => {
    const r = canTaskTransition(TaskStatus.Cancelled, TaskStatus.Pending);
    expect(r.valid).toBe(false);
  });

  it('pending → done is invalid (must go through in_progress)', () => {
    const r = canTaskTransition(TaskStatus.Pending, TaskStatus.Done);
    expect(r.valid).toBe(false);
  });

  it('unknown status returns invalid', () => {
    const r = canTaskTransition('unknown', TaskStatus.Pending);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('Unknown');
  });

  // --- Helper ---
  it('getValidTaskTransitions returns correct list', () => {
    const transitions = getValidTaskTransitions(TaskStatus.InProgress);
    expect(transitions).toContain(TaskStatus.InReview);
    expect(transitions).toContain(TaskStatus.Done);
    expect(transitions).toContain(TaskStatus.Blocked);
    expect(transitions).toContain(TaskStatus.Cancelled);
    expect(transitions).not.toContain(TaskStatus.Pending);
  });

  it('getValidTaskTransitions returns empty for terminal states', () => {
    expect(getValidTaskTransitions(TaskStatus.Done)).toEqual([]);
    expect(getValidTaskTransitions(TaskStatus.Cancelled)).toEqual([]);
  });
});

describe('Phase state machine', () => {
  // --- Valid transitions ---
  it('pending → active', () => {
    const r = canPhaseTransition(PhaseStatus.Pending, PhaseStatus.Active);
    expect(r.valid).toBe(true);
  });

  it('active → completed', () => {
    const r = canPhaseTransition(PhaseStatus.Active, PhaseStatus.Completed);
    expect(r.valid).toBe(true);
  });

  it('active → rolled_back', () => {
    const r = canPhaseTransition(PhaseStatus.Active, PhaseStatus.RolledBack);
    expect(r.valid).toBe(true);
  });

  it('completed → rolled_back (change request)', () => {
    const r = canPhaseTransition(PhaseStatus.Completed, PhaseStatus.RolledBack);
    expect(r.valid).toBe(true);
  });

  it('rolled_back → active (re-enter)', () => {
    const r = canPhaseTransition(PhaseStatus.RolledBack, PhaseStatus.Active);
    expect(r.valid).toBe(true);
  });

  // --- Invalid transitions ---
  it('pending → completed is invalid (must be active first)', () => {
    const r = canPhaseTransition(PhaseStatus.Pending, PhaseStatus.Completed);
    expect(r.valid).toBe(false);
  });

  it('completed → active is invalid', () => {
    const r = canPhaseTransition(PhaseStatus.Completed, PhaseStatus.Active);
    expect(r.valid).toBe(false);
  });

  it('unknown status returns invalid', () => {
    const r = canPhaseTransition('unknown', PhaseStatus.Active);
    expect(r.valid).toBe(false);
  });

  // --- Helper ---
  it('getValidPhaseTransitions returns correct list', () => {
    expect(getValidPhaseTransitions(PhaseStatus.Active)).toEqual([
      PhaseStatus.Completed,
      PhaseStatus.RolledBack,
    ]);
  });
});
