import { BaseAgent } from '../base-agent.js';
import { EventBus } from '../../core/event-bus/index.js';
import { ProjectService } from '../../services/project-service.js';
import { TaskService } from '../../services/task-service.js';
import { ArtifactStore } from '../../core/persistence/index.js';
import {
  EventType,
  AgentRole,
  PhaseName,
  TaskStatus,
} from '../../core/models/index.js';
import type { Event } from '../../core/models/index.js';

/**
 * PM Agent — the orchestrator.
 *
 * Responsibilities:
 * - React to user.requirement_submitted → create project, create analysis task
 * - React to artifact.produced → request user confirmation for PRD / design / ui_design / etc.
 * - React to user.confirmed → complete phase and advance
 * - React to user.rejected → create rework task
 * - React to phase.completed → create next phase tasks
 *
 * Special orchestration:
 * - Design phase: parallel tasks (Developer + UIDesigner when requiresUI=true)
 *   with aggregated completion check
 * - Implementation→Testing: DevOps prepares env config first, then QA starts
 * - Testing: Bug feedback loop (Developer fix → Code Review → QA retest)
 * - Testing: Bug feedback loop (Developer fix → Code Review → QA retest)
 * - Acceptance: Preview deployment → user trial → feedback fix loop → production deployment
 */
export class PMAgent extends BaseAgent {
  /** Track bug fix rounds per project to prevent infinite loops */
  private bugFixRounds: Map<string, number> = new Map();
  /** Track acceptance fix rounds per project to prevent infinite loops */
  private acceptanceFixRounds: Map<string, number> = new Map();

  constructor(
    eventBus: EventBus,
    private readonly projectService: ProjectService,
    private readonly taskService: TaskService,
    private readonly artifactStore: ArtifactStore,
  ) {
    super(AgentRole.PM, eventBus);
  }

  start(): void {
    this.on(EventType.UserRequirementSubmitted, (e) => this.handleRequirementSubmitted(e));
    this.on(EventType.TaskCompleted, (e) => this.handleTaskCompleted(e));
    this.on(EventType.UserConfirmed, (e) => this.handleUserConfirmed(e));
    this.on(EventType.UserRejected, (e) => this.handleUserRejected(e));
    this.on(EventType.ArtifactProduced, (e) => this.handleArtifactProduced(e));
    this.on(EventType.PhaseCompleted, (e) => this.handlePhaseCompleted(e));
    this.on(EventType.ProductDesignerQuestions, (e) => this.handleProductDesignerQuestions(e));
    this.logger.info('PM Agent started');
  }

