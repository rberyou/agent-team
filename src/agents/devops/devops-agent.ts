import { z } from 'zod/v4';
import { BaseAgent } from '../base-agent.js';
import { EventBus } from '../../core/event-bus/index.js';
import { TaskService } from '../../services/task-service.js';
import { ArtifactStore } from '../../core/persistence/index.js';
import { LLMService } from '../../core/llm/index.js';
import {
  EventType,
  AgentRole,
  PhaseName,
  TaskStatus,
} from '../../core/models/index.js';
import type { Event } from '../../core/models/index.js';

const envConfigSchema = z.object({
  environment: z.string(),
  services: z.array(z.object({
    name: z.string(),
    type: z.string(),
    config: z.record(z.string(), z.unknown()).default({}),
  })).default([]),
  dependencies: z.array(z.object({
    name: z.string(),
    version: z.string(),
    purpose: z.string(),
  })).default([]),
  configuration: z.object({
    runtime: z.string(),
    database: z.string().optional(),
    cache: z.string().optional(),
    messaging: z.string().optional(),
  }),
  summary: z.string(),
});

const previewDeploymentSchema = z.object({
  previewUrl: z.string(),
  environment: z.string(),
  services: z.array(z.object({
    name: z.string(),
    status: z.string(),
    port: z.number().optional(),
  })).default([]),
  deployedAt: z.string(),
  buildInfo: z.object({
    version: z.string(),
    modules: z.array(z.string()).default([]),
  }),
  summary: z.string(),
});

const deploymentPlanSchema = z.object({
  environment: z.string(),
  strategy: z.string(),
  steps: z.array(z.object({
    order: z.number(),
    name: z.string(),
    description: z.string(),
    automated: z.boolean().default(true),
  })).default([]),
  rollbackPlan: z.object({
    trigger: z.string(),
    steps: z.array(z.string()).default([]),
  }),
  monitoring: z.object({
    healthChecks: z.array(z.string()).default([]),
    alerts: z.array(z.string()).default([]),
    dashboards: z.array(z.string()).default([]),
  }),
  risks: z.array(z.object({
    description: z.string(),
    severity: z.string().default('medium'),
    mitigation: z.string(),
  })).default([]),
  summary: z.string(),
});

/**
 * DevOps Agent.
 *
 * Responsibilities:
 * - Testing phase: prepare test environment configuration (auto, no user confirmation)
 * - Acceptance phase: generate production deployment plan (requires user confirmation)
 */
export class DevOpsAgent extends BaseAgent {
  constructor(
    eventBus: EventBus,
    private readonly taskService: TaskService,
    private readonly artifactStore: ArtifactStore,
    private readonly llmService: LLMService,
    private readonly serverPort: number = 3000,
  ) {
    super(AgentRole.DevOps, eventBus);
  }

  start(): void {
    this.on(EventType.TaskCreated, (e) => this.handleTaskCreated(e));
    this.logger.info('DevOps Agent started');
  }

  private async handleTaskCreated(event: Event): Promise<void> {
    const { taskId, assignedTo } = event.payload as {
      taskId: string;
      assignedTo: string;
    };

    if (assignedTo !== AgentRole.DevOps) return;

    const task = await this.taskService.getTask(event.projectId, taskId);
    if (!task) {
      this.logger.error({ taskId }, 'Task not found');
      return;
    }

    if (task.phase === PhaseName.Testing) {
      await this.handleTestEnvTask(event, task.phase, taskId);
    } else if (task.phase === PhaseName.Acceptance) {
      if (task.title.includes('预览环境')) {
        await this.handlePreviewDeployTask(event, task.phase, taskId);
      } else {
        await this.handleDeploymentTask(event, task.phase, taskId, task.description);
      }
    }
  }

