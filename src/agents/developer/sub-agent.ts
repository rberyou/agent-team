import { z } from 'zod/v4';
import { BaseAgent } from '../base-agent.js';
import { EventBus } from '../../core/event-bus/index.js';
import { TaskService } from '../../services/task-service.js';
import { ArtifactStore } from '../../core/persistence/index.js';
import { LLMService } from '../../core/llm/index.js';
import {
  EventType,
  TaskStatus,
} from '../../core/models/index.js';
import type { Event } from '../../core/models/index.js';

// Zod schema for code artifact validation
export const codeArtifactSchema = z.object({
  moduleName: z.string(),
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    language: z.string(),
  })),
  unitTests: z.array(z.object({
    path: z.string(),
    content: z.string(),
  })).default([]),
  dependencies: z.array(z.string()).default([]),
});

export type CodeArtifact = z.infer<typeof codeArtifactSchema>;

/**
 * SubAgent — an independent coding agent for a single module.
 *
 * Created dynamically by DeveloperAgent for each component in the design.
 * Each SubAgent:
 * - Listens for tasks assigned to its unique ID
 * - Generates code via LLM (with fallback)
 * - Handles rework when review is rejected
 */
export class SubAgent extends BaseAgent {
  private currentTaskId: string | null = null;

  constructor(
    readonly subAgentId: string,
    private readonly moduleName: string,
    private readonly moduleSpec: Record<string, unknown>,
    eventBus: EventBus,
    private readonly taskService: TaskService,
    private readonly artifactStore: ArtifactStore,
    private readonly llmService: LLMService,
    private readonly projectId: string,
  ) {
    super(subAgentId, eventBus);
  }

  start(): void {
    this.on(EventType.ReviewCompleted, (e) => this.handleReviewCompleted(e));
    this.logger.info({ moduleName: this.moduleName }, 'SubAgent started');
  }

  /**
   * Begin working on the assigned task directly.
   * Called by DeveloperAgent after all tasks (subtask + review) are created,
   * so that the full event chain doesn't fire before setup is complete.
   */
  async beginWork(taskId: string): Promise<void> {
    this.currentTaskId = taskId;
    this.logger.info({ taskId, moduleName: this.moduleName }, 'Received coding task');

    await this.taskService.transitionTask(
      this.projectId,
      taskId,
      TaskStatus.InProgress,
      'SubAgent started coding',
    );

    await this.generateAndSubmitCode(this.projectId, taskId, '');
  }

  private async handleReviewCompleted(event: Event): Promise<void> {
    const { result, subTaskId } = event.payload as {
      result: string;
      subTaskId: string;
    };

    if (subTaskId !== this.currentTaskId) return;
    if (result !== 'rejected') return;

    this.logger.info({ subTaskId, moduleName: this.moduleName }, 'Review rejected, starting rework');

    const { feedback } = event.payload as { feedback?: string };

    // Defer the LLM-heavy rework to prevent blocking the event dispatch chain
    this.deferWork(() => this.reworkCode(event.projectId, subTaskId, feedback ?? '', event.id));
  }