  /**
   * User submitted a requirement → create project + analysis task.
   */
  private async handleRequirementSubmitted(event: Event): Promise<void> {
    const { requirement, projectName, requiresUI } = event.payload as {
      requirement: string;
      projectName?: string;
      requiresUI?: boolean;
    };

    this.logger.info({ requirement }, 'Received requirement, creating project');

    // Create the project
    const project = await this.projectService.createProject(
      (projectName as string) ?? 'New Project',
      requirement,
      requiresUI ?? false,
    );

    // Activate project (enters analysis phase)
    await this.projectService.activateProject(project.projectId);

    // Create task for Product Designer to analyze the requirement
    await this.taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Analysis,
      title: '需求分析与PRD编写',
      description: `分析以下用户需求并编写PRD文档:\n\n${requirement}`,
      assignedTo: AgentRole.ProductDesigner,
      priority: 'high',
    });
  }

  /**
   * Product Designer has discovery questions for the user → request user input.
   */
  private async handleProductDesignerQuestions(event: Event): Promise<void> {
    const { taskId, questions, message } = event.payload as {
      taskId: string;
      questions: Array<{ id: string; text: string; category: string }>;
      message: string;
    };

    this.logger.info({ taskId, questionCount: questions.length }, 'Product Designer has discovery questions');

    await this.emit(
      EventType.UserConfirmationNeeded,
      event.projectId,
      {
        confirmationType: 'discovery_questions',
        taskId,
        message,
        questions,
      },
      {
        phase: PhaseName.Analysis,
        correlationId: event.correlationId,
        causationId: event.id,
      },
    );
  }

  /**
   * An artifact was produced → route to appropriate confirmation or action.
   */
  private async handleArtifactProduced(event: Event): Promise<void> {
    const { artifactType, taskId } = event.payload as {
      artifactType: string;
      taskId: string;
    };

    if (artifactType === 'prd') {
      this.logger.info({ taskId }, 'PRD produced, requesting user confirmation');

      await this.emit(
        EventType.UserConfirmationNeeded,
        event.projectId,
        {
          confirmationType: 'prd_review',
          taskId,
          message: 'PRD文档已生成，请审核确认。',
        },
        {
          phase: PhaseName.Analysis,
          correlationId: event.correlationId,
          causationId: event.id,
        },
      );
    } else if (artifactType === 'design') {
      this.logger.info({ taskId }, 'Design document produced, requesting user confirmation');

      await this.emit(
        EventType.UserConfirmationNeeded,
        event.projectId,
        {
          confirmationType: 'design_review',
          taskId,
          message: '架构设计文档已生成，请审核确认。',
        },
        {
          phase: PhaseName.Design,
          correlationId: event.correlationId,
          causationId: event.id,
        },
      );
    } else if (artifactType === 'ui_design') {
      this.logger.info({ taskId }, 'UI design produced, requesting user confirmation');

      await this.emit(
        EventType.UserConfirmationNeeded,
        event.projectId,
        {
          confirmationType: 'ui_review',
          taskId,
          message: 'UI设计文档已生成，请审核确认。',
        },
        {
          phase: PhaseName.Design,
          correlationId: event.correlationId,
          causationId: event.id,
        },
      );
    } else if (artifactType === 'code') {
      // SubAgent produced code → unblock the corresponding Review Task
      const subTaskId = taskId;
      this.logger.info({ subTaskId }, 'Code artifact produced, unblocking review task');

      await this.unblockReviewTask(event.projectId, subTaskId, event.id);
    } else if (artifactType === 'env_config') {
      // DevOps prepared test environment → auto-create QA testing task
      this.logger.info({ taskId }, 'Environment config ready, creating QA testing task');

      await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Testing,
        title: '系统测试',
        description: '基于PRD验收标准和架构设计对实现进行全面测试',
        assignedTo: AgentRole.QA,
        priority: 'high',
      });
    } else if (artifactType === 'test_report') {
      await this.handleTestReportProduced(event, taskId);
    } else if (artifactType === 'bugfix') {
      // Developer produced bug fix → find or create a review task
      this.logger.info({ taskId }, 'Bugfix produced, setting up code review');

      const allTasks = await this.taskService.listTasksByPhase(event.projectId, PhaseName.Testing);
      const blockedReview = allTasks.find(
        (t) => t.status === TaskStatus.Blocked
          && t.assignedTo === AgentRole.CodeReviewer
          && t.blockedBy.includes(taskId),
      );

      if (blockedReview) {
        // Rework case: a blocked review task already exists → unblock it
        this.logger.info({ reviewTaskId: blockedReview.taskId, taskId }, 'Unblocking existing review task');
        await this.taskService.transitionTask(
          event.projectId, blockedReview.taskId, TaskStatus.InProgress,
          `Bugfix ${taskId} produced, starting review`, event.id,
        );
      } else {
        // First time: create review task and start it immediately
        const round = this.bugFixRounds.get(event.projectId) ?? 1;
        const reviewTask = await this.taskService.createTask({
          projectId: event.projectId,
          phase: PhaseName.Testing,
          title: `Bug修复代码审查 (第${round}轮)`,
          description: '审查Bug修复代码，确保修复正确且不引入新问题',
          assignedTo: AgentRole.CodeReviewer,
          priority: 'high',
        });
        await this.taskService.updateTask(event.projectId, reviewTask.taskId, {
          blockedBy: [taskId],
        });
        await this.taskService.transitionTask(
          event.projectId, reviewTask.taskId, TaskStatus.InProgress,
          `Bugfix ${taskId} produced, starting review`, event.id,
        );
      }
    } else if (artifactType === 'preview_deployment') {
      this.logger.info({ taskId }, 'Preview deployed, notifying user to try the system');

      await this.emit(
        EventType.UserConfirmationNeeded,
        event.projectId,
        {
          confirmationType: 'acceptance_trial',
          taskId,
          message: '预览环境已部署，请试用系统并反馈。',
        },
        {
          phase: PhaseName.Acceptance,
          correlationId: event.correlationId,
          causationId: event.id,
        },
      );
    } else if (artifactType === 'deployment_plan') {
      this.logger.info({ taskId }, 'Deployment plan produced, requesting user confirmation');

      await this.emit(
        EventType.UserConfirmationNeeded,
        event.projectId,
        {
          confirmationType: 'deployment_review',
          taskId,
          message: '生产部署计划已生成，请审核确认。',
        },
        {
          phase: PhaseName.Acceptance,
          correlationId: event.correlationId,
          causationId: event.id,
        },
      );
    }
  }

  /**
   * Handle test_report artifact: check for bugs and route accordingly.
   * - If bugs found: create Developer bug fix task + blocked CodeReviewer review task
   * - If no bugs: request user confirmation (original behavior)
   */
  private async handleTestReportProduced(event: Event, taskId: string): Promise<void> {
    const projectId = event.projectId;

    // Load the test report to inspect bugs
    const testReport = await this.artifactStore.load<Record<string, unknown>>(
      projectId, 'testing', 'test-report.json',
    );

    if (!testReport) {
      this.logger.warn({ projectId }, 'Could not load test report, falling back to user confirmation');
      await this.requestTestReviewConfirmation(event, taskId);
      return;
    }

    const overallResult = (testReport as any).overallResult;
    const bugs: unknown[] = (testReport as any).bugs ?? [];

    if (overallResult === 'failed' && bugs.length > 0) {
      // Check circuit breaker
      const project = await this.projectService.getProject(projectId);
      const maxRetry = project?.config?.maxRetryOnFailure ?? 3;
      const currentRound = this.bugFixRounds.get(projectId) ?? 0;

      if (currentRound >= maxRetry) {
        this.logger.warn({ projectId, currentRound, maxRetry }, 'Bug fix rounds exceeded limit, requesting user confirmation');
        await this.emit(
          EventType.UserConfirmationNeeded,
          projectId,
          {
            confirmationType: 'test_review',
            taskId,
            message: `测试报告发现 ${bugs.length} 个Bug，但已达最大修复轮次限制(${maxRetry})，请人工审核决定是否继续。`,
          },
          { phase: PhaseName.Testing, correlationId: event.correlationId, causationId: event.id },
        );
        return;
      }

      // Enter bug fix loop
      const round = currentRound + 1;
      this.bugFixRounds.set(projectId, round);

      this.logger.info({ projectId, bugCount: bugs.length, round }, 'Test report has bugs, creating bug fix task');

      // Create consolidated Developer bug fix task.
      // NOTE: Review task is NOT created here — it will be created (or unblocked)
      // when Developer produces the bugfix artifact, in handleArtifactProduced(bugfix).
      // This avoids a race condition: createTask emits TaskCreated synchronously,
      // triggering the full Developer→Review chain before we can create the review task.
      const bugSummary = bugs.map((b: any) => `[${b.severity}] ${b.id}: ${b.description} (模块: ${b.relatedModule})`).join('\n');
      await this.taskService.createTask({
        projectId,
        phase: PhaseName.Testing,
        title: `Bug修复 (第${round}轮)`,
        description: `测试发现以下Bug，请分析并修复:\n\n${bugSummary}`,
        assignedTo: AgentRole.Developer,
        priority: 'critical',
      });
    } else {
      // Tests passed or no bugs — request user confirmation
      this.bugFixRounds.delete(projectId);
      await this.requestTestReviewConfirmation(event, taskId);
    }
  }

  /**
   * Emit user.confirmation_needed for test_review.
   */
  private async requestTestReviewConfirmation(event: Event, taskId: string): Promise<void> {
    this.logger.info({ taskId }, 'Test report produced, requesting user confirmation');

    await this.emit(
      EventType.UserConfirmationNeeded,
      event.projectId,
      {
        confirmationType: 'test_review',
        taskId,
        message: '测试报告已生成，请审核确认。',
      },
      {
        phase: PhaseName.Testing,
        correlationId: event.correlationId,
        causationId: event.id,
      },
    );
  }

  /**
   * A task was completed → check if phase can be completed.
   */
  private async handleTaskCompleted(event: Event): Promise<void> {
    const { taskId } = event.payload as { taskId: string };
    this.logger.info({ taskId, phase: event.phase }, 'Task completed, checking phase status');

    // For analysis/design: we rely on user confirmation for phase completion,
    // so we don't auto-complete the phase here.

    // For implementation: when the parent implementation task completes,
    // all SubTasks passed review and integration verified — complete the phase.
    if (event.phase === PhaseName.Implementation) {
      const task = await this.taskService.getTask(event.projectId, taskId);
      if (task && task.assignedTo === AgentRole.Developer && task.subTasks.length > 0) {
        this.logger.info({ taskId, projectId: event.projectId }, 'Implementation parent task completed, completing phase');
        await this.projectService.completePhase(event.projectId, PhaseName.Implementation);
      }
    }

    // For testing: when a Developer bug-fix task completes → create QA retest task
    if (event.phase === PhaseName.Testing) {
      const task = await this.taskService.getTask(event.projectId, taskId);
      if (task && task.assignedTo === AgentRole.Developer) {
        this.logger.info({ taskId, projectId: event.projectId }, 'Bug fix completed, creating QA retest task');
        await this.taskService.createTask({
          projectId: event.projectId,
          phase: PhaseName.Testing,
          title: '回归测试',
          description: 'Bug修复已完成并通过代码审查，请重新执行测试验证修复效果',
          assignedTo: AgentRole.QA,
          priority: 'high',
        });
      }
    }

    // For acceptance: when a Developer fix task completes → create DevOps redeploy task
    if (event.phase === PhaseName.Acceptance) {
      const task = await this.taskService.getTask(event.projectId, taskId);
      if (task && task.assignedTo === AgentRole.Developer) {
        this.logger.info({ taskId, projectId: event.projectId }, 'Acceptance fix completed, creating DevOps redeploy task');
        await this.taskService.createTask({
          projectId: event.projectId,
          phase: PhaseName.Acceptance,
          title: '预览环境更新',
          description: '验收修复已完成，请更新预览环境部署',
          assignedTo: AgentRole.DevOps,
          priority: 'high',
        });
      }
    }
  }

  /**
   * User confirmed → complete current task and advance phase.
   */
  private async handleUserConfirmed(event: Event): Promise<void> {
    const { confirmationType, taskId, answers } = event.payload as {
      confirmationType: string;
      taskId?: string;
      answers?: Record<string, string>;
    };

    if (confirmationType === 'discovery_questions') {
      this.logger.info({ taskId, answerCount: answers ? Object.keys(answers).length : 0 }, 'User submitted discovery answers, forwarding to Product Designer');

      if (answers && taskId) {
        await this.emit(
          EventType.ProductDesignerAnswersReceived,
          event.projectId,
          {
            taskId,
            answers,
          },
          {
            phase: PhaseName.Analysis,
            correlationId: event.correlationId,
            causationId: event.id,
          },
        );
      }
      return;
    }

    if (confirmationType === 'prd_review') {
      this.logger.info({ taskId }, 'User confirmed PRD, completing analysis phase');

      if (taskId) {
        const task = await this.taskService.getTask(event.projectId, taskId);
        if (task && task.status !== TaskStatus.Done) {
          await this.taskService.transitionTask(
            event.projectId,
            taskId,
            TaskStatus.Done,
            'User approved PRD',
            event.id,
          );
        }
      }

      await this.projectService.completePhase(event.projectId, PhaseName.Analysis);
    } else if (confirmationType === 'design_review') {
      this.logger.info({ taskId }, 'User confirmed design, checking design phase completion');

      if (taskId) {
        const task = await this.taskService.getTask(event.projectId, taskId);
        if (task && task.status !== TaskStatus.Done) {
          await this.taskService.transitionTask(
            event.projectId,
            taskId,
            TaskStatus.Done,
            'User approved design',
            event.id,
          );
        }
      }

      await this.checkDesignPhaseCompletion(event.projectId);
    } else if (confirmationType === 'ui_review') {
      this.logger.info({ taskId }, 'User confirmed UI design, checking design phase completion');

      if (taskId) {
        const task = await this.taskService.getTask(event.projectId, taskId);
        if (task && task.status !== TaskStatus.Done) {
          await this.taskService.transitionTask(
            event.projectId,
            taskId,
            TaskStatus.Done,
            'User approved UI design',
            event.id,
          );
        }
      }

      await this.checkDesignPhaseCompletion(event.projectId);
    } else if (confirmationType === 'test_review') {
      this.logger.info({ taskId }, 'User confirmed test report, completing testing phase');

      if (taskId) {
        const task = await this.taskService.getTask(event.projectId, taskId);
        if (task && task.status !== TaskStatus.Done) {
          await this.taskService.transitionTask(
            event.projectId,
            taskId,
            TaskStatus.Done,
            'User approved test report',
            event.id,
          );
        }
      }

      await this.projectService.completePhase(event.projectId, PhaseName.Testing);
    } else if (confirmationType === 'acceptance_trial') {
      this.logger.info({ taskId }, 'User accepted preview trial, triggering production deployment');

      if (taskId) {
        const task = await this.taskService.getTask(event.projectId, taskId);
        if (task && task.status !== TaskStatus.Done) {
          await this.taskService.transitionTask(
            event.projectId,
            taskId,
            TaskStatus.Done,
            'User accepted preview trial',
            event.id,
          );
        }
      }

      // Reset acceptance fix rounds
      this.acceptanceFixRounds.delete(event.projectId);

      // Trigger DevOps production deployment plan
      await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Acceptance,
        title: '生产部署计划',
        description: '制定生产环境部署方案，包括部署步骤、回滚策略和监控方案',
        assignedTo: AgentRole.DevOps,
        priority: 'high',
      });
    } else if (confirmationType === 'deployment_review') {
      this.logger.info({ taskId }, 'User confirmed deployment plan, completing acceptance phase');

      if (taskId) {
        const task = await this.taskService.getTask(event.projectId, taskId);
        if (task && task.status !== TaskStatus.Done) {
          await this.taskService.transitionTask(
            event.projectId,
            taskId,
            TaskStatus.Done,
            'User approved deployment plan',
            event.id,
          );
        }
      }

      await this.projectService.completePhase(event.projectId, PhaseName.Acceptance);
    }
  }

  /**
   * User rejected → create rework task.
   */
  private async handleUserRejected(event: Event): Promise<void> {
    const { confirmationType, taskId, feedback } = event.payload as {
      confirmationType: string;
      taskId?: string;
      feedback?: string;
    };

    if (confirmationType === 'prd_review') {
      this.logger.info({ taskId, feedback }, 'User rejected PRD, creating rework task');

      await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Analysis,
        title: 'PRD修订',
        description: `根据用户反馈修订PRD文档:\n\n${feedback ?? '无具体反馈'}`,
        assignedTo: AgentRole.ProductDesigner,
        priority: 'high',
      });
    } else if (confirmationType === 'design_review') {
      this.logger.info({ taskId, feedback }, 'User rejected design, creating rework task');

      await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Design,
        title: '架构设计修订',
        description: `根据用户反馈修订架构设计文档:\n\n${feedback ?? '无具体反馈'}`,
        assignedTo: AgentRole.Developer,
        priority: 'high',
      });
    } else if (confirmationType === 'ui_review') {
      this.logger.info({ taskId, feedback }, 'User rejected UI design, creating rework task');

      await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Design,
        title: 'UI设计修订',
        description: `根据用户反馈修订UI设计文档:\n\n${feedback ?? '无具体反馈'}`,
        assignedTo: AgentRole.UIDesigner,
        priority: 'high',
      });
    } else if (confirmationType === 'test_review') {
      this.logger.info({ taskId, feedback }, 'User rejected test report, creating rework task');

      await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Testing,
        title: '测试报告修订',
        description: `根据用户反馈修订测试报告:\n\n${feedback ?? '无具体反馈'}`,
        assignedTo: AgentRole.QA,
        priority: 'high',
      });
    } else if (confirmationType === 'acceptance_trial') {
      const project = await this.projectService.getProject(event.projectId);
      const maxRetry = project?.config?.maxRetryOnFailure ?? 3;
      const currentRound = this.acceptanceFixRounds.get(event.projectId) ?? 0;

      if (currentRound >= maxRetry) {
        this.logger.warn({ projectId: event.projectId, currentRound, maxRetry }, 'Acceptance fix rounds exceeded limit');
        await this.emit(
          EventType.UserConfirmationNeeded,
          event.projectId,
          {
            confirmationType: 'acceptance_trial',
            taskId,
            message: `已达最大修复轮次限制(${maxRetry})，请决定是否仍需继续修复，或确认验收通过。`,
          },
          {
            phase: PhaseName.Acceptance,
            correlationId: event.correlationId,
            causationId: event.id,
          },
        );
        return;
      }

      const round = currentRound + 1;
      this.acceptanceFixRounds.set(event.projectId, round);

      this.logger.info({ taskId, feedback, round }, 'User rejected preview trial, creating acceptance fix task');

      await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Acceptance,
        title: `验收修复 (第${round}轮)`,
        description: `根据用户试用反馈修复问题:\n\n${feedback ?? '无具体反馈'}`,
        assignedTo: AgentRole.Developer,
        priority: 'critical',
      });
    } else if (confirmationType === 'deployment_review') {
      this.logger.info({ taskId, feedback }, 'User rejected deployment plan, creating rework task');

      await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Acceptance,
        title: '部署计划修订',
        description: `根据用户反馈修订部署计划:\n\n${feedback ?? '无具体反馈'}`,
        assignedTo: AgentRole.DevOps,
        priority: 'high',
      });
    }
  }

  /**
   * Check if all Design phase tasks are done before completing the phase.
   * Handles parallel tasks: Developer (always) + UIDesigner (when requiresUI=true).
   */
  private async checkDesignPhaseCompletion(projectId: string): Promise<void> {
    const project = await this.projectService.getProject(projectId);
    if (!project) return;

    const designTasks = await this.taskService.listTasksByPhase(projectId, PhaseName.Design);

    // Developer architecture task must be done
    const devTask = designTasks.find((t) => t.assignedTo === AgentRole.Developer);
    if (!devTask || devTask.status !== TaskStatus.Done) return;

    // If UI design is required, UIDesigner task must also be done
    if (project.config.requiresUI) {
      const uiTask = designTasks.find((t) => t.assignedTo === AgentRole.UIDesigner);
      if (!uiTask || uiTask.status !== TaskStatus.Done) return;
    }

    this.logger.info({ projectId }, 'All design tasks completed, completing design phase');
    await this.projectService.completePhase(projectId, PhaseName.Design);
  }

  /**
   * Find the blocked Review Task for a given SubTask and unblock it.
   * @param phase - which phase to search for the review task (default: Implementation)
   */
  private async unblockReviewTask(
    projectId: string,
    subTaskId: string,
    triggerEventId: string,
    phase: string = PhaseName.Implementation,
  ): Promise<void> {
    const allTasks = await this.taskService.listTasksByPhase(projectId, phase);

    // Find blocked review task that depends on this SubTask
    const reviewTask = allTasks.find(
      (t) => t.status === TaskStatus.Blocked && t.blockedBy.includes(subTaskId),
    );

    if (!reviewTask) {
      this.logger.warn({ subTaskId }, 'No blocked review task found for SubTask');
      return;
    }

    this.logger.info({ reviewTaskId: reviewTask.taskId, subTaskId }, 'Unblocking review task');

    // Transition from blocked → in_progress (triggers TaskStarted event)
    await this.taskService.transitionTask(
      projectId,
      reviewTask.taskId,
      TaskStatus.InProgress,
      `SubTask ${subTaskId} produced code, starting review`,
      triggerEventId,
    );
  }

  /**
   * A phase was completed → create tasks for the next phase.
   */
  private async handlePhaseCompleted(event: Event): Promise<void> {
    const { phase } = event.payload as { phase: string };

    if (phase === PhaseName.Analysis) {
      this.logger.info({ projectId: event.projectId }, 'Analysis phase completed, entering design phase');

      // Activate design phase
      await this.projectService.enterPhase(event.projectId, PhaseName.Design);

      // Create design task for Developer
      await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Design,
        title: '系统架构设计',
        description: '基于已批准的PRD文档，进行技术选型、架构设计和API规范制定',
        assignedTo: AgentRole.Developer,
        priority: 'high',
      });

      // If project requires UI, create parallel UI design task
      const project = await this.projectService.getProject(event.projectId);
      if (project?.config.requiresUI) {
        this.logger.info({ projectId: event.projectId }, 'Project requires UI, creating UI design task');
        await this.taskService.createTask({
          projectId: event.projectId,
          phase: PhaseName.Design,
          title: 'UI界面设计',
          description: '基于已批准的PRD文档，设计UI布局、组件结构和样式规范',
          assignedTo: AgentRole.UIDesigner,
          priority: 'high',
        });
      }
    } else if (phase === PhaseName.Design) {
      this.logger.info({ projectId: event.projectId }, 'Design phase completed, entering implementation phase');

      // Activate implementation phase
      await this.projectService.enterPhase(event.projectId, PhaseName.Implementation);

      // Create root implementation task for Developer (Dev Lead)
      await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Implementation,
        title: '代码实现',
        description: '基于已批准的架构设计文档，拆分模块任务并协调SubAgent进行代码实现',
        assignedTo: AgentRole.Developer,
        priority: 'high',
      });
    } else if (phase === PhaseName.Implementation) {
      this.logger.info({ projectId: event.projectId }, 'Implementation phase completed, entering testing phase');

      // Activate testing phase
      await this.projectService.enterPhase(event.projectId, PhaseName.Testing);

      // Create DevOps task to prepare test environment first
      await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Testing,
        title: '测试环境配置',
        description: '基于架构设计和集成报告，配置测试环境',
        assignedTo: AgentRole.DevOps,
        priority: 'high',
      });
    } else if (phase === PhaseName.Testing) {
      this.logger.info({ projectId: event.projectId }, 'Testing phase completed, entering acceptance phase');

      // Activate acceptance phase
      await this.projectService.enterPhase(event.projectId, PhaseName.Acceptance);

      // Create DevOps task to deploy preview environment for user trial
      await this.taskService.createTask({
        projectId: event.projectId,
        phase: PhaseName.Acceptance,
        title: '预览环境部署',
        description: '将项目部署到预览环境，供用户验收试用',
        assignedTo: AgentRole.DevOps,
        priority: 'high',
      });
    }
  }
}