  /**
   * Trigger 1: Prepare test environment configuration.
   * Auto-completes without user confirmation.
   */
  private async handleTestEnvTask(event: Event, phase: string, taskId: string): Promise<void> {
    this.logger.info({ taskId }, 'Preparing test environment configuration');

    await this.taskService.transitionTask(
      event.projectId,
      taskId,
      TaskStatus.InProgress,
      'DevOps preparing test environment',
      event.id,
    );

    // Defer the LLM-heavy work to prevent blocking the event dispatch chain
    this.deferWork(() => this.executeTestEnvWork(event, phase, taskId));
  }

  private async executeTestEnvWork(event: Event, phase: string, taskId: string): Promise<void> {
    // Load upstream artifacts
    const designDoc = await this.artifactStore.load(event.projectId, 'design', 'design.json');
    const integrationReport = await this.artifactStore.load(event.projectId, 'implementation', 'integration-report.json');

    let envConfig: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    if (this.llmService.isEnabled) {
      try {
        const result = await this.generateEnvConfigWithLLM(designDoc, integrationReport);
        envConfig = result.data as Record<string, unknown>;
        llmMetadata = {
          source: 'llm',
          model: result.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        };
        this.logger.info({ taskId, model: result.model }, 'Env config generated via LLM');
      } catch (err) {
        this.logger.warn({ taskId, error: err }, 'LLM failed, using fallback env config');
        envConfig = this.generateFallbackEnvConfig(designDoc);
      }
    } else {
      envConfig = this.generateFallbackEnvConfig(designDoc);
    }

    await this.artifactStore.save(event.projectId, 'testing', 'env-config.json', envConfig);

    await this.emit(
      EventType.ArtifactProduced,
      event.projectId,
      {
        artifactType: 'env_config',
        taskId,
        path: 'artifacts/testing/env-config.json',
        summary: 'Test environment configuration',
      },
      {
        phase,
        correlationId: event.correlationId,
        causationId: event.id,
        metadata: { llm: llmMetadata },
      },
    );

    // Auto-complete — no user confirmation needed
    await this.taskService.transitionTask(
      event.projectId,
      taskId,
      TaskStatus.Done,
      'Test environment configured',
      event.id,
    );

    this.logger.info({ taskId }, 'Test environment configuration completed');
  }

  /**
   * Trigger 2: Deploy preview environment for user acceptance trial.
   * Auto-completes without user confirmation (PM will notify user).
   */
  private async handlePreviewDeployTask(event: Event, phase: string, taskId: string): Promise<void> {
    this.logger.info({ taskId }, 'Deploying preview environment');

    await this.taskService.transitionTask(
      event.projectId,
      taskId,
      TaskStatus.InProgress,
      'DevOps deploying preview environment',
      event.id,
    );

    // Defer the LLM-heavy work to prevent blocking the event dispatch chain
    this.deferWork(() => this.executePreviewDeployWork(event, phase, taskId));
  }