  private async generateAndSubmitCode(
    projectId: string,
    taskId: string,
    triggerEventId: string,
    reviewFeedback?: string,
  ): Promise<void> {
    // Load design doc for context
    const designDoc = await this.artifactStore.load<Record<string, unknown>>(
      projectId, 'design', 'design.json',
    );

    let codeArtifact: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    if (this.llmService.isEnabled) {
      try {
        const result = await this.generateCodeWithLLM(
          designDoc ?? {},
          reviewFeedback,
        );
        codeArtifact = result.data as Record<string, unknown>;
        llmMetadata = {
          source: 'llm',
          model: result.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        };
        this.logger.info({ taskId, model: result.model }, 'Code generated via LLM');
      } catch (err) {
        this.logger.warn({ taskId, error: err }, 'LLM call failed, falling back to template');
        codeArtifact = this.generateFallbackCode(designDoc ?? {});
      }
    } else {
      codeArtifact = this.generateFallbackCode(designDoc ?? {});
    }

    // Save artifact
    const artifactPath = `implementation/${this.moduleName}/code.json`;
    await this.artifactStore.save(projectId, 'implementation', `${this.moduleName}/code.json`, codeArtifact);

    // Transition to in_review BEFORE emitting artifact.produced,
    // because emit triggers the synchronous review chain (PM unblock → CodeReviewer → DeveloperAgent approve)
    // which may complete the task to 'done' before emit returns.
    await this.taskService.transitionTask(
      projectId,
      taskId,
      TaskStatus.InReview,
      'Code produced, awaiting review',
      triggerEventId,
    );

    // Emit artifact.produced — triggers PM to unblock the review task
    await this.emit(
      EventType.ArtifactProduced,
      projectId,
      {
        artifactType: 'code',
        taskId,
        moduleName: this.moduleName,
        path: `artifacts/${artifactPath}`,
        summary: `${this.moduleName} module code`,
      },
      {
        phase: 'implementation',
        metadata: { llm: llmMetadata },
      },
    );

    this.logger.info({ taskId, moduleName: this.moduleName }, 'Code submitted for review');
  }

  private async reworkCode(
    projectId: string,
    taskId: string,
    feedback: string,
    triggerEventId: string,
  ): Promise<void> {
    // Transition back to in_progress for rework
    await this.taskService.transitionTask(
      projectId,
      taskId,
      TaskStatus.InProgress,
      `Reworking based on review feedback`,
      triggerEventId,
    );

    await this.generateAndSubmitCode(projectId, taskId, triggerEventId, feedback);
  }

  private async generateCodeWithLLM(
    designDoc: Record<string, unknown>,
    reviewFeedback?: string,
  ) {
    const systemPrompt = this.llmService.loadPrompt('developer', 'sub-agent-system');

    const promptName = reviewFeedback ? 'rework-code' : 'generate-code';
    const variables: Record<string, string> = {
      moduleName: this.moduleName,
      moduleSpec: JSON.stringify(this.moduleSpec, null, 2),
      designDoc: JSON.stringify(designDoc, null, 2),
    };

    if (reviewFeedback) {
      // Load previous code for context
      const previousCode = await this.artifactStore.load<Record<string, unknown>>(
        this.projectId, 'implementation', `${this.moduleName}/code.json`,
      );
      variables.previousCode = JSON.stringify(previousCode ?? {}, null, 2);
      variables.reviewFeedback = reviewFeedback;
    }

    const userPrompt = this.llmService.loadPrompt('developer', promptName, variables);

    return this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: codeArtifactSchema,
    });
  }

  private generateFallbackCode(_designDoc: Record<string, unknown>): Record<string, unknown> {
    const spec = this.moduleSpec as any;
    const responsibility = spec.responsibility ?? `${this.moduleName} 相关功能`;
    const interfaces = spec.interfaces ?? [];

    return {
      moduleName: this.moduleName,
      files: [
        {
          path: `src/${this.moduleName.toLowerCase().replace(/\s+/g, '-')}/index.ts`,
          content: [
            `/**`,
            ` * ${this.moduleName}`,
            ` * ${responsibility}`,
            ` */`,
            ``,
            ...interfaces.map((iface: string) =>
              `export function ${iface.replace(/[^a-zA-Z0-9]/g, '_')}(): void {\n  // TODO: implement\n}\n`
            ),
            interfaces.length === 0
              ? `export class ${this.moduleName.replace(/\s+/g, '')} {\n  // TODO: implement\n}\n`
              : '',
          ].filter(Boolean).join('\n'),
          language: 'typescript',
        },
      ],
      unitTests: [
        {
          path: `tests/${this.moduleName.toLowerCase().replace(/\s+/g, '-')}/index.test.ts`,
          content: [
            `import { describe, it, expect } from 'vitest';`,
            ``,
            `describe('${this.moduleName}', () => {`,
            `  it('should be implemented', () => {`,
            `    expect(true).toBe(true); // TODO: implement real tests`,
            `  });`,
            `});`,
          ].join('\n'),
        },
      ],
      dependencies: [],
    };
  }
}
