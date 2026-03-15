// Agent role identifiers
export const AgentRole = {
  PM: 'pm',
  ProductDesigner: 'product_designer',
  UIDesigner: 'ui_designer',
  Developer: 'developer',
  CodeReviewer: 'code_reviewer',
  DevOps: 'devops',
  QA: 'qa',
} as const;

export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

// Event source: either an agent or the user/system
export const EventSource = {
  User: 'user',
  System: 'system',
  AgentPM: 'agent:pm',
  AgentProductDesigner: 'agent:product_designer',
  AgentUIDesigner: 'agent:ui_designer',
  AgentDeveloper: 'agent:developer',
  AgentCodeReviewer: 'agent:code_reviewer',
  AgentDevOps: 'agent:devops',
  AgentQA: 'agent:qa',
} as const;

export type EventSource = (typeof EventSource)[keyof typeof EventSource];

// Task statuses
export const TaskStatus = {
  Pending: 'pending',
  InProgress: 'in_progress',
  InReview: 'in_review',
  Done: 'done',
  Blocked: 'blocked',
  Cancelled: 'cancelled',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

// Phase names
export const PhaseName = {
  Analysis: 'analysis',
  Design: 'design',
  Implementation: 'implementation',
  Testing: 'testing',
  Acceptance: 'acceptance',
} as const;

export type PhaseName = (typeof PhaseName)[keyof typeof PhaseName];

// Phase statuses
export const PhaseStatus = {
  Pending: 'pending',
  Active: 'active',
  Completed: 'completed',
  RolledBack: 'rolled_back',
} as const;

export type PhaseStatus = (typeof PhaseStatus)[keyof typeof PhaseStatus];

// Project statuses
export const ProjectStatus = {
  Created: 'created',
  Active: 'active',
  Paused: 'paused',
  Completed: 'completed',
  Cancelled: 'cancelled',
} as const;

export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

// Task priority
export const TaskPriority = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  Critical: 'critical',
} as const;

export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];