  private async executePreviewDeployWork(event: Event, phase: string, taskId: string): Promise<void> {
    // Load upstream artifacts
    const designDoc = await this.artifactStore.load(event.projectId, 'design', 'design.json');
    const integrationReport = await this.artifactStore.load(event.projectId, 'implementation', 'integration-report.json');
    const acceptanceFix = await this.artifactStore.load(event.projectId, 'acceptance', 'acceptance-fix.json');

    let previewDeployment: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    // Check if preview was already deployed → rework/update mode
    const previousDeployment = await this.artifactStore.load<Record<string, unknown>>(
      event.projectId, 'acceptance', 'preview-deployment.json',
    );
    const isRework = previousDeployment !== null;

    if (isRework) {
      this.logger.info({ taskId }, 'Previous preview deployment found, entering update mode');
    }

    if (this.llmService.isEnabled) {
      try {
        const result = await this.generatePreviewDeploymentWithLLM(designDoc, integrationReport, isRework ? previousDeployment : null, acceptanceFix);
        previewDeployment = result.data as Record<string, unknown>;
        llmMetadata = {
          source: 'llm',
          model: result.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        };
        this.logger.info({ taskId, model: result.model, rework: isRework }, 'Preview deployment generated via LLM');
      } catch (err) {
        this.logger.warn({ taskId, error: err }, 'LLM failed, using fallback preview deployment');
        previewDeployment = this.generateFallbackPreviewDeployment(designDoc, isRework, event.projectId);
      }
    } else {
      previewDeployment = this.generateFallbackPreviewDeployment(designDoc, isRework, event.projectId);
    }

    // Ensure the real preview URL is set (LLM may have generated a different one)
    const realPreviewUrl = `http://localhost:${this.serverPort}/preview/${event.projectId}/`;
    (previewDeployment as any).previewUrl = realPreviewUrl;

    // Extract code files to output directory so the preview route can serve them
    try {
      const extractResult = await this.artifactStore.extractCodeFiles(event.projectId);
      this.logger.info({ projectId: event.projectId, filesWritten: extractResult.filesWritten, errors: extractResult.errors }, 'Code files extracted for preview');
    } catch (err) {
      this.logger.warn({ projectId: event.projectId, error: err }, 'Failed to extract code files for preview');
    }

    await this.artifactStore.save(event.projectId, 'acceptance', 'preview-deployment.json', previewDeployment);

    await this.emit(
      EventType.ArtifactProduced,
      event.projectId,
      {
        artifactType: 'preview_deployment',
        taskId,
        path: 'artifacts/acceptance/preview-deployment.json',
        summary: (previewDeployment as any).summary ?? 'Preview environment deployed',
      },
      {
        phase,
        correlationId: event.correlationId,
        causationId: event.id,
        metadata: { llm: llmMetadata },
      },
    );

    // Auto-complete — PM will notify user to try the preview
    await this.taskService.transitionTask(
      event.projectId,
      taskId,
      TaskStatus.Done,
      'Preview environment deployed',
      event.id,
    );

    this.logger.info({ taskId }, 'Preview environment deployment completed');
  }

  /**
   * Trigger 3: Generate production deployment plan.
   * Requires user confirmation.
   */
  private async handleDeploymentTask(event: Event, phase: string, taskId: string, taskDescription: string): Promise<void> {
    this.logger.info({ taskId }, 'Generating production deployment plan');

    await this.taskService.transitionTask(
      event.projectId,
      taskId,
      TaskStatus.InProgress,
      'DevOps preparing deployment plan',
      event.id,
    );

    // Defer the LLM-heavy work to prevent blocking the event dispatch chain
    this.deferWork(() => this.executeDeploymentWork(event, phase, taskId, taskDescription));
  }

  private async executeDeploymentWork(event: Event, phase: string, taskId: string, taskDescription: string): Promise<void> {
    // Load all upstream artifacts
    const prd = await this.artifactStore.load(event.projectId, 'analysis', 'prd.json');
    const designDoc = await this.artifactStore.load(event.projectId, 'design', 'design.json');
    const testReport = await this.artifactStore.load(event.projectId, 'testing', 'test-report.json');
    const acceptanceReport = await this.artifactStore.load(event.projectId, 'acceptance', 'preview-deployment.json');

    let deploymentPlan: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    // Check if a deployment plan already exists → rework mode
    const previousPlan = await this.artifactStore.load<Record<string, unknown>>(
      event.projectId, 'acceptance', 'deployment-plan.json',
    );
    const isRework = previousPlan !== null;

    if (isRework) {
      this.logger.info({ taskId }, 'Previous deployment plan found, entering rework mode');
    }

    if (this.llmService.isEnabled) {
      try {
        const result = isRework
          ? await this.reworkDeploymentPlanWithLLM(previousPlan!, prd, designDoc, taskDescription)
          : await this.generateDeploymentPlanWithLLM(prd, designDoc, testReport, acceptanceReport);
        deploymentPlan = result.data as Record<string, unknown>;
        llmMetadata = {
          source: 'llm',
          model: result.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        };
        this.logger.info({ taskId, model: result.model, rework: isRework }, 'Deployment plan generated via LLM');
      } catch (err) {
        this.logger.warn({ taskId, error: err }, 'LLM failed, using fallback deployment plan');
        deploymentPlan = isRework
          ? this.reworkFallbackDeploymentPlan(previousPlan!, taskDescription)
          : this.generateFallbackDeploymentPlan(designDoc);
      }
    } else {
      deploymentPlan = isRework
        ? this.reworkFallbackDeploymentPlan(previousPlan!, taskDescription)
        : this.generateFallbackDeploymentPlan(designDoc);
    }

    await this.artifactStore.save(event.projectId, 'acceptance', 'deployment-plan.json', deploymentPlan);

    await this.emit(
      EventType.ArtifactProduced,
      event.projectId,
      {
        artifactType: 'deployment_plan',
        taskId,
        path: 'artifacts/acceptance/deployment-plan.json',
        summary: (deploymentPlan as any).summary ?? 'Production deployment plan',
      },
      {
        phase,
        correlationId: event.correlationId,
        causationId: event.id,
        metadata: { llm: llmMetadata },
      },
    );

    // Needs user confirmation
    await this.taskService.transitionTask(
      event.projectId,
      taskId,
      TaskStatus.InReview,
      'Deployment plan produced, awaiting review',
      event.id,
    );

    this.logger.info({ taskId }, 'Deployment plan produced and submitted for review');
  }

