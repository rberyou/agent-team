import { z } from 'zod/v4';
import { BaseAgent } from '../base-agent.js';
import { EventBus } from '../../core/event-bus/index.js';
import { TaskService } from '../../services/task-service.js';
import { ProjectService } from '../../services/project-service.js';
import { ArtifactStore } from '../../core/persistence/index.js';
import { LLMService } from '../../core/llm/index.js';
import {
  EventType,
  AgentRole,
  TaskStatus,
  PhaseName,
} from '../../core/models/index.js';
import type { Event, Task } from '../../core/models/index.js';
import { SubAgent } from './sub-agent.js';

// Zod schema for Design document validation
const designSchema = z.object({
  projectName: z.string(),
  version: z.string().default('1.0'),
  techStack: z.object({
    frontend: z.array(z.object({ name: z.string(), reason: z.string() })).default([]),
    backend: z.array(z.object({ name: z.string(), reason: z.string() })).default([]),
    database: z.array(z.object({ name: z.string(), reason: z.string() })).default([]),
    infrastructure: z.array(z.object({ name: z.string(), reason: z.string() })).default([]),
  }),
  architecture: z.object({
    pattern: z.string(),
    description: z.string(),
    components: z.array(z.object({
      name: z.string(),
      responsibility: z.string(),
      interfaces: z.array(z.string()).default([]),
    })).default([]),
    dataModels: z.array(z.object({
      name: z.string(),
      fields: z.array(z.object({
        name: z.string(),
        type: z.string(),
        description: z.string().default(''),
      })).default([]),
      relationships: z.array(z.string()).default([]),
    })).default([]),
  }),
  apiSpec: z.object({
    baseUrl: z.string().default('/api'),
    endpoints: z.array(z.object({
      method: z.string().transform(v => v.toUpperCase()),
      path: z.string(),
      summary: z.string(),
      requestBody: z.unknown().optional(),
      responseBody: z.unknown().optional(),
    })).default([]),
  }).default({ baseUrl: '/api', endpoints: [] }),
});

// Integration report schema
const integrationReportSchema = z.object({
  result: z.enum(['passed', 'failed']),
  modules: z.array(z.string()),
  issues: z.array(z.object({
    type: z.string(),
    description: z.string(),
    modules: z.array(z.string()),
  })).default([]),
  summary: z.string(),
});

// Zod schema for bug fix artifact validation
const bugfixSchema = z.object({
  targetBugs: z.array(z.object({
    id: z.string(),
    severity: z.string(),
    description: z.string(),
    relatedModule: z.string(),
  })),
  fixes: z.array(z.object({
    bugId: z.string(),
    moduleName: z.string(),
    description: z.string(),
    files: z.array(z.object({
      path: z.string(),
      content: z.string(),
      language: z.string(),
    })),
  })),
  summary: z.string(),
});

// Zod schema for acceptance fix artifact validation
const acceptanceFixSchema = z.object({
  userFeedback: z.string(),
  analysis: z.string(),
  fixes: z.array(z.object({
    moduleName: z.string(),
    description: z.string(),
    files: z.array(z.object({
      path: z.string(),
      content: z.string(),
      language: z.string(),
    })),
  })),
  summary: z.string(),
});

/**
 * Developer Agent.
 *
 * Quadruple role:
 * - Design phase: Architect — generates tech design from PRD
 * - Implementation phase: Dev Lead — splits tasks, manages SubAgents,
 *   handles review results, performs integration verification
 * - Testing phase: Bug Fixer — fixes bugs found by QA, handles review feedback
 * - Acceptance phase: Acceptance Fixer — fixes issues found during user trial
 */
export class DeveloperAgent extends BaseAgent {
  /** Active SubAgent instances keyed by `${projectId}:${subAgentId}` */
  private activeSubAgents: Map<string, SubAgent> = new Map();

  /** Track parent task per project for implementation phase */
  private implementationTasks: Map<string, string> = new Map();

  /** Track bug fix task per project for testing phase */
  private bugFixTasks: Map<string, string> = new Map();

  constructor(
    eventBus: EventBus,
    private readonly taskService: TaskService,
    private readonly artifactStore: ArtifactStore,
    private readonly llmService: LLMService,
    private readonly projectService: ProjectService,
  ) {
    super(AgentRole.Developer, eventBus);
  }

  start(): void {
    this.on(EventType.TaskCreated, (e) => this.handleTaskCreated(e));
    this.on(EventType.ReviewCompleted, (e) => this.handleReviewCompleted(e));
    this.logger.info('Developer Agent started');
  }

  // ──── Task Routing ────

  private async handleTaskCreated(event: Event): Promise<void> {
    const { taskId, assignedTo } = event.payload as {
      taskId: string;
      assignedTo: string;
    };

    if (assignedTo !== AgentRole.Developer) return;

    const task = await this.taskService.getTask(event.projectId, taskId);
    if (!task) {
      this.logger.error({ taskId }, 'Task not found');
      return;
    }

    if (task.phase === PhaseName.Design) {
      await this.handleDesignTask(event, task);
    } else if (task.phase === PhaseName.Implementation) {
      await this.handleImplementationTask(event, task);
    } else if (task.phase === PhaseName.Testing) {
      // Defer bug fix work (LLM-heavy) to prevent blocking event chain
      this.deferWork(() => this.handleBugFixTask(event, task));
    } else if (task.phase === PhaseName.Acceptance) {
      // Defer acceptance fix work (LLM-heavy) to prevent blocking event chain
      this.deferWork(() => this.handleAcceptanceFixTask(event, task));
    }
  }

