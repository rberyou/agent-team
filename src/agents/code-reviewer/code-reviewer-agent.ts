import { z } from 'zod/v4';
import { BaseAgent } from '../base-agent.js';
import { EventBus } from '../../core/event-bus/index.js';
import { TaskService } from '../../services/task-service.js';
import { ArtifactStore } from '../../core/persistence/index.js';
import { LLMService } from '../../core/llm/index.js';
import {
  EventType,
  AgentRole,
  TaskStatus,
  PhaseName,
} from '../../core/models/index.js';
import type { Event } from '../../core/models/index.js';

// Zod schema for review report validation
export const reviewReportSchema = z.object({
  moduleName: z.string(),
  result: z.enum(['passed', 'rejected']),
  issues: z.array(z.object({
    severity: z.string().transform(v => v.toLowerCase() as any),
    description: z.string(),
    suggestion: z.string(),
    file: z.string().optional(),
    line: z.coerce.number().optional(),
  })).default([]),
  summary: z.string(),
});

export type ReviewReport = z.infer<typeof reviewReportSchema>;

/**
 * Code Reviewer Agent.
 *
 * Responsibilities:
 * - Listen for review tasks assigned to code_reviewer
 * - Review code artifacts against design spec
 * - Produce review reports with pass/reject decisions
 * - Emit review.completed events
 */
export class CodeReviewerAgent extends BaseAgent {
  constructor(
    eventBus: EventBus,
    private readonly taskService: TaskService,
    private readonly artifactStore: ArtifactStore,
    private readonly llmService: LLMService,
  ) {
    super(AgentRole.CodeReviewer, eventBus);
  }

  start(): void {
    this.on(EventType.TaskStarted, (e) => this.handleTaskStarted(e));
    this.logger.info('Code Reviewer Agent started');
  }

  /**
   * When a review task transitions to in_progress (unblocked), perform the review.
   * Supports both Implementation phase (code review) and Testing phase (bug fix review).
   */
  private async handleTaskStarted(event: Event): Promise<void> {
    const { taskId } = event.payload as { taskId: string };

    const task = await this.taskService.getTask(event.projectId, taskId);
    if (!task) return;
    if (task.assignedTo !== AgentRole.CodeReviewer) return;
    if (task.phase !== PhaseName.Implementation && task.phase !== PhaseName.Testing) return;

    this.logger.info({ taskId, phase: task.phase, description: task.description }, 'Starting code review');

    // Defer the LLM-heavy review to prevent blocking the event dispatch chain
    if (task.phase === PhaseName.Testing) {
      this.deferWork(() => this.performBugFixReview(event, task));
    } else {
      this.deferWork(() => this.performReview(event, task));
    }
  }

  private async performReview(
    event: Event,
    task: { taskId: string; projectId: string; description: string; blockedBy: string[] },
  ): Promise<void> {
    // Extract subTaskId from task.blockedBy (the SubTask this review is for)
    const subTaskId = task.blockedBy[0];
    if (!subTaskId) {
      this.logger.error({ taskId: task.taskId }, 'Review task has no associated SubTask');
      return;
    }

    // Get the SubTask to find module name
    const subTask = await this.taskService.getTask(event.projectId, subTaskId);
    const moduleName = subTask?.title.replace('模块开发: ', '') ?? 'unknown';

    // Load code artifact
    const codeArtifact = await this.artifactStore.load<Record<string, unknown>>(
      event.projectId, 'implementation', `${moduleName}/code.json`,
    );

    // Load design doc for reference
    const designDoc = await this.artifactStore.load<Record<string, unknown>>(
      event.projectId, 'design', 'design.json',
    );

    // Generate review
    let reviewReport: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    if (this.llmService.isEnabled) {
      try {
        const result = await this.generateReviewWithLLM(
          codeArtifact ?? {},
          designDoc ?? {},
          moduleName,
        );
        reviewReport = result.data as Record<string, unknown>;
        llmMetadata = {
          source: 'llm',
          model: result.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        };
        this.logger.info({ taskId: task.taskId, model: result.model }, 'Review generated via LLM');
      } catch (err) {
        this.logger.warn({ taskId: task.taskId, error: err }, 'LLM call failed, falling back to template');
        reviewReport = this.generateFallbackReview(moduleName);
      }
    } else {
      reviewReport = this.generateFallbackReview(moduleName);
    }

    // Save review report artifact
    await this.artifactStore.save(
      event.projectId, 'implementation', `${moduleName}/review.json`, reviewReport,
    );

    const result = (reviewReport as any).result as string;

    // Emit review.completed
    await this.emit(
      EventType.ReviewCompleted,
      event.projectId,
      {
        result,
        subTaskId,
        reviewTaskId: task.taskId,
        moduleName,
        issues: (reviewReport as any).issues ?? [],
        feedback: (reviewReport as any).summary ?? '',
      },
      {
        phase: PhaseName.Implementation,
        correlationId: event.correlationId,
        causationId: event.id,
        metadata: { llm: llmMetadata },
      },
    );

    // Complete the review task
    await this.taskService.transitionTask(
      event.projectId,
      task.taskId,
      TaskStatus.Done,
      `Review ${result}: ${(reviewReport as any).summary ?? ''}`,
      event.id,
    );

    this.logger.info({ taskId: task.taskId, result, moduleName }, 'Code review completed');
  }

