import { z } from 'zod/v4';

// --- Phase schema ---

export const phaseSchema = z.object({
  phaseId: z.string(),
  projectId: z.string(),
  name: z.enum(['analysis', 'design', 'implementation', 'testing', 'acceptance']),
  status: z.enum(['pending', 'active', 'completed', 'rolled_back']),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  tasks: z.array(z.string()).default([]),
  entryCriteria: z.array(z.string()).default([]),
  exitCriteria: z.array(z.string()).default([]),
  artifacts: z.array(z.string()).default([]),
});

export type Phase = z.infer<typeof phaseSchema>;