  // ──── Design Phase (existing logic) ────

  private async handleDesignTask(event: Event, task: Task): Promise<void> {
    const taskId = task.taskId;
    this.logger.info({ taskId }, 'Received task, starting design work');

    await this.taskService.transitionTask(
      event.projectId, taskId, TaskStatus.InProgress,
      'Developer started design work', event.id,
    );

    // Defer the LLM-heavy work to prevent blocking the event dispatch chain
    this.deferWork(() => this.executeDesignWork(event, task));
  }

  private async executeDesignWork(event: Event, task: Task): Promise<void> {
    const taskId = task.taskId;

    await this.emit(
      EventType.AgentThinking,
      event.projectId,
      { taskId, message: 'Analyzing PRD for design' },
      { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
    );

    const prd = await this.artifactStore.load<Record<string, unknown>>(
      event.projectId, 'analysis', 'prd.json',
    );
    if (!prd) {
      this.logger.warn({ projectId: event.projectId }, 'PRD not found, using empty PRD for fallback');
    }

    let designDoc: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    // Check if a design doc already exists → rework mode
    const previousDesign = await this.artifactStore.load<Record<string, unknown>>(
      event.projectId, 'design', 'design.json',
    );
    const isRework = previousDesign !== null;

    if (isRework) {
      this.logger.info({ taskId }, 'Previous design found, entering rework mode');
      await this.emit(
        EventType.AgentWorking,
        event.projectId,
        { taskId, message: 'Revising design based on feedback' },
        { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
      );
    } else {
      await this.emit(
        EventType.AgentWorking,
        event.projectId,
        { taskId, message: 'Generating technical design document' },
        { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
      );
    }

    if (this.llmService.isEnabled) {
      try {
        const result = isRework
          ? await this.reworkDesignWithLLM(previousDesign!, prd ?? {}, task.description)
          : await this.generateDesignWithLLM(prd ?? {});
        designDoc = result.data as Record<string, unknown>;
        llmMetadata = {
          source: 'llm',
          model: result.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        };
        this.logger.info({ taskId, model: result.model, rework: isRework }, 'Design generated via LLM');
      } catch (err) {
        this.logger.warn({ taskId, error: err }, 'LLM call failed, falling back to template');
        designDoc = isRework
          ? this.reworkFallbackDesign(previousDesign!, task.description)
          : this.generateFallbackDesign(prd ?? {});
      }
    } else {
      designDoc = isRework
        ? this.reworkFallbackDesign(previousDesign!, task.description)
        : this.generateFallbackDesign(prd ?? {});
    }

    await this.artifactStore.save(event.projectId, 'design', 'design.json', designDoc);

    await this.emit(
      EventType.AgentWorking,
      event.projectId,
      { taskId, message: 'Saving design artifact' },
      { phase: task.phase, correlationId: event.correlationId, causationId: event.id },
    );

    await this.emit(EventType.ArtifactProduced, event.projectId, {
      artifactType: 'design', taskId,
      path: 'artifacts/design/design.json',
      summary: (designDoc as any).projectName ?? task.title,
    }, {
      phase: task.phase,
      correlationId: event.correlationId,
      causationId: event.id,
      metadata: { llm: llmMetadata },
    });

    await this.taskService.transitionTask(
      event.projectId, taskId, TaskStatus.InReview,
      'Design document produced, awaiting review', event.id,
    );

    this.logger.info({ taskId }, 'Design document produced and submitted for review');
  }

  // ──── Implementation Phase ────

  private async handleImplementationTask(event: Event, task: Task): Promise<void> {
    const taskId = task.taskId;
    this.logger.info({ taskId }, 'Received implementation task, splitting into subtasks');

    this.implementationTasks.set(event.projectId, taskId);

    await this.taskService.transitionTask(
      event.projectId, taskId, TaskStatus.InProgress,
      'Developer started task splitting', event.id,
    );

    await this.emit(
      EventType.AgentThinking,
      event.projectId,
      { taskId, message: 'Analyzing design document' },
      { phase: task.phase, causationId: event.id },
    );

    // Load design document
    const designDoc = await this.artifactStore.load<Record<string, unknown>>(
      event.projectId, 'design', 'design.json',
    );

    if (!designDoc) {
      this.logger.error({ projectId: event.projectId }, 'Design document not found');
      return;
    }

    // Extract components from design
    const architecture = (designDoc as any).architecture;
    const components: Array<{ name: string; responsibility: string; interfaces: string[] }> =
      architecture?.components ?? [];

    if (components.length === 0) {
      this.logger.warn('No components in design, using minimal split');
      components.push({
        name: 'core',
        responsibility: '核心业务逻辑实现',
        interfaces: [],
      });
    }

    const subTaskIds: string[] = [];
    // Collect setup info so we can start SubAgents AFTER all tasks are created.
    const pendingSubAgents: Array<{
      subAgentId: string;
      component: { name: string; responsibility: string; interfaces: string[] };
      subTaskId: string;
    }> = [];

    for (const component of components) {
      const subAgentId = `subagent_${component.name.toLowerCase().replace(/\s+/g, '-')}`;

      // 1. Create SubTask (no SubAgent listening yet → no chain fires)
      const subTask = await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Implementation,
        title: `模块开发: ${component.name}`,
        description: `实现 ${component.name} 模块: ${component.responsibility}`,
        assignedTo: subAgentId,
        priority: 'high',
      });

      await this.taskService.updateTask(event.projectId, subTask.taskId, {
        parentTask: taskId,
      });
      subTaskIds.push(subTask.taskId);

      // Update parent's subTasks incrementally
      await this.taskService.updateTask(event.projectId, taskId, {
        subTasks: [...subTaskIds],
      });

      // 2. Create Review Task (blocked by subTask)
      const reviewTask = await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Implementation,
        title: `代码审查: ${component.name}`,
        description: `审查 ${component.name} 模块代码`,
        assignedTo: AgentRole.CodeReviewer,
        priority: 'high',
      });

      await this.taskService.updateTask(event.projectId, reviewTask.taskId, {
        blockedBy: [subTask.taskId],
      });
      await this.taskService.transitionTask(
        event.projectId, reviewTask.taskId, TaskStatus.Blocked,
        `Waiting for ${component.name} module development to complete`,
      );

      pendingSubAgents.push({ subAgentId, component, subTaskId: subTask.taskId });

      this.logger.info({
        subAgentId,
        moduleName: component.name,
        subTaskId: subTask.taskId,
        reviewTaskId: reviewTask.taskId,
      }, 'SubAgent created and task assigned');
    }