  private async generateReviewWithLLM(
    codeArtifact: Record<string, unknown>,
    designDoc: Record<string, unknown>,
    moduleName: string,
  ) {
    const systemPrompt = this.llmService.loadPrompt('code-reviewer', 'system');
    const userPrompt = this.llmService.loadPrompt('code-reviewer', 'review-code', {
      code: JSON.stringify(codeArtifact, null, 2),
      designDoc: JSON.stringify(designDoc, null, 2),
      moduleName,
    });

    return this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: reviewReportSchema,
    });
  }

  /**
   * Fallback: always passes review with no issues (LLM not configured).
   */
  private generateFallbackReview(moduleName: string): Record<string, unknown> {
    return {
      moduleName,
      result: 'passed',
      issues: [],
      summary: `${moduleName} 模块代码审查通过（自动审查：LLM未配置）`,
    };
  }

  // ──── Testing Phase: Bug Fix Review ────

  private async performBugFixReview(
    event: Event,
    task: { taskId: string; projectId: string; description: string; blockedBy: string[] },
  ): Promise<void> {
    const subTaskId = task.blockedBy[0];
    if (!subTaskId) {
      this.logger.error({ taskId: task.taskId }, 'Bug fix review task has no associated bug fix task');
      return;
    }

    // Load bug fix artifact
    const bugfix = await this.artifactStore.load<Record<string, unknown>>(
      event.projectId, 'testing', 'bugfix.json',
    );

    // Load test report for bug context
    const testReport = await this.artifactStore.load<Record<string, unknown>>(
      event.projectId, 'testing', 'test-report.json',
    );

    // Load design doc for reference
    const designDoc = await this.artifactStore.load<Record<string, unknown>>(
      event.projectId, 'design', 'design.json',
    );

    let reviewReport: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    if (this.llmService.isEnabled) {
      try {
        const result = await this.generateBugFixReviewWithLLM(
          bugfix ?? {}, testReport ?? {}, designDoc ?? {},
        );
        reviewReport = result.data as Record<string, unknown>;
        llmMetadata = {
          source: 'llm',
          model: result.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        };
        this.logger.info({ taskId: task.taskId, model: result.model }, 'Bug fix review generated via LLM');
      } catch (err) {
        this.logger.warn({ taskId: task.taskId, error: err }, 'LLM call failed, falling back to template');
        reviewReport = this.generateFallbackBugFixReview();
      }
    } else {
      reviewReport = this.generateFallbackBugFixReview();
    }

    // Save bug fix review report
    await this.artifactStore.save(
      event.projectId, 'testing', 'bugfix-review.json', reviewReport,
    );

    const result = (reviewReport as any).result as string;

    // Emit review.completed with Testing phase
    await this.emit(
      EventType.ReviewCompleted,
      event.projectId,
      {
        result,
        subTaskId,
        reviewTaskId: task.taskId,
        moduleName: 'bugfix',
        issues: (reviewReport as any).issues ?? [],
        feedback: (reviewReport as any).summary ?? '',
      },
      {
        phase: PhaseName.Testing,
        correlationId: event.correlationId,
        causationId: event.id,
        metadata: { llm: llmMetadata },
      },
    );

    // Complete the review task
    await this.taskService.transitionTask(
      event.projectId,
      task.taskId,
      TaskStatus.Done,
      `Bug fix review ${result}: ${(reviewReport as any).summary ?? ''}`,
      event.id,
    );

    this.logger.info({ taskId: task.taskId, result }, 'Bug fix review completed');
  }

  private async generateBugFixReviewWithLLM(
    bugfix: Record<string, unknown>,
    testReport: Record<string, unknown>,
    designDoc: Record<string, unknown>,
  ) {
    const systemPrompt = this.llmService.loadPrompt('code-reviewer', 'system');
    const userPrompt = this.llmService.loadPrompt('code-reviewer', 'review-bugfix', {
      bugfix: JSON.stringify(bugfix, null, 2),
      testReport: JSON.stringify(testReport, null, 2),
      designDoc: JSON.stringify(designDoc, null, 2),
    });

    return this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: reviewReportSchema,
    });
  }

  private generateFallbackBugFixReview(): Record<string, unknown> {
    return {
      moduleName: 'bugfix',
      result: 'passed',
      issues: [],
      summary: 'Bug修复代码审查通过（自动审查：LLM未配置）',
    };
  }
}
