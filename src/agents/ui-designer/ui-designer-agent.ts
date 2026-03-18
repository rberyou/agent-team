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

const uiDesignSchema = z.object({
  projectName: z.string(),
  version: z.string().optional().default('1.0'),
  designSystem: z.object({
    colorScheme: z.object({
      primary: z.string(),
      secondary: z.string(),
      accent: z.string(),
      background: z.string(),
      text: z.string(),
    }),
    typography: z.object({
      headingFont: z.string(),
      bodyFont: z.string(),
      baseFontSize: z.string(),
    }),
    spacing: z.object({
      unit: z.string(),
      scale: z.array(z.string()),
    }),
  }),
  pages: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    wireframe: z.string().default(''),
    components: z.array(z.string()).default([]),
  })).default([]),
  componentSpecs: z.array(z.object({
    name: z.string(),
    purpose: z.string(),
    props: z.array(z.string()).default([]),
    styles: z.string().default(''),
  })).default([]),
  styleGuide: z.object({
    layout: z.string(),
    responsive: z.string(),
    accessibility: z.string(),
  }),
  summary: z.string(),
});

/**
 * UI Designer Agent.
 *
 * Responsibilities:
 * - Listen for task.created assigned to ui_designer
 * - Load PRD from analysis phase
 * - Generate UI design document via LLM (with fallback)
 * - Produce artifact and emit artifact.produced
 */
export class UIDesignerAgent extends BaseAgent {
  constructor(
    eventBus: EventBus,
    private readonly taskService: TaskService,
    private readonly artifactStore: ArtifactStore,
    private readonly llmService: LLMService,
  ) {
    super(AgentRole.UIDesigner, eventBus);
  }

  start(): void {
    this.on(EventType.TaskCreated, (e) => this.handleTaskCreated(e));
    this.logger.info('UI Designer Agent started');
  }

  private async handleTaskCreated(event: Event): Promise<void> {
    const { taskId, assignedTo } = event.payload as {
      taskId: string;
      assignedTo: string;
    };

    if (assignedTo !== AgentRole.UIDesigner) return;

    this.logger.info({ taskId }, 'Received task, starting UI design');

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
      'UI Designer started work',
      event.id,
    );