    await this.emit(
      EventType.AgentWorking,
      event.projectId,
      { taskId, message: `Splitting into ${components.length} module tasks` },
      { phase: task.phase, causationId: event.id },
    );

    // 3. Now start all SubAgents and tell them to work.
    // All tasks and review tasks are fully set up, so the event chain is safe.
    for (const { subAgentId, component, subTaskId } of pendingSubAgents) {
      const subAgent = new SubAgent(
        subAgentId,
        component.name,
        component as Record<string, unknown>,
        this.eventBus,
        this.taskService,
        this.artifactStore,
        this.llmService,
        event.projectId,
      );
      subAgent.start();
      this.activeSubAgents.set(`${event.projectId}:${subAgentId}`, subAgent);

      await subAgent.beginWork(subTaskId);
    }

    // Emit task breakdown artifact
    await this.emit(EventType.ArtifactProduced, event.projectId, {
      artifactType: 'task_breakdown',
      taskId,
      modules: components.map(c => c.name),
      subTaskCount: components.length,
    }, {
      phase: PhaseName.Implementation,
      causationId: event.id,
    });

    this.logger.info({ taskId, subTaskCount: components.length }, 'Implementation tasks split');
  }

  // ──── Review Result Handling ────

  private async handleReviewCompleted(event: Event): Promise<void> {
    const { result, subTaskId, feedback } = event.payload as {
      result: string;
      subTaskId: string;
      reviewTaskId: string;
      feedback?: string;
    };

    const subTask = await this.taskService.getTask(event.projectId, subTaskId);
    if (!subTask) return;

    // Check if this is a Testing-phase bug fix review
    if (subTask.phase === PhaseName.Testing && this.bugFixTasks.get(event.projectId) === subTaskId) {
      if (result === 'passed') {
        await this.handleBugFixReviewPassed(event, subTaskId);
      } else if (result === 'rejected') {
        await this.handleBugFixReviewRejected(event, subTaskId, subTask, feedback ?? '');
      }
      return;
    }

    // Implementation phase: verify this is for a SubTask we manage
    if (!subTask.parentTask) return;

    const parentTaskId = this.implementationTasks.get(event.projectId);
    if (subTask.parentTask !== parentTaskId) return;

    if (result === 'passed') {
      this.logger.info({ subTaskId }, 'Review passed');

      // Mark SubTask as approved and done
      await this.taskService.updateTask(event.projectId, subTaskId, {
        reviewStatus: 'approved',
      });
      // Transition SubTask from in_review to done
      await this.taskService.transitionTask(
        event.projectId, subTaskId, TaskStatus.Done,
        'Code review passed', event.id,
      );

      // Check if all SubTasks are done
      await this.checkAllSubTasksCompleted(event.projectId, parentTaskId!);

    } else if (result === 'rejected') {
      const currentRounds = (subTask.reviewRounds ?? 0) + 1;
      this.logger.info({ subTaskId, reviewRounds: currentRounds }, 'Review rejected');

      // Update review rounds
      await this.taskService.updateTask(event.projectId, subTaskId, {
        reviewStatus: 'rejected',
        reviewRounds: currentRounds,
      });

      // Check retry limit
      const project = await this.projectService.getProject(event.projectId);
      const maxRetry = project?.config?.maxRetryOnFailure ?? 3;

      if (currentRounds >= maxRetry) {
        this.logger.error({ subTaskId, reviewRounds: currentRounds, maxRetry }, 'Max review rounds exceeded');
        await this.taskService.transitionTask(
          event.projectId, subTaskId, TaskStatus.Cancelled,
          `Exceeded max review rounds (${maxRetry})`, event.id,
        );
      } else {
        // Create a new review task for the next round (blocked)
        const moduleName = subTask.title.replace('模块开发: ', '');
        const newReviewTask = await this.taskService.createTask({
          projectId: event.projectId,
          phase: PhaseName.Implementation,
          title: `代码审查: ${moduleName} (Round ${currentRounds + 1})`,
          description: `审查 ${moduleName} 模块代码 (第${currentRounds + 1}轮)`,
          assignedTo: AgentRole.CodeReviewer,
          priority: 'high',
        });

        await this.taskService.updateTask(event.projectId, newReviewTask.taskId, {
          blockedBy: [subTaskId],
        });
        await this.taskService.transitionTask(
          event.projectId, newReviewTask.taskId, TaskStatus.Blocked,
          `Waiting for ${moduleName} rework`,
        );

        // SubAgent will pick up the ReviewCompleted(rejected) event and rework automatically
        // It then emits ArtifactProduced(code), which PM unblocks the new review task
      }
    }
  }

  // ──── Integration Verification ────

  private async checkAllSubTasksCompleted(projectId: string, parentTaskId: string): Promise<void> {
    // Query all subtasks dynamically — we cannot rely on parentTask.subTasks
    // because the review chain may complete synchronously before the array is persisted.
    const allTasks = await this.taskService.listTasksByPhase(projectId, PhaseName.Implementation);
    const subTasks = allTasks.filter((t) => t.parentTask === parentTaskId);

    if (subTasks.length === 0) return;

    // Check all SubTasks are done with approved review
    const allApproved = subTasks.every(
      (st) => st.status === TaskStatus.Done && st.reviewStatus === 'approved',
    );

    if (!allApproved) return;

    this.logger.info({ parentTaskId, subTaskCount: subTasks.length }, 'All SubTasks approved, running integration verification');

    await this.performIntegrationVerification(projectId, parentTaskId, subTasks.map((t) => t.taskId));
  }

  private async performIntegrationVerification(
    projectId: string,
    parentTaskId: string,
    subTaskIds: string[],
  ): Promise<void> {
    await this.emit(
      EventType.AgentWorking,
      projectId,
      { taskId: parentTaskId, message: 'Running integration verification' },
      { phase: PhaseName.Implementation },
    );

    // Collect module names and their code artifacts
    const modules: string[] = [];
    const codeArtifacts: Record<string, unknown>[] = [];

    for (const stId of subTaskIds) {
      const st = await this.taskService.getTask(projectId, stId);
      if (!st) continue;
      const moduleName = st.title.replace('模块开发: ', '');
      modules.push(moduleName);

      const code = await this.artifactStore.load<Record<string, unknown>>(
        projectId, 'implementation', `${moduleName}/code.json`,
      );
      if (code) codeArtifacts.push(code);
    }

    let report: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    if (this.llmService.isEnabled) {
      try {
        const result = await this.generateIntegrationReportWithLLM(modules, codeArtifacts);
        report = result.data as Record<string, unknown>;
        llmMetadata = {
          source: 'llm',
          model: result.model,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        };
      } catch (err) {
        this.logger.warn({ error: err }, 'LLM integration check failed, using fallback');
        report = this.generateFallbackIntegrationReport(modules);
      }
    } else {
      report = this.generateFallbackIntegrationReport(modules);
    }

    // Save integration report
    await this.artifactStore.save(projectId, 'implementation', 'integration-report.json', report);

    // Extract real source files from code artifacts to output directory
    try {
      const extractResult = await this.artifactStore.extractCodeFiles(projectId);
      this.logger.info({ projectId, filesWritten: extractResult.filesWritten, errors: extractResult.errors }, 'Code files extracted to output directory');
    } catch (err) {
      this.logger.warn({ projectId, error: err }, 'Failed to extract code files');
    }

    await this.emit(EventType.ArtifactProduced, projectId, {
      artifactType: 'integration_report',
      taskId: parentTaskId,
      path: 'artifacts/implementation/integration-report.json',
      result: (report as any).result,
      modules,
    }, {
      phase: PhaseName.Implementation,
      metadata: { llm: llmMetadata },
    });

    // Cleanup SubAgents
    this.cleanupSubAgents(projectId);

    // Complete the parent implementation task
    await this.taskService.transitionTask(
      projectId, parentTaskId, TaskStatus.Done,
      `Integration verification ${(report as any).result}: ${(report as any).summary}`,
    );

    this.logger.info({ parentTaskId, result: (report as any).result }, 'Implementation completed');
  }

  // ──── Testing Phase: Bug Fix ────

  private async handleBugFixTask(event: Event, task: Task): Promise<void> {
    const { taskId, projectId } = task;
    this.bugFixTasks.set(projectId, taskId);

    this.logger.info({ taskId, projectId }, 'Received bug fix task');

    await this.taskService.transitionTask(
      projectId, taskId, TaskStatus.InProgress,
      'Developer started bug fix', event.id,
    );

    await this.emit(
      EventType.AgentThinking,
      projectId,
      { taskId, message: 'Analyzing test report and bug details' },
      { phase: task.phase, causationId: event.id },
    );

    // Load upstream artifacts
    const testReport = await this.artifactStore.load<Record<string, unknown>>(
      projectId, 'testing', 'test-report.json',
    );
    const designDoc = await this.artifactStore.load<Record<string, unknown>>(
      projectId, 'design', 'design.json',
    );

    // Load all code artifacts from implementation
    const codeArtifacts = await this.loadCodeArtifacts(projectId, designDoc);

    let bugfix: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    if (this.llmService.isEnabled) {
      try {
        const result = await this.generateBugFixWithLLM(
          testReport ?? {}, designDoc ?? {}, codeArtifacts,
        );
        bugfix = result.data as Record<string, unknown>;
        llmMetadata = {
          source: 'llm',
          model: result.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        };
        this.logger.info({ taskId, model: result.model }, 'Bug fix generated via LLM');
      } catch (err) {
        this.logger.warn({ taskId, error: err }, 'LLM call failed, falling back to template');
        bugfix = this.generateFallbackBugFix(testReport ?? {});
      }
    } else {
      bugfix = this.generateFallbackBugFix(testReport ?? {});
    }

    // Save bugfix artifact
    await this.artifactStore.save(projectId, 'testing', 'bugfix.json', bugfix);

    await this.emit(
      EventType.AgentWorking,
      projectId,
      { taskId, message: 'Saving bugfix artifact' },
      { phase: task.phase, causationId: event.id },
    );

    // Transition to in_review BEFORE emitting artifact.produced
    await this.taskService.transitionTask(
      projectId, taskId, TaskStatus.InReview,
      'Bug fix produced, awaiting review', event.id,
    );

    // Emit artifact.produced(bugfix) → PM will unblock review task
    await this.emit(
      EventType.ArtifactProduced,
      projectId,
      {
        artifactType: 'bugfix',
        taskId,
        path: 'artifacts/testing/bugfix.json',
        summary: (bugfix as any).summary ?? 'Bug修复方案',
      },
      {
        phase: PhaseName.Testing,
        correlationId: event.correlationId,
        causationId: event.id,
        metadata: { llm: llmMetadata },
      },
    );

    this.logger.info({ taskId }, 'Bug fix submitted for review');
  }

  private async handleBugFixReviewPassed(event: Event, bugFixTaskId: string): Promise<void> {
    this.logger.info({ bugFixTaskId }, 'Bug fix review passed');

    await this.taskService.updateTask(event.projectId, bugFixTaskId, {
      reviewStatus: 'approved',
    });
    await this.taskService.transitionTask(
      event.projectId, bugFixTaskId, TaskStatus.Done,
      'Bug fix review passed', event.id,
    );
    this.bugFixTasks.delete(event.projectId);
  }

  private async handleBugFixReviewRejected(
    event: Event,
    bugFixTaskId: string,
    subTask: Task,
    feedback: string,
  ): Promise<void> {
    const currentRounds = (subTask.reviewRounds ?? 0) + 1;
    this.logger.info({ bugFixTaskId, reviewRounds: currentRounds }, 'Bug fix review rejected');

    await this.taskService.updateTask(event.projectId, bugFixTaskId, {
      reviewStatus: 'rejected',
      reviewRounds: currentRounds,
    });

    const project = await this.projectService.getProject(event.projectId);
    const maxRetry = project?.config?.maxRetryOnFailure ?? 3;

    if (currentRounds >= maxRetry) {
      this.logger.error({ bugFixTaskId, currentRounds, maxRetry }, 'Max bug fix review rounds exceeded');
      await this.taskService.transitionTask(
        event.projectId, bugFixTaskId, TaskStatus.Cancelled,
        `Exceeded max review rounds (${maxRetry})`, event.id,
      );
      this.bugFixTasks.delete(event.projectId);
    } else {
      // Create new blocked review task for next round
      const newReviewTask = await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Testing,
        title: `Bug修复代码审查 (Round ${currentRounds + 1})`,
        description: `审查Bug修复代码 (第${currentRounds + 1}轮)`,
        assignedTo: AgentRole.CodeReviewer,
        priority: 'high',
      });

      await this.taskService.updateTask(event.projectId, newReviewTask.taskId, {
        blockedBy: [bugFixTaskId],
      });
      await this.taskService.transitionTask(
        event.projectId, newReviewTask.taskId, TaskStatus.Blocked,
        `Waiting for bug fix rework`,
      );

      // Defer the rework to prevent blocking the event dispatch chain
      this.deferWork(() => this.reworkBugFix(event, bugFixTaskId, feedback));
    }
  }

  private async reworkBugFix(
    event: Event,
    bugFixTaskId: string,
    feedback: string,
  ): Promise<void> {
    const projectId = event.projectId;

    await this.taskService.transitionTask(
      projectId, bugFixTaskId, TaskStatus.InProgress,
      'Reworking bug fix based on review feedback', event.id,
    );

    const previousFix = await this.artifactStore.load<Record<string, unknown>>(
      projectId, 'testing', 'bugfix.json',
    );
    const testReport = await this.artifactStore.load<Record<string, unknown>>(
      projectId, 'testing', 'test-report.json',
    );
    const designDoc = await this.artifactStore.load<Record<string, unknown>>(
      projectId, 'design', 'design.json',
    );

    let bugfix: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    if (this.llmService.isEnabled) {
      try {
        const result = await this.reworkBugFixWithLLM(
          previousFix ?? {}, testReport ?? {}, feedback, designDoc ?? {},
        );
        bugfix = result.data as Record<string, unknown>;
        llmMetadata = {
          source: 'llm',
          model: result.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        };
      } catch (err) {
        this.logger.warn({ bugFixTaskId, error: err }, 'LLM rework failed, using fallback');
        bugfix = this.reworkFallbackBugFix(previousFix ?? {}, feedback);
      }
    } else {
      bugfix = this.reworkFallbackBugFix(previousFix ?? {}, feedback);
    }

    await this.artifactStore.save(projectId, 'testing', 'bugfix.json', bugfix);

    await this.taskService.transitionTask(
      projectId, bugFixTaskId, TaskStatus.InReview,
      'Bug fix reworked, awaiting review', event.id,
    );

    await this.emit(
      EventType.ArtifactProduced,
      projectId,
      {
        artifactType: 'bugfix',
        taskId: bugFixTaskId,
        path: 'artifacts/testing/bugfix.json',
        summary: (bugfix as any).summary ?? 'Bug修复方案（已修订）',
      },
      {
        phase: PhaseName.Testing,
        correlationId: event.correlationId,
        causationId: event.id,
        metadata: { llm: llmMetadata },
      },
    );
  }

  private async loadCodeArtifacts(
    projectId: string,
    designDoc: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>[]> {
    const artifacts: Record<string, unknown>[] = [];
    const components = (designDoc as any)?.architecture?.components ?? [];

    for (const comp of components) {
      const code = await this.artifactStore.load<Record<string, unknown>>(
        projectId, 'implementation', `${comp.name}/code.json`,
      );
      if (code) artifacts.push(code);
    }

    return artifacts;
  }

  // ──── SubAgent Lifecycle ────

  private cleanupSubAgents(projectId: string): void {
    for (const [key, agent] of this.activeSubAgents) {
      if (key.startsWith(`${projectId}:`)) {
        agent.stop();
        this.activeSubAgents.delete(key);
      }
    }
    this.implementationTasks.delete(projectId);
    this.logger.info({ projectId }, 'SubAgents cleaned up');
  }

  // ──── Acceptance Phase: User Feedback Fix ────

  private async handleAcceptanceFixTask(event: Event, task: Task): Promise<void> {
    const { taskId, projectId } = task;

    this.logger.info({ taskId, projectId }, 'Received acceptance fix task');

    await this.taskService.transitionTask(
      projectId, taskId, TaskStatus.InProgress,
      'Developer started acceptance fix', event.id,
    );

    await this.emit(
      EventType.AgentThinking,
      projectId,
      { taskId, message: 'Analyzing user feedback and code' },
      { phase: task.phase, causationId: event.id },
    );

    // Load upstream artifacts
    const previewDeployment = await this.artifactStore.load<Record<string, unknown>>(
      projectId, 'acceptance', 'preview-deployment.json',
    );
    const designDoc = await this.artifactStore.load<Record<string, unknown>>(
      projectId, 'design', 'design.json',
    );
    const codeArtifacts = await this.loadCodeArtifacts(projectId, designDoc);

    // Extract user feedback from task description
    const feedbackMatch = task.description.match(/用户试用反馈修复问题:\n\n([\s\S]+)/);
    const userFeedback = feedbackMatch?.[1] ?? task.description;

    // Check for previous fix → rework mode
    const previousFix = await this.artifactStore.load<Record<string, unknown>>(
      projectId, 'acceptance', 'acceptance-fix.json',
    );
    const isRework = previousFix !== null;

    if (isRework) {
      this.logger.info({ taskId }, 'Previous acceptance fix found, entering rework mode');
    }

    let fix: Record<string, unknown>;
    let llmMetadata: Record<string, unknown> = { source: 'fallback' };

    if (this.llmService.isEnabled) {
      try {
        const result = isRework
          ? await this.reworkAcceptanceFixWithLLM(previousFix!, userFeedback, designDoc ?? {})
          : await this.generateAcceptanceFixWithLLM(userFeedback, previewDeployment ?? {}, designDoc ?? {}, codeArtifacts);
        fix = result.data as Record<string, unknown>;
        llmMetadata = {
          source: 'llm',
          model: result.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        };
        this.logger.info({ taskId, model: result.model, rework: isRework }, 'Acceptance fix generated via LLM');
      } catch (err) {
        this.logger.warn({ taskId, error: err }, 'LLM call failed, falling back to template');
        fix = isRework
          ? this.reworkFallbackAcceptanceFix(previousFix!, userFeedback)
          : this.generateFallbackAcceptanceFix(userFeedback);
      }
    } else {
      fix = isRework
        ? this.reworkFallbackAcceptanceFix(previousFix!, userFeedback)
        : this.generateFallbackAcceptanceFix(userFeedback);
    }

    // Save acceptance fix artifact
    await this.artifactStore.save(projectId, 'acceptance', 'acceptance-fix.json', fix);

    // Emit artifact.produced(acceptance_fix)
    await this.emit(
      EventType.ArtifactProduced,
      projectId,
      {
        artifactType: 'acceptance_fix',
        taskId,
        path: 'artifacts/acceptance/acceptance-fix.json',
        summary: (fix as any).summary ?? '验收修复方案',
      },
      {
        phase: PhaseName.Acceptance,
        correlationId: event.correlationId,
        causationId: event.id,
        metadata: { llm: llmMetadata },
      },
    );

    // Directly transition to Done — no Code Review, user validates via preview
    await this.taskService.transitionTask(
      projectId, taskId, TaskStatus.Done,
      'Acceptance fix completed', event.id,
    );

    this.logger.info({ taskId }, 'Acceptance fix completed');
  }

  // ──── LLM Generation Methods ────

  private async generateDesignWithLLM(prd: Record<string, unknown>) {
    const systemPrompt = this.llmService.loadPrompt('developer', 'system');
    const userPrompt = this.llmService.loadPrompt('developer', 'generate-design', {
      prd: JSON.stringify(prd, null, 2),
    });
    return this.llmService.generateStructuredOutput({
      systemPrompt, userPrompt, schema: designSchema,
    });
  }

  private async reworkDesignWithLLM(
    previousDesign: Record<string, unknown>,
    prd: Record<string, unknown>,
    feedback: string,
  ) {
    const systemPrompt = this.llmService.loadPrompt('developer', 'system');
    const userPrompt = this.llmService.loadPrompt('developer', 'rework-design', {
      previousDesign: JSON.stringify(previousDesign, null, 2),
      feedback,
      prd: JSON.stringify(prd, null, 2),
    });
    return this.llmService.generateStructuredOutput({
      systemPrompt, userPrompt, schema: designSchema,
    });
  }

  private async generateIntegrationReportWithLLM(
    modules: string[],
    codeArtifacts: Record<string, unknown>[],
  ) {
    const systemPrompt = this.llmService.loadPrompt('developer', 'system');
    const userPrompt = this.llmService.loadPrompt('developer', 'integration-verify', {
      modules: JSON.stringify(modules, null, 2),
      codeArtifacts: JSON.stringify(codeArtifacts, null, 2),
    });
    return this.llmService.generateStructuredOutput({
      systemPrompt, userPrompt, schema: integrationReportSchema,
    });
  }

  // ──── Fallback Generators ────

  private generateFallbackDesign(prd: Record<string, unknown>): Record<string, unknown> {
    const features = (prd as any).features ?? [];
    const modules = (prd as any).modules ?? [];
    const title = (prd as any).title ?? '未命名项目';

    const components = modules.length > 0
      ? modules.map((m: any) => ({
          name: m.name,
          responsibility: m.description ?? `负责${m.name}相关功能`,
          interfaces: (m.relatedFeatures ?? []).map((f: string) => `${f} 相关接口`),
        }))
      : [
          { name: 'core-business', responsibility: '处理核心业务逻辑', interfaces: ['REST API'] },
          { name: 'data-access', responsibility: '数据持久化与查询', interfaces: ['数据库操作接口'] },
        ];

    const endpoints = features.map((f: any, i: number) => ({
      method: 'POST' as const,
      path: `/${(f.name ?? `feature-${i + 1}`).toLowerCase().replace(/\s+/g, '-')}`,
      summary: f.description ?? f.name ?? `功能 ${i + 1}`,
    }));

    const dataModels = modules.map((m: any) => ({
      name: m.name,
      fields: [
        { name: 'id', type: 'string', description: '唯一标识符' },
        { name: 'createdAt', type: 'datetime', description: '创建时间' },
        { name: 'updatedAt', type: 'datetime', description: '更新时间' },
      ],
      relationships: [],
    }));

    return {
      projectName: title,
      version: '1.0',
      techStack: {
        frontend: [],
        backend: [{ name: 'Node.js + TypeScript', reason: '类型安全、生态丰富' }],
        database: [{ name: 'SQLite', reason: 'MVP 阶段轻量级方案，无需额外部署' }],
        infrastructure: [],
      },
      architecture: {
        pattern: '分层架构',
        description: `${title} 采用经典的分层架构模式，分为 API 层、业务逻辑层和数据访问层。`,
        components,
        dataModels,
      },
      apiSpec: {
        baseUrl: '/api',
        endpoints: endpoints.length > 0 ? endpoints : [
          { method: 'GET', path: '/health', summary: '健康检查接口' },
        ],
      },
      assumptions: [
        '设计文档为模板生成（LLM未配置），建议配置LLM以获得更精准的架构设计',
      ],
    };
  }

  private reworkFallbackDesign(
    previousDesign: Record<string, unknown>,
    feedback: string,
  ): Record<string, unknown> {
    const prev = previousDesign as any;
    const existingAssumptions: string[] = prev.assumptions ?? [];
    return {
      ...previousDesign,
      version: `${parseFloat(prev.version ?? '1.0') + 0.1}`,
      assumptions: [
        ...existingAssumptions.filter((a: string) => !a.startsWith('已根据用户反馈修订')),
        `已根据用户反馈修订: ${feedback}`,
        '设计修订为模板生成（LLM未配置），建议配置LLM以获得更精准的修订',
      ],
    };
  }

  private generateFallbackIntegrationReport(modules: string[]): Record<string, unknown> {
    return {
      result: 'passed',
      modules,
      issues: [],
      summary: `${modules.length} 个模块集成验证通过（自动验证：LLM未配置）`,
    };
  }

  // ──── Bug Fix LLM Methods ────

  private async generateBugFixWithLLM(
    testReport: Record<string, unknown>,
    designDoc: Record<string, unknown>,
    codeArtifacts: Record<string, unknown>[],
  ) {
    const systemPrompt = this.llmService.loadPrompt('developer', 'system');
    const bugs = (testReport as any).bugs ?? [];
    const userPrompt = this.llmService.loadPrompt('developer', 'fix-bugs', {
      testReport: JSON.stringify(testReport, null, 2),
      bugs: JSON.stringify(bugs, null, 2),
      codeArtifacts: JSON.stringify(codeArtifacts, null, 2),
      designDoc: JSON.stringify(designDoc, null, 2),
    });
    return this.llmService.generateStructuredOutput({
      systemPrompt, userPrompt, schema: bugfixSchema,
    });
  }

  private async reworkBugFixWithLLM(
    previousFix: Record<string, unknown>,
    testReport: Record<string, unknown>,
    reviewFeedback: string,
    designDoc: Record<string, unknown>,
  ) {
    const systemPrompt = this.llmService.loadPrompt('developer', 'system');
    const userPrompt = this.llmService.loadPrompt('developer', 'rework-bugfix', {
      previousFix: JSON.stringify(previousFix, null, 2),
      reviewFeedback,
      testReport: JSON.stringify(testReport, null, 2),
      designDoc: JSON.stringify(designDoc, null, 2),
    });
    return this.llmService.generateStructuredOutput({
      systemPrompt, userPrompt, schema: bugfixSchema,
    });
  }

  // ──── Bug Fix Fallback Generators ────

  private generateFallbackBugFix(testReport: Record<string, unknown>): Record<string, unknown> {
    const bugs = (testReport as any).bugs ?? [];
    return {
      targetBugs: bugs,
      fixes: bugs.map((bug: any) => ({
        bugId: bug.id,
        moduleName: bug.relatedModule,
        description: `修复 ${bug.description}（自动修复：LLM未配置）`,
        files: [{
          path: `src/${bug.relatedModule.toLowerCase().replace(/\s+/g, '-')}/fix.ts`,
          content: `// Bug fix for ${bug.id}: ${bug.description}\n// TODO: implement fix\n`,
          language: 'typescript',
        }],
      })),
      summary: `修复 ${bugs.length} 个Bug（自动修复：LLM未配置）`,
    };
  }

  private reworkFallbackBugFix(
    previousFix: Record<string, unknown>,
    feedback: string,
  ): Record<string, unknown> {
    return {
      ...previousFix,
      summary: `${(previousFix as any).summary ?? 'Bug修复方案'} [已修订: ${feedback}]`,
    };
  }

  // ──── Acceptance Fix LLM Methods ────

  private async generateAcceptanceFixWithLLM(
    userFeedback: string,
    previewDeployment: Record<string, unknown>,
    designDoc: Record<string, unknown>,
    codeArtifacts: Record<string, unknown>[],
  ) {
    const systemPrompt = this.llmService.loadPrompt('developer', 'system');
    const userPrompt = this.llmService.loadPrompt('developer', 'fix-acceptance-issues', {
      userFeedback,
      previewDeployment: JSON.stringify(previewDeployment, null, 2),
      codeArtifacts: JSON.stringify(codeArtifacts, null, 2),
      designDoc: JSON.stringify(designDoc, null, 2),
    });
    return this.llmService.generateStructuredOutput({
      systemPrompt, userPrompt, schema: acceptanceFixSchema,
    });
  }

  private async reworkAcceptanceFixWithLLM(
    previousFix: Record<string, unknown>,
    userFeedback: string,
    designDoc: Record<string, unknown>,
  ) {
    const systemPrompt = this.llmService.loadPrompt('developer', 'system');
    const userPrompt = this.llmService.loadPrompt('developer', 'rework-acceptance-fix', {
      previousFix: JSON.stringify(previousFix, null, 2),
      userFeedback,
      designDoc: JSON.stringify(designDoc, null, 2),
    });
    return this.llmService.generateStructuredOutput({
      systemPrompt, userPrompt, schema: acceptanceFixSchema,
    });
  }

  // ──── Acceptance Fix Fallback Generators ────

  private generateFallbackAcceptanceFix(userFeedback: string): Record<string, unknown> {
    return {
      userFeedback,
      analysis: `根据用户反馈分析: ${userFeedback}`,
      fixes: [{
        moduleName: 'main',
        description: `针对用户反馈进行修复（自动修复：LLM未配置）`,
        files: [{
          path: 'src/main/acceptance-fix.ts',
          content: `// Acceptance fix based on user feedback\n// Feedback: ${userFeedback}\n// TODO: implement fix\n`,
          language: 'typescript',
        }],
      }],
      summary: `验收修复方案（模板生成）— 针对用户反馈: ${userFeedback.substring(0, 50)}...`,
    };
  }

  private reworkFallbackAcceptanceFix(
    previousFix: Record<string, unknown>,
    userFeedback: string,
  ): Record<string, unknown> {
    return {
      ...previousFix,
      userFeedback,
      summary: `${(previousFix as any).summary ?? '验收修复方案'} [已修订: ${userFeedback.substring(0, 50)}]`,
    };
  }
}
