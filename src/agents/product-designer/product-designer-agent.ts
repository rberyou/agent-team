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

const discoveryQuestionSchema = z.object({
  questions: z.array(z.object({
    id: z.string(),
    text: z.string(),
    category: z.enum(['problem', 'success', 'constraints', 'persona', 'scope']),
  })),
});

const prdSchema = z.object({
  title: z.string(),
  version: z.string().optional().default('1.0'),
  executiveSummary: z.object({
    problemStatement: z.string(),
    proposedSolution: z.string(),
    successCriteria: z.array(z.string()),
  }),
  userExperience: z.object({
    userPersonas: z.array(z.string()).default([]),
    userStories: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    nonGoals: z.array(z.string()).default([]),
  }),
  aiSystemRequirements: z.object({
    toolRequirements: z.array(z.string()).default([]),
    evaluationStrategy: z.string().optional(),
  }).optional(),
  technicalSpecifications: z.object({
    architectureOverview: z.string().optional(),
    integrationPoints: z.array(z.string()).default([]),
    securityPrivacy: z.string().optional(),
  }).optional(),
  risksRoadmap: z.object({
    phasedRollout: z.array(z.string()).default([]),
    technicalRisks: z.array(z.string()).default([]),
  }).optional(),
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

type DiscoveryQuestions = z.infer<typeof discoveryQuestionSchema>;

interface PendingTaskContext {
  originalEvent: Event;
  task: { taskId: string; title: string; description: string; phase: string };
  questions: DiscoveryQuestions['questions'];
}

export class ProductDesignerAgent extends BaseAgent {
  private pendingTasks: Map<string, PendingTaskContext> = new Map();

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
    this.on(EventType.ProductDesignerAnswersReceived, (e) => this.handleAnswersReceived(e));
    this.logger.info('Product Designer Agent started');
  }

  private async handleTaskCreated(event: Event): Promise<void> {
    const { taskId, assignedTo } = event.payload as {
      taskId: string;
      assignedTo: string;
    };

    if (assignedTo !== AgentRole.ProductDesigner) return;

    this.logger.info({ taskId }, 'Received task, starting discovery interview');

    const task = await this.taskService.getTask(event.projectId, taskId);
    if (!task) {
      this.logger.error({ taskId }, 'Task not found');
      return;
    }

    await this.taskService.transitionTask(
      event.projectId,
      taskId,
      TaskStatus.InProgress,
      'Product Designer started work',
      event.id,
    );

    this.deferWork(() => this.executeDiscoveryPhase(event, task));
  }

  private async executeDiscoveryPhase(
    originalEvent: Event,
    task: { taskId: string; title: string; description: string; phase: string },
  ): Promise<void> {
    const taskId = task.taskId;

    await this.emit(
      EventType.AgentThinking,
      originalEvent.projectId,
      { taskId, message: 'Analyzing requirement and preparing discovery questions' },
      { phase: task.phase, correlationId: originalEvent.correlationId, causationId: originalEvent.id },
    );

    let questions: DiscoveryQuestions['questions'] = [];

    if (this.llmService.isEnabled) {
      try {
        await this.emit(
          EventType.AgentWorking,
          originalEvent.projectId,
          { taskId, message: 'Building discovery interview prompt...' },
          { phase: task.phase, correlationId: originalEvent.correlationId, causationId: originalEvent.id },
        );

        const result = await this.generateDiscoveryQuestions(task.title, task.description);

        await this.emit(
          EventType.AgentWorking,
          originalEvent.projectId,
          { taskId, message: 'Parsing LLM response...' },
          { phase: task.phase, correlationId: originalEvent.correlationId, causationId: originalEvent.id },
        );

        questions = result.questions;
        this.logger.info({ taskId, count: questions.length }, 'Discovery questions generated via LLM');
      } catch (err) {
        this.logger.warn({ taskId, error: err }, 'LLM call failed for discovery questions, using fallback');
        questions = this.generateFallbackQuestions(task.title, task.description);
      }
    } else {
      questions = this.generateFallbackQuestions(task.title, task.description);
    }

    await this.emit(
      EventType.AgentWorking,
      originalEvent.projectId,
      { taskId, message: `Generated ${questions.length} discovery questions, waiting for your answers` },
      { phase: task.phase, correlationId: originalEvent.correlationId, causationId: originalEvent.id },
    );

    this.pendingTasks.set(taskId, { originalEvent, task, questions });

    await this.emit(
      EventType.ProductDesignerQuestions,
      originalEvent.projectId,
      {
        taskId,
        questions,
        message: '请回答以下澄清问题以帮助完善需求分析',
      },
      {
        phase: task.phase,
        correlationId: originalEvent.correlationId,
        causationId: originalEvent.id,
      },
    );

    this.logger.info({ taskId, questionCount: questions.length }, 'Discovery questions emitted, waiting for answers');
  }

  private async handleAnswersReceived(event: Event): Promise<void> {
    const { taskId, answers } = event.payload as {
      taskId: string;
      answers: Record<string, string>;
    };

    const context = this.pendingTasks.get(taskId);
    if (!context) {
      this.logger.warn({ taskId }, 'Received answers but no pending task context found');
      return;
    }

    this.logger.info({ taskId, answerCount: Object.keys(answers).length }, 'Received answers, generating PRD');

    this.pendingTasks.delete(taskId);

    await this.executePRDWork(context.originalEvent, context.task, context.questions, answers);
  }

  private async executePRDWork(
    event: Event,
    task: { taskId: string; title: string; description: string; phase: string },
    questions: DiscoveryQuestions['questions'],
    answers: Record<string, string>,
  ): Promise<void> {
    const taskId = task.taskId;

    await this.artifactStore.save(event.projectId, 'analysis', 'q-and-a.json', {
      questions,
      answers,
      timestamp: new Date().toISOString(),
    });

    await this.emit(
      EventType.AgentWorking,
      event.projectId,
      { taskId, message: 'Saved Q&A context' },
      { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
    );

    const previousPrd = await this.artifactStore.load<Record<string, unknown>>(
      event.projectId, 'analysis', 'prd.json',
    );
    const isRework = previousPrd !== null;

    if (isRework) {
      this.logger.info({ taskId }, 'Previous PRD found, entering rework mode');
      await this.emit(
        EventType.AgentThinking,
        event.projectId,
        { taskId, message: 'Analyzing feedback and previous PRD for revision' },
        { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
      );
    } else {
      await this.emit(
        EventType.AgentThinking,
        event.projectId,
        { taskId, message: 'Analyzing requirement and Q&A context for PRD generation' },
        { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
      );
    }

    const qaContext = this.buildQAContext(questions, answers);
    let prd: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    if (this.llmService.isEnabled) {
      try {
        await this.emit(
          EventType.AgentWorking,
          event.projectId,
          { taskId, message: 'Building PRD prompt...' },
          { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
        );

        const result = isRework
          ? await this.reworkPRDWithLLM(previousPrd!, task.description, qaContext)
          : await this.generatePRDWithLLM(task.title, task.description, qaContext);

        await this.emit(
          EventType.AgentWorking,
          event.projectId,
          { taskId, message: 'Parsing PRD structure from LLM response...' },
          { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
        );

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
          ? this.reworkFallbackPRD(previousPrd!, task.description, qaContext)
          : this.generateFallbackPRD(task.title, task.description, qaContext);
      }
    } else {
      prd = isRework
        ? this.reworkFallbackPRD(previousPrd!, task.description, qaContext)
        : this.generateFallbackPRD(task.title, task.description, qaContext);
    }

    await this.emit(
      EventType.AgentWorking,
      event.projectId,
      { taskId, message: 'Validating PRD schema...' },
      { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
    );

    await this.artifactStore.save(event.projectId, 'analysis', 'prd.json', prd);

    await this.emit(
      EventType.AgentWorking,
      event.projectId,
      { taskId, message: 'Saving PRD artifact' },
      { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
    );

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

    await this.taskService.transitionTask(
      event.projectId,
      taskId,
      TaskStatus.InReview,
      'PRD produced, awaiting review',
      event.id,
    );

    this.logger.info({ taskId }, 'PRD produced and submitted for review');
  }

  private buildQAContext(
    questions: DiscoveryQuestions['questions'],
    answers: Record<string, string>,
  ): string {
    const lines: string[] = [];
    for (const q of questions) {
      const answer = answers[q.id] || '未回答';
      lines.push(`Q: ${q.text}`);
      lines.push(`A: ${answer}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  private async generateDiscoveryQuestions(title: string, description: string) {
    const systemPrompt = this.llmService.loadPrompt('product-designer', 'system');
    const userPrompt = this.llmService.loadPrompt('product-designer', 'discovery-questions', {
      title,
      description,
    });

    const result = await this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: discoveryQuestionSchema,
    });

    return result.data as DiscoveryQuestions;
  }

  private async generatePRDWithLLM(
    title: string,
    description: string,
    qaContext: string,
  ) {
    const systemPrompt = this.llmService.loadPrompt('product-designer', 'system');
    const userPrompt = this.llmService.loadPrompt('product-designer', 'generate-prd', {
      title,
      description,
      qaContext,
    });

    return this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: prdSchema,
    });
  }

  private async reworkPRDWithLLM(
    previousPrd: Record<string, unknown>,
    feedback: string,
    qaContext: string,
  ) {
    const systemPrompt = this.llmService.loadPrompt('product-designer', 'system');
    const userPrompt = this.llmService.loadPrompt('product-designer', 'rework-prd', {
      previousPrd: JSON.stringify(previousPrd, null, 2),
      feedback,
      qaContext,
      originalRequirement: (previousPrd as any)?.executiveSummary?.problemStatement
        ?? (previousPrd as any)?.overview
        ?? '',
    });

    return this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: prdSchema,
    });
  }

  private generateFallbackQuestions(_title: string, _description: string): DiscoveryQuestions['questions'] {
    return [
      { id: 'Q1', text: '为什么要现在做这个项目？核心问题是什么？', category: 'problem' },
      { id: 'Q2', text: '如何衡量项目成功？有哪些关键指标？', category: 'success' },
      { id: 'Q3', text: '有什么技术约束、预算限制或截止日期吗？', category: 'constraints' },
      { id: 'Q4', text: '谁是目标用户？他们的主要使用场景是什么？', category: 'persona' },
      { id: 'Q5', text: '有哪些功能是明确不在范围内的？', category: 'scope' },
    ];
  }

  private generateFallbackPRD(
    title: string,
    description: string,
    qaContext: string,
  ): Record<string, unknown> {
    return {
      title,
      version: '1.0',
      createdAt: new Date().toISOString(),
      executiveSummary: {
        problemStatement: `解决用户需求: ${description}`,
        proposedSolution: '通过构建自动化系统来满足需求',
        successCriteria: ['功能按需求正常工作', '性能满足基本要求'],
      },
      userExperience: {
        userPersonas: ['目标用户'],
        userStories: [`作为用户，我希望${title}，以便提升工作效率`],
        acceptanceCriteria: ['功能正常工作', '错误有合理处理'],
        nonGoals: [],
      },
      aiSystemRequirements: {},
      technicalSpecifications: {},
      risksRoadmap: { phasedRollout: ['MVP'], technicalRisks: [] },
      features: [
        {
          id: 'F001',
          name: '核心功能',
          description: `基于需求: ${description}\n\n问答上下文:\n${qaContext}`,
          priority: 'high',
          userStories: [`作为用户，我希望${title}，以便提升工作效率`],
          acceptanceCriteria: ['功能按需求正常工作'],
        },
      ],
      nonFunctionalRequirements: ['系统响应时间应小于2秒', '数据持久化可靠'],
      assumptions: ['PRD为模板生成（LLM未配置），建议配置LLM以获得更精准的需求分析'],
    };
  }

  private reworkFallbackPRD(
    previousPrd: Record<string, unknown>,
    feedback: string,
    qaContext: string,
  ): Record<string, unknown> {
    const prev = previousPrd as any;
    const existingAssumptions: string[] = prev.assumptions ?? [];

    return {
      ...previousPrd,
      version: `${parseFloat(prev.version ?? '1.0') + 0.1}`,
      assumptions: [
        ...existingAssumptions.filter((a: string) => !a.startsWith('已根据用户反馈修订')),
        `已根据用户反馈修订: ${feedback}`,
        `问答上下文:\n${qaContext}`,
        'PRD修订为模板生成（LLM未配置），建议配置LLM以获得更精准的修订',
      ],
    };
  }
}