  // --- LLM generation ---

  private async generateEnvConfigWithLLM(designDoc: unknown, integrationReport: unknown) {
    const systemPrompt = this.llmService.loadPrompt('devops', 'system');
    const userPrompt = this.llmService.loadPrompt('devops', 'generate-env-config', {
      designDoc: JSON.stringify(designDoc, null, 2),
      integrationReport: JSON.stringify(integrationReport, null, 2),
    });

    return this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: envConfigSchema,
    });
  }

  private async generateDeploymentPlanWithLLM(
    prd: unknown,
    designDoc: unknown,
    testReport: unknown,
    acceptanceReport: unknown,
  ) {
    const systemPrompt = this.llmService.loadPrompt('devops', 'system');
    const userPrompt = this.llmService.loadPrompt('devops', 'generate-deployment-plan', {
      prd: JSON.stringify(prd, null, 2),
      designDoc: JSON.stringify(designDoc, null, 2),
      testReport: JSON.stringify(testReport, null, 2),
      acceptanceReport: JSON.stringify(acceptanceReport, null, 2),
    });

    return this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: deploymentPlanSchema,
    });
  }

  private async reworkDeploymentPlanWithLLM(
    previousPlan: Record<string, unknown>,
    prd: unknown,
    designDoc: unknown,
    feedback: string,
  ) {
    const systemPrompt = this.llmService.loadPrompt('devops', 'system');
    const userPrompt = this.llmService.loadPrompt('devops', 'rework-deployment-plan', {
      previousPlan: JSON.stringify(previousPlan, null, 2),
      feedback,
      prd: JSON.stringify(prd, null, 2),
      designDoc: JSON.stringify(designDoc, null, 2),
    });

    return this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: deploymentPlanSchema,
    });
  }

  private async generatePreviewDeploymentWithLLM(
    designDoc: unknown,
    integrationReport: unknown,
    previousDeployment: Record<string, unknown> | null,
    acceptanceFix: unknown,
  ) {
    const systemPrompt = this.llmService.loadPrompt('devops', 'system');
    const userPrompt = this.llmService.loadPrompt('devops', 'generate-preview-deployment', {
      designDoc: JSON.stringify(designDoc, null, 2),
      integrationReport: JSON.stringify(integrationReport, null, 2),
      ...(previousDeployment ? { previousDeployment: JSON.stringify(previousDeployment, null, 2) } : {}),
      ...(acceptanceFix ? { acceptanceFix: JSON.stringify(acceptanceFix, null, 2) } : {}),
    });

    return this.llmService.generateStructuredOutput({
      systemPrompt,
      userPrompt,
      schema: previewDeploymentSchema,
    });
  }

  // --- Fallback generators ---

  private generateFallbackPreviewDeployment(designDoc: unknown, isRework: boolean, projectId: string): Record<string, unknown> {
    const design = designDoc as Record<string, any> | null;
    const techStack = design?.techStack ?? {};
    const previewUrl = `http://localhost:${this.serverPort}/preview/${projectId}/`;

    return {
      previewUrl,
      environment: 'preview',
      services: [
        { name: 'application', status: 'running', port: this.serverPort },
      ],
      deployedAt: new Date().toISOString(),
      buildInfo: {
        version: isRework ? '1.0.1-preview' : '1.0.0-preview',
        modules: design?.components?.map((c: any) => c.name) ?? ['main'],
      },
      summary: `预览环境${isRework ? '已更新' : '已部署'}(模板生成) — 访问 ${previewUrl} 试用系统。技术栈: ${techStack.runtime ?? 'Node.js'}`,
    };
  }

  private generateFallbackEnvConfig(designDoc: unknown): Record<string, unknown> {
    const design = designDoc as Record<string, any> | null;
    const techStack = design?.techStack ?? {};

    return {
      environment: 'test',
      services: [
        {
          name: 'application',
          type: techStack.runtime ?? 'node',
          config: { port: 3000, logLevel: 'debug' },
        },
        {
          name: 'database',
          type: techStack.database ?? 'sqlite',
          config: { inMemory: true },
        },
      ],
      dependencies: [
        { name: 'runtime', version: 'latest', purpose: 'Application runtime' },
        { name: 'test-framework', version: 'latest', purpose: 'Test execution' },
      ],
      configuration: {
        runtime: techStack.runtime ?? 'Node.js 20',
        database: techStack.database ?? 'SQLite (in-memory for testing)',
      },
      summary: '测试环境配置(模板生成) — 包含应用服务和数据库服务配置',
    };
  }

  private generateFallbackDeploymentPlan(designDoc: unknown): Record<string, unknown> {
    const design = designDoc as Record<string, any> | null;
    const techStack = design?.techStack ?? {};

    return {
      environment: 'production',
      strategy: 'rolling-update',
      steps: [
        { order: 1, name: '预检查', description: '验证所有测试通过，检查依赖版本兼容性', automated: true },
        { order: 2, name: '数据库迁移', description: '执行数据库schema变更（如有）', automated: true },
        { order: 3, name: '构建部署包', description: '编译代码，生成生产构建产物', automated: true },
        { order: 4, name: '滚动部署', description: '逐步替换旧版本实例，确保零停机', automated: true },
        { order: 5, name: '健康检查', description: '验证所有服务实例健康运行', automated: true },
        { order: 6, name: '冒烟测试', description: '运行核心功能冒烟测试验证', automated: true },
      ],
      rollbackPlan: {
        trigger: '健康检查失败或冒烟测试未通过时自动触发回滚',
        steps: [
          '停止新版本部署',
          '回退至上一稳定版本',
          '验证回退后服务健康',
          '通知相关人员',
        ],
      },
      monitoring: {
        healthChecks: ['/health', '/api/status'],
        alerts: ['错误率 > 1%', '响应时间 > 2s', 'CPU > 80%'],
        dashboards: ['应用性能监控', '错误日志', '资源使用率'],
      },
      risks: [
        { description: '数据库迁移可能导致短暂性能下降', severity: 'low' as const, mitigation: '在低峰期执行迁移' },
        { description: '新版本可能引入未发现的兼容性问题', severity: 'medium' as const, mitigation: '金丝雀发布，先部署10%流量' },
      ],
      summary: `部署计划(模板生成) — 采用滚动更新策略，6步部署流程，包含回滚方案和监控配置。技术栈: ${techStack.runtime ?? 'Node.js'}`,
    };
  }

  private reworkFallbackDeploymentPlan(
    previousPlan: Record<string, unknown>,
    feedback: string,
  ): Record<string, unknown> {
    const prev = previousPlan as any;
    return {
      ...previousPlan,
      summary: `${prev.summary ?? '部署计划'} [已修订: ${feedback}]`,
    };
  }
}
