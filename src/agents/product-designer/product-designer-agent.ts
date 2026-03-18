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
} from '../../core/models/index.js';
import type { Event } from '../../core/models/index.js';

// Zod schema for PRD validation
const prdSchema = z.object({
  title: z.string(),
  version: z.string().optional().default('1.0'),
  overview: z.string(),
  features: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    priority: z.enum(['high', 'medium', 'low']),
    userStories: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(z.string()).default([]),
  })),
  nonFunctionalRequirements: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  modules: z.array(z.object({
    name: z.string(),
    description: z.string(),
    relatedFeatures: z.array(z.string()).default([]),
  })).default([]),
});

/**
 * Product Designer Agent.
 *
 * Responsibilities:
 * - Listen for task.created assigned to product_designer
 * - Generate PRD via LLM (with fallback to template)
 * - Produce artifact and emit artifact.produced
 */
export class ProductDesignerAgent extends BaseAgent {
  constructor(
    eventBus: EventBus,
    private readonly taskService: TaskService,
    private readonly artifactStore: ArtifactStore,
    private readonly llmService: LLMService,
  ) {
    super(AgentRole.ProductDesigner, eventBus);
  }

  start(): void {
    this.on(EventType.TaskCreated, (e) => this.handleTaskCreated(e));
    this.logger.info('Product Designer Agent started');
  }

  /**
   * When a task is created and assigned to us, auto-start and produce PRD.
   */
  private async handleTaskCreated(event: Event): Promise<void> {
    const { taskId, assignedTo } = event.payload as {
      taskId: string;
      assignedTo: string;
    };

    if (assignedTo !== AgentRole.ProductDesigner) return;

    this.logger.info({ taskId }, 'Received task, starting analysis');

    // Get task details
    const task = await this.taskService.getTask(event.projectId, taskId);
    if (!task) {
      this.logger.error({ taskId }, 'Task not found');
      return;
    }

    // Transition to in_progress
    await this.taskService.transitionTask(
      event.projectId,
      taskId,
      TaskStatus.InProgress,
      'Product Designer started work',
      event.id,
    );

    // Defer the LLM-heavy work to prevent blocking the event dispatch chain
    this.deferWork(() => this.executePRDWork(event, task));
  }

  private async executePRDWork(
    event: Event,
    task: { taskId: string; title: string; description: string; phase: string },
  ): Promise<void> {
    const taskId = task.taskId;

    await this.emit(
      EventType.AgentThinking,
      event.projectId,
      {
        taskId,
        message: 'Analyzing requirement',
      },
      { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
    );

    // Generate PRD: detect rework vs initial
    let prd: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    // Check if a PRD already exists → rework mode
    const previousPrd = await this.artifactStore.load<Record<string, unknown>>(
      event.projectId, 'analysis', 'prd.json',
    );
    const isRework = previousPrd !== null;

    if (isRework) {
      this.logger.info({ taskId }, 'Previous PRD found, entering rework mode');
      await this.emit(
        EventType.AgentWorking,
        event.projectId,
        { taskId, message: 'Revising existing PRD based on feedback' },
        { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
      );
    } else {
      await this.emit(
        EventType.AgentWorking,
        event.projectId,
        { taskId, message: 'Generating PRD document' },
        { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
      );
    }

    if (this.llmService.isEnabled) {
      try {
        const result = isRework
          ? await this.reworkPRDWithLLM(previousPrd!, task.description)
          : await this.generatePRDWithLLM(task.title, task.description);
        prd = result.data as Record<string, unknown>;
        llmMetadata = {
          source: 'llm',
          model: result.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        };
        this.logger.info({ taskId, model: result.model, rework: isRework }, 'PRD generated via LLM');
      } catch (err) {
        this.logger.warn({ taskId, error: err }, 'LLM call failed, falling back to template');
        prd = isRework
          ? this.reworkFallbackPRD(previousPrd!, task.description)
          : this.generateFallbackPRD(task.title, task.description);
      }
    } else {
      prd = isRework
        ? this.reworkFallbackPRD(previousPrd!, task.description)
        : this.generateFallbackPRD(task.title, task.description);
    }

    // Save artifact
    await this.artifactStore.save(event.projectId, 'analysis', 'prd.json', prd);

    await this.emit(
      EventType.AgentWorking,
      event.projectId,
      { taskId, message: 'Saving PRD artifact' },
      { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
    );

    // Emit artifact.produced
    await this.emit(
      EventType.ArtifactProduced,
      event.projectId,
      {
        artifactType: 'prd',
        taskId,
        path: 'artifacts/analysis/prd.json',
        summary: (prd as any).title ?? task.title,
      },
      {
        phase: task.phase,
        correlationId: event.correlationId,
        causationId: event.id,
        metadata: { llm: llmMetadata },
      },
    );

    // Transition task to in_review (waiting for user confirmation)
    await this.taskService.transitionTask(
      event.projectId,
      taskId,
      TaskStatus.InReview,
      'PRD produced, awaiting review',
      event.id,
    );

    this.logger.info({ taskId }, 'PRD produced and submitted for review');
  }

  /**
   * Generate PRD using LLM with structured output.
   */
  private async generatePRDWithLLM(title: string, description: string) {
    const systemPrompt = this.llmService.loadPrompt('product-designer', 'system');
    const userPrompt = this.llmService.loadPrompt('product-designer', 'generate-prd', {
      title,
      description,
    });

    return this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: prdSchema,
    });
  }

  /**
   * Rework PRD using LLM with previous artifact + feedback.
   */
  private async reworkPRDWithLLM(previousPrd: Record<string, unknown>, feedback: string) {
    const systemPrompt = this.llmService.loadPrompt('product-designer', 'system');
    const userPrompt = this.llmService.loadPrompt('product-designer', 'rework-prd', {
      previousPrd: JSON.stringify(previousPrd, null, 2),
      feedback,
      originalRequirement: (previousPrd as any).overview ?? '',
    });

    return this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: prdSchema,
    });
  }

  /**
   * Fallback: generate a template PRD when LLM is unavailable.
   */
  private generateFallbackPRD(title: string, description: string): Record<string, unknown> {
    return {
      title,
      version: '1.0',
      createdAt: new Date().toISOString(),
      overview: description,
      features: [
        {
          id: 'F001',
          name: '核心功能',
          description: `基于需求: ${description}`,
          priority: 'high',
          userStories: [
            `作为用户，我希望 ${title}，以便提升工作效率。`,
          ],
          acceptanceCriteria: [
            '功能按照需求描述正常工作',
            '错误情况有合理的处理方式',
          ],
        },
      ],
      nonFunctionalRequirements: [
        '系统响应时间应小于2秒',
        '数据持久化可靠',
      ],
      assumptions: [
        'PRD为模板生成（LLM未配置），建议配置LLM以获得更精准的需求分析',
      ],
    };
  }

  /**
   * Fallback rework: preserve previous PRD structure and append revision notes.
   */
  private reworkFallbackPRD(
    previousPrd: Record<string, unknown>,
    feedback: string,
  ): Record<string, unknown> {
    const prev = previousPrd as any;
    const existingAssumptions: string[] = prev.assumptions ?? [];

    return {
      ...previousPrd,
      version: `${parseFloat(prev.version ?? '1.0') + 0.1}`,
      assumptions: [
        ...existingAssumptions.filter((a: string) => !a.startsWith('已根据用户反馈修订')),
        `已根据用户反馈修订: ${feedback}`,
        'PRD修订为模板生成（LLM未配置），建议配置LLM以获得更精准的修订',
      ],
    };
  }
}