    // Defer the LLM-heavy work to prevent blocking the event dispatch chain
    this.deferWork(() => this.executeUIDesignWork(event, task));
  }

  private async executeUIDesignWork(
    event: Event,
    task: { taskId: string; title: string; description: string; phase: string },
  ): Promise<void> {
    const taskId = task.taskId;

    await this.emit(
      EventType.AgentThinking,
      event.projectId,
      { taskId, message: 'Analyzing PRD for UI design' },
      { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
    );

    // Load PRD from analysis phase
    const prd = await this.artifactStore.load(event.projectId, 'analysis', 'prd.json');

    // Generate UI design: detect rework vs initial
    let uiDesign: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    // Check if a UI design already exists → rework mode
    const previousUiDesign = await this.artifactStore.load<Record<string, unknown>>(
      event.projectId, 'design', 'ui-design.json',
    );
    const isRework = previousUiDesign !== null;

    if (isRework) {
      this.logger.info({ taskId }, 'Previous UI design found, entering rework mode');
      await this.emit(
        EventType.AgentWorking,
        event.projectId,
        { taskId, message: 'Revising UI design based on feedback' },
        { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
      );
    } else {
      await this.emit(
        EventType.AgentWorking,
        event.projectId,
        { taskId, message: 'Generating UI design document' },
        { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
      );
    }

    if (this.llmService.isEnabled) {
      try {
        const result = isRework
          ? await this.reworkWithLLM(previousUiDesign!, prd, task.description)
          : await this.generateWithLLM(prd);
        uiDesign = result.data as Record<string, unknown>;
        llmMetadata = {
          source: 'llm',
          model: result.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        };
        this.logger.info({ taskId, model: result.model, rework: isRework }, 'UI design generated via LLM');
      } catch (err) {
        this.logger.warn({ taskId, error: err }, 'LLM call failed, falling back to template');
        uiDesign = isRework
          ? this.reworkFallback(previousUiDesign!, task.description)
          : this.generateFallback(prd, task.title);
      }
    } else {
      uiDesign = isRework
        ? this.reworkFallback(previousUiDesign!, task.description)
        : this.generateFallback(prd, task.title);
    }

    // Save artifact
    await this.artifactStore.save(event.projectId, 'design', 'ui-design.json', uiDesign);

    await this.emit(
      EventType.AgentWorking,
      event.projectId,
      { taskId, message: 'Saving UI design artifact' },
      { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
    );

    // Emit artifact.produced
    await this.emit(
      EventType.ArtifactProduced,
      event.projectId,
      {
        artifactType: 'ui_design',
        taskId,
        path: 'artifacts/design/ui-design.json',
        summary: (uiDesign as any).summary ?? 'UI Design Document',
      },
      {
        phase: task.phase,
        correlationId: event.correlationId,
        causationId: event.id,
        metadata: { llm: llmMetadata },
      },
    );

    // Transition to in_review
    await this.taskService.transitionTask(
      event.projectId,
      taskId,
      TaskStatus.InReview,
      'UI design produced, awaiting review',
      event.id,
    );

    this.logger.info({ taskId }, 'UI design produced and submitted for review');
  }

  private async generateWithLLM(prd: unknown) {
    const systemPrompt = this.llmService.loadPrompt('ui-designer', 'system');
    const userPrompt = this.llmService.loadPrompt('ui-designer', 'generate-ui-design', {
      prd: JSON.stringify(prd, null, 2),
    });

    return this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: uiDesignSchema,
    });
  }

  private async reworkWithLLM(
    previousUiDesign: Record<string, unknown>,
    prd: unknown,
    feedback: string,
  ) {
    const systemPrompt = this.llmService.loadPrompt('ui-designer', 'system');
    const userPrompt = this.llmService.loadPrompt('ui-designer', 'rework-ui-design', {
      previousUiDesign: JSON.stringify(previousUiDesign, null, 2),
      feedback,
      prd: JSON.stringify(prd, null, 2),
    });

    return this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: uiDesignSchema,
    });
  }

  private generateFallback(prd: unknown, title: string): Record<string, unknown> {
    const prdObj = prd as Record<string, any> | null;
    const features = prdObj?.features ?? [];

    const pages = features.map((f: any, i: number) => ({
      id: `P${String(i + 1).padStart(3, '0')}`,
      name: f.name ?? `页面${i + 1}`,
      description: f.description ?? '',
      wireframe: `[${f.name ?? `Page ${i + 1}`}] 包含标题栏、主要内容区域和操作按钮`,
      components: ['Header', 'ContentArea', 'ActionButton', 'StatusIndicator'],
    }));

    if (pages.length === 0) {
      pages.push({
        id: 'P001',
        name: '主页面',
        description: title,
        wireframe: '[主页面] 包含导航栏、内容区域和底部操作栏',
        components: ['Navbar', 'ContentArea', 'BottomBar'],
      });
    }

    return {
      projectName: prdObj?.title ?? title,
      version: '1.0',
      designSystem: {
        colorScheme: {
          primary: '#1976D2',
          secondary: '#424242',
          accent: '#FF5722',
          background: '#FFFFFF',
          text: '#212121',
        },
        typography: {
          headingFont: 'Inter, sans-serif',
          bodyFont: 'Inter, sans-serif',
          baseFontSize: '16px',
        },
        spacing: {
          unit: '8px',
          scale: ['4px', '8px', '16px', '24px', '32px', '48px'],
        },
      },
      pages,
      componentSpecs: [
        { name: 'Header', purpose: '页面顶部导航和标题展示', props: ['title', 'showBack'], styles: '固定顶部，高度56px' },
        { name: 'ContentArea', purpose: '主要内容展示区域', props: ['children', 'padding'], styles: '自适应高度，内边距16px' },
        { name: 'ActionButton', purpose: '主要操作按钮', props: ['label', 'onClick', 'variant'], styles: '圆角8px，高度44px' },
        { name: 'StatusIndicator', purpose: '状态标签展示', props: ['status', 'label'], styles: '圆角标签，不同状态不同颜色' },
      ],
      styleGuide: {
        layout: '采用 Flexbox 布局，最大宽度1200px居中',
        responsive: '移动优先，断点：768px (平板), 1024px (桌面)',
        accessibility: '所有交互元素支持键盘导航，颜色对比度≥4.5:1，图片提供alt文本',
      },
      summary: `UI设计文档(模板生成) — 共${pages.length}个页面，4个基础组件，采用Material Design风格`,
    };
  }

  private reworkFallback(
    previousUiDesign: Record<string, unknown>,
    feedback: string,
  ): Record<string, unknown> {
    const prev = previousUiDesign as any;
    return {
      ...previousUiDesign,
      version: `${parseFloat(prev.version ?? '1.0') + 0.1}`,
      summary: `${prev.summary ?? 'UI设计文档'} [已修订: ${feedback}]`,
    };
  }
}
