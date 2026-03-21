import { z } from 'zod/v4';

// --- MVP event types (analysis phase flow) ---

export const EventType = {
  // User events
  UserRequirementSubmitted: 'user.requirement_submitted',
  UserConfirmed: 'user.confirmed',
  UserRejected: 'user.rejected',
  UserChangeRequested: 'user.change_requested',
  UserPauseRequested: 'user.pause_requested',
  UserResumeRequested: 'user.resume_requested',
  UserConfirmationNeeded: 'user.confirmation_needed',

  // Project events
  ProjectCreated: 'project.created',
  ProjectStatusChanged: 'project.status_changed',

  // Phase events
  PhaseEntered: 'phase.entered',
  PhaseCompleted: 'phase.completed',
  PhaseRollback: 'phase.rollback',

  // Task events
  TaskCreated: 'task.created',
  TaskAssigned: 'task.assigned',
  TaskStarted: 'task.started',
  TaskCompleted: 'task.completed',
  TaskFailed: 'task.failed',
  TaskBlocked: 'task.blocked',
  TaskUnblocked: 'task.unblocked',
  TaskCancelled: 'task.cancelled',

  // Artifact events
  ArtifactProduced: 'artifact.produced',
  ArtifactApproved: 'artifact.approved',
  ArtifactRejected: 'artifact.rejected',

  // Review events
  ReviewCompleted: 'review.completed',

  // Test events
  TestCompleted: 'test.completed',
  TestBugReported: 'test.bug_reported',

  // Environment events
  EnvironmentReady: 'environment.ready',
  DeploymentCompleted: 'deployment.completed',
  DeploymentFailed: 'deployment.failed',

  // Agent progress events
  AgentWorking: 'agent.working',
  AgentThinking: 'agent.thinking',
  AgentToolUsed: 'agent.tool_used',
  AgentCompleted: 'agent.completed',

  // Change events
  ChangeAnalyzed: 'change.analyzed',
  ChangeApproved: 'change.approved',
  ChangeApplied: 'change.applied',

  // Product Designer Discovery events
  ProductDesignerQuestions: 'product.designer.questions',
  ProductDesignerAnswersReceived: 'product.designer.answers_received',
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

// All valid event type values for Zod validation
const eventTypeValues = Object.values(EventType) as [string, ...string[]];

// --- Event envelope schema ---

export const eventSchema = z.object({
  id: z.string(),
  type: z.enum(eventTypeValues),
  timestamp: z.string(),
  source: z.string(),
  projectId: z.string(),
  phase: z.string().optional(),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
  version: z.number().int().default(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type Event = z.infer<typeof eventSchema>;
