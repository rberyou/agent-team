import { z } from 'zod/v4';

// --- Task schema ---

const taskHistoryEntrySchema = z.object({
  from: z.string(),
  to: z.string(),
  timestamp: z.string(),
  triggerEvent: z.string().optional(),
  reason: z.string().optional(),
});

export type TaskHistoryEntry = z.infer<typeof taskHistoryEntrySchema>;

export const taskSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  phase: z.string(),
  title: z.string(),
  description: z.string().default(''),
  assignedTo: z.string(),
  status: z.enum(['pending', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled']),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),

  dependencies: z.array(z.string()).default([]),
  blockedBy: z.array(z.string()).default([]),
  parentTask: z.string().nullable().default(null),
  subTasks: z.array(z.string()).default([]),

  reviewStatus: z.enum(['none', 'pending', 'approved', 'rejected']).default('none'),
  reviewRounds: z.number().int().default(0),
  testStatus: z.enum(['none', 'pending', 'passed', 'failed']).default('none'),

  artifacts: z.array(z.string()).default([]),

  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  updatedAt: z.string(),

  history: z.array(taskHistoryEntrySchema).default([]),
  changeRequestIds: z.array(z.string()).default([]),
});

export type Task = z.infer<typeof taskSchema>;
