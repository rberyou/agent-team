import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';
import {
  eventSchema,
  EventType,
  taskSchema,
  TaskStatus,
  phaseSchema,
  PhaseName,
  PhaseStatus,
  projectSchema,
  ProjectStatus,
  AgentRole,
  EventSource,
} from '../../../src/core/models/index.js';

describe('Event model', () => {
  it('should validate a well-formed event', () => {
    const event = {
      id: `evt_${uuid()}`,
      type: EventType.TaskCreated,
      timestamp: new Date().toISOString(),
      source: EventSource.AgentPM,
      projectId: 'proj_001',
      phase: PhaseName.Analysis,
      version: 1,
      payload: { taskId: 'task_001', title: 'Test task' },
      metadata: {},
    };

    const result = eventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it('should reject an event with invalid type', () => {
    const event = {
      id: 'evt_001',
      type: 'invalid.type',
      timestamp: new Date().toISOString(),
      source: 'user',
      projectId: 'proj_001',
    };

    const result = eventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('should apply defaults for optional fields', () => {
    const event = {
      id: 'evt_001',
      type: EventType.ProjectCreated,
      timestamp: new Date().toISOString(),
      source: EventSource.User,
      projectId: 'proj_001',
    };

    const result = eventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(1);
      expect(result.data.payload).toEqual({});
      expect(result.data.metadata).toEqual({});
    }
  });
});

describe('Task model', () => {
  const validTask = {
    taskId: 'task_001',
    projectId: 'proj_001',
    phase: PhaseName.Analysis,
    title: '需求分析',
    assignedTo: AgentRole.ProductDesigner,
    status: TaskStatus.Pending,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('should validate a minimal task', () => {
    const result = taskSchema.safeParse(validTask);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependencies).toEqual([]);
      expect(result.data.priority).toBe('medium');
      expect(result.data.reviewStatus).toBe('none');
    }
  });

  it('should reject task with invalid status', () => {
    const result = taskSchema.safeParse({ ...validTask, status: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('should accept full task with all fields', () => {
    const fullTask = {
      ...validTask,
      description: '分析用户需求，编写PRD',
      status: TaskStatus.InProgress,
      priority: 'high',
      dependencies: ['task_000'],
      startedAt: new Date().toISOString(),
      history: [
        {
          from: 'pending',
          to: 'in_progress',
          timestamp: new Date().toISOString(),
          triggerEvent: 'evt_002',
          reason: 'PM assigned',
        },
      ],
    };

    const result = taskSchema.safeParse(fullTask);
    expect(result.success).toBe(true);
  });
});

describe('Phase model', () => {
  it('should validate a phase', () => {
    const phase = {
      phaseId: 'phase_analysis',
      projectId: 'proj_001',
      name: PhaseName.Analysis,
      status: PhaseStatus.Pending,
    };

    const result = phaseSchema.safeParse(phase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks).toEqual([]);
      expect(result.data.artifacts).toEqual([]);
    }
  });

  it('should reject invalid phase name', () => {
    const result = phaseSchema.safeParse({
      phaseId: 'phase_x',
      projectId: 'proj_001',
      name: 'invalid_phase',
      status: PhaseStatus.Pending,
    });
    expect(result.success).toBe(false);
  });
});

describe('Project model', () => {
  it('should validate a project', () => {
    const project = {
      projectId: 'proj_001',
      name: 'Test Project',
      status: ProjectStatus.Created,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = projectSchema.safeParse(project);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.currentPhase).toBeNull();
      expect(result.data.config.requiresUI).toBe(false);
      expect(result.data.config.maxRetryOnFailure).toBe(3);
    }
  });

  it('should accept project with custom config', () => {
    const project = {
      projectId: 'proj_002',
      name: 'UI Project',
      status: ProjectStatus.Active,
      currentPhase: PhaseName.Design,
      config: { requiresUI: true, maxRetryOnFailure: 5 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = projectSchema.safeParse(project);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.config.requiresUI).toBe(true);
      expect(result.data.config.maxRetryOnFailure).toBe(5);
    }
  });
});

describe('Enum constants', () => {
  it('AgentRole should have all 7 roles', () => {
    expect(Object.keys(AgentRole)).toHaveLength(7);
  });

  it('PhaseName should have 5 phases', () => {
    expect(Object.keys(PhaseName)).toHaveLength(5);
  });

  it('EventType should have all event types', () => {
    const count = Object.keys(EventType).length;
    expect(count).toBeGreaterThanOrEqual(30);
  });
});
