import { z } from 'zod/v4';

// --- Project schema ---

export const projectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  description: z.string().default(''),
  status: z.enum(['created', 'active', 'paused', 'completed', 'cancelled']),
  currentPhase: z.enum(['analysis', 'design', 'implementation', 'testing', 'acceptance']).nullable().default(null),
  phases: z.array(z.string()).default([]),
  config: z.object({
    requiresUI: z.boolean().default(false),
    maxRetryOnFailure: z.number().int().default(3),
  }).default({ requiresUI: false, maxRetryOnFailure: 3 }),
  createdAt: z.string(),
  updatedAt: z.string(),
  pausedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});

export type Project = z.infer<typeof projectSchema>;
