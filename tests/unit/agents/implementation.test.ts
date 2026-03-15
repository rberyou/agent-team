import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../../src/core/event-bus/index.js';
import {
  FileStore,
  EventStore,
  ProjectStore,
  PhaseStore,
  TaskStore,
  ArtifactStore,
} from '../../../src/core/persistence/index.js';
import { ProjectService } from '../../../src/services/project-service.js';
import { TaskService } from '../../../src/services/task-service.js';
import { PMAgent } from '../../../src/agents/pm/index.js';
import { ProductDesignerAgent } from '../../../src/agents/product-designer/index.js';
import { DeveloperAgent } from '../../../src/agents/developer/index.js';
import { CodeReviewerAgent } from '../../../src/agents/code-reviewer/index.js';
import { LLMService, PromptLoader, OpenAICompatibleProvider } from '../../../src/core/llm/index.js';
import type { LLMConfig } from '../../../src/core/llm/index.js';
import {
  EventType,
  EventSource,
  PhaseName,
  TaskStatus,
  AgentRole,
} from '../../../src/core/models/index.js';
import type { Event } from '../../../src/core/models/index.js';

// --- Helpers ---

function createDisabledLLMService(): LLMService {
  const llmConfig: LLMConfig = {
    provider: 'openai-compatible',
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.7,
    maxTokens: 4096,
    timeoutMs: 60000,
    maxRetries: 3,
  };
  const promptLoader = new PromptLoader('/nonexistent');
  const provider = new OpenAICompatibleProvider(llmConfig);
  return new LLMService(provider, promptLoader, llmConfig);
}

const DESIGN_WITH_TWO_COMPONENTS = {
  projectName: 'Test Project',
  version: '1.0',
  techStack: {
    frontend: [],
    backend: [{ name: 'Node.js', reason: 'TypeScript support' }],
    database: [{ name: 'SQLite', reason: 'Lightweight' }],
    infrastructure: [],
  },
  architecture: {
    pattern: '分层架构',
    description: 'Layered architecture.',
    components: [
      {
        name: 'AuthModule',
        responsibility: '用户认证与授权',
        interfaces: ['login', 'register'],
      },
      {
        name: 'TaskModule',
        responsibility: '任务管理CRUD',
        interfaces: ['createTask', 'getTask'],
      },
    ],
    dataModels: [],
  },
  apiSpec: {
    baseUrl: '/api',
    endpoints: [{ method: 'POST', path: '/login', summary: '用户登录' }],
  },
};

const SINGLE_COMPONENT_DESIGN = {
  ...DESIGN_WITH_TWO_COMPONENTS,
  architecture: {
    ...DESIGN_WITH_TWO_COMPONENTS.architecture,
    components: [
      {
        name: 'CoreModule',
        responsibility: '核心业务逻辑',
        interfaces: ['process'],
      },
    ],
  },
};

let tempDir: string;
let eventBus: EventBus;
let projectService: ProjectService;
let taskService: TaskService;
let artifactStore: ArtifactStore;
let llmService: LLMService;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'impl-test-'));
  const fileStore = new FileStore();
  const eventStore = new EventStore(fileStore, tempDir);
  const projectStore = new ProjectStore(fileStore, tempDir);
  const phaseStore = new PhaseStore(fileStore, tempDir);
  const taskStore = new TaskStore(fileStore, tempDir);
  artifactStore = new ArtifactStore(fileStore, tempDir);

  eventBus = new EventBus();
  eventBus.setPersistence(eventStore);

  projectService = new ProjectService(eventBus, projectStore, phaseStore);
  taskService = new TaskService(eventBus, taskStore);
  llmService = createDisabledLLMService();
});

afterEach(async () => {
  eventBus.clear();
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Helper: create a project already in implementation phase with design doc saved.
 * IMPORTANT: call this BEFORE starting any agents to avoid event conflicts.
 */
async function setupImplementationPhase(designDoc?: Record<string, unknown>) {
  const project = await projectService.createProject('Test', '测试');
  await projectService.activateProject(project.projectId);
  await projectService.completePhase(project.projectId, PhaseName.Analysis);
  await projectService.enterPhase(project.projectId, PhaseName.Design);
  await projectService.completePhase(project.projectId, PhaseName.Design);
  await projectService.enterPhase(project.projectId, PhaseName.Implementation);

  await artifactStore.save(
    project.projectId,
    'design',
    'design.json',
    designDoc ?? DESIGN_WITH_TWO_COMPONENTS,
  );

  return project;
}

// --- Tests ---

describe('TaskService.updateTask', () => {
  it('should update reviewStatus and reviewRounds without changing status', async () => {
    const project = await projectService.createProject('T', 'desc');
    await projectService.activateProject(project.projectId);

    const task = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Analysis,
      title: 'Test task',
      assignedTo: AgentRole.Developer,
    });

    const updated = await taskService.updateTask(project.projectId, task.taskId, {
      reviewStatus: 'approved',
      reviewRounds: 2,
    });

    expect(updated.reviewStatus).toBe('approved');
    expect(updated.reviewRounds).toBe(2);
    expect(updated.status).toBe(TaskStatus.Pending);
  });

  it('should update parentTask and subTasks', async () => {
    const project = await projectService.createProject('T', 'desc');
    await projectService.activateProject(project.projectId);

    const parent = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Implementation,
      title: 'Parent',
      assignedTo: AgentRole.Developer,
    });

    const child = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Implementation,
      title: 'Child',
      assignedTo: 'subagent_mod',
    });

    await taskService.updateTask(project.projectId, child.taskId, { parentTask: parent.taskId });
    await taskService.updateTask(project.projectId, parent.taskId, { subTasks: [child.taskId] });

    const loadedChild = await taskService.getTask(project.projectId, child.taskId);
    expect(loadedChild!.parentTask).toBe(parent.taskId);

    const loadedParent = await taskService.getTask(project.projectId, parent.taskId);
    expect(loadedParent!.subTasks).toEqual([child.taskId]);
  });

  it('should update blockedBy', async () => {
    const project = await projectService.createProject('T', 'desc');
    await projectService.activateProject(project.projectId);

    const task = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Implementation,
      title: 'Review',
      assignedTo: AgentRole.CodeReviewer,
    });

    await taskService.updateTask(project.projectId, task.taskId, { blockedBy: ['task_abc'] });

    const loaded = await taskService.getTask(project.projectId, task.taskId);
    expect(loaded!.blockedBy).toEqual(['task_abc']);
  });

  it('should throw for non-existent task', async () => {
    const project = await projectService.createProject('T', 'desc');
    await expect(
      taskService.updateTask(project.projectId, 'task_nonexistent', { reviewRounds: 1 }),
    ).rejects.toThrow('Task not found');
  });
});

describe('DeveloperAgent — Implementation Phase', () => {
  it('should split implementation task into subtasks per design component', async () => {
    const project = await setupImplementationPhase();

    const devAgent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
    devAgent.start();

    const artifactEvents: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => artifactEvents.push(e));

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Implementation,
      title: '代码实现',
      description: '实现所有模块',
      assignedTo: AgentRole.Developer,
    });

    await new Promise((r) => setTimeout(r, 200));

    const allTasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Implementation);

    // 1 parent + 2 subtasks + 2 review tasks = 5
    expect(allTasks.length).toBeGreaterThanOrEqual(5);

    const subTasks = allTasks.filter((t) => t.title.startsWith('模块开发:'));
    expect(subTasks).toHaveLength(2);
    expect(subTasks.map((t) => t.title)).toContain('模块开发: AuthModule');
    expect(subTasks.map((t) => t.title)).toContain('模块开发: TaskModule');

    const reviewTasks = allTasks.filter((t) => t.title.startsWith('代码审查:'));
    expect(reviewTasks).toHaveLength(2);
    for (const rt of reviewTasks) {
      expect(rt.blockedBy.length).toBeGreaterThan(0);
    }

    const parentTask = allTasks.find((t) => t.title === '代码实现');
    expect(parentTask!.subTasks).toHaveLength(2);

    const breakdownEvent = artifactEvents.find(
      (e) => (e.payload as any).artifactType === 'task_breakdown',
    );
    expect(breakdownEvent).toBeTruthy();

    devAgent.stop();
  });

  it('should have SubAgents produce code artifacts for each subtask', async () => {
    const project = await setupImplementationPhase();

    const devAgent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
    devAgent.start();

    const codeEvents: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => {
      if ((e.payload as any).artifactType === 'code') codeEvents.push(e);
    });

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Implementation,
      title: '代码实现',
      description: '实现所有模块',
      assignedTo: AgentRole.Developer,
    });

    await new Promise((r) => setTimeout(r, 300));

    expect(codeEvents).toHaveLength(2);

    const authCode = await artifactStore.load(project.projectId, 'implementation', 'AuthModule/code.json');
    expect(authCode).toBeTruthy();
    expect((authCode as any).moduleName).toBe('AuthModule');

    const taskCode = await artifactStore.load(project.projectId, 'implementation', 'TaskModule/code.json');
    expect(taskCode).toBeTruthy();
    expect((taskCode as any).moduleName).toBe('TaskModule');

    const allTasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Implementation);
    const subTasks = allTasks.filter((t) => t.title.startsWith('模块开发:'));
    for (const st of subTasks) {
      expect(st.status).toBe(TaskStatus.InReview);
    }

    devAgent.stop();
  });
});

describe('PM Agent — Implementation Phase Orchestration', () => {
  it('should create implementation task when design phase completes', async () => {
    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    const project = await projectService.createProject('T', 'desc');
    await projectService.activateProject(project.projectId);

    // Complete analysis — PM enters design automatically
    await projectService.completePhase(project.projectId, PhaseName.Analysis);

    await new Promise((r) => setTimeout(r, 50));

    // Complete design — PM should enter implementation and create task
    await projectService.completePhase(project.projectId, PhaseName.Design);

    await new Promise((r) => setTimeout(r, 100));

    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Implementation);
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    const implTask = tasks.find((t) => t.title === '代码实现');
    expect(implTask).toBeTruthy();
    expect(implTask!.assignedTo).toBe(AgentRole.Developer);

    pmAgent.stop();
  });

  it('should unblock review task when code artifact is produced', async () => {
    const project = await setupImplementationPhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    const subTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Implementation,
      title: '模块开发: TestMod',
      assignedTo: 'subagent_testmod',
    });

    const reviewTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Implementation,
      title: '代码审查: TestMod',
      assignedTo: AgentRole.CodeReviewer,
    });

    await taskService.updateTask(project.projectId, reviewTask.taskId, {
      blockedBy: [subTask.taskId],
    });
    await taskService.transitionTask(
      project.projectId, reviewTask.taskId, TaskStatus.Blocked,
      'Waiting for code',
    );

    await eventBus.emit(
      EventType.ArtifactProduced,
      project.projectId,
      EventSource.AgentDeveloper,
      {
        artifactType: 'code',
        taskId: subTask.taskId,
        moduleName: 'TestMod',
      },
      { phase: PhaseName.Implementation },
    );

    await new Promise((r) => setTimeout(r, 100));

    const updatedReview = await taskService.getTask(project.projectId, reviewTask.taskId);
    expect(updatedReview!.status).toBe(TaskStatus.InProgress);

    pmAgent.stop();
  });
});

describe('CodeReviewerAgent', () => {
  it('should review code and emit review.completed when task starts', async () => {
    const project = await setupImplementationPhase();

    const codeReviewer = new CodeReviewerAgent(eventBus, taskService, artifactStore, llmService);
    codeReviewer.start();

    const subTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Implementation,
      title: '模块开发: AuthModule',
      assignedTo: 'subagent_authmodule',
    });

    await artifactStore.save(project.projectId, 'implementation', 'AuthModule/code.json', {
      moduleName: 'AuthModule',
      files: [{ path: 'src/auth/index.ts', content: 'export class Auth {}', language: 'typescript' }],
      unitTests: [],
      dependencies: [],
    });

    const reviewTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Implementation,
      title: '代码审查: AuthModule',
      assignedTo: AgentRole.CodeReviewer,
    });

    await taskService.updateTask(project.projectId, reviewTask.taskId, {
      blockedBy: [subTask.taskId],
    });

    const reviewEvents: Event[] = [];
    eventBus.subscribe(EventType.ReviewCompleted, (e) => reviewEvents.push(e));

    // Simulate unblock: blocked → in_progress triggers TaskStarted
    await taskService.transitionTask(
      project.projectId, reviewTask.taskId, TaskStatus.InProgress,
      'Code ready for review',
    );

    await new Promise((r) => setTimeout(r, 200));

    expect(reviewEvents).toHaveLength(1);
    const payload = reviewEvents[0].payload as any;
    expect(payload.subTaskId).toBe(subTask.taskId);
    expect(payload.moduleName).toBe('AuthModule');
    expect(payload.result).toBe('passed');

    const updatedReview = await taskService.getTask(project.projectId, reviewTask.taskId);
    expect(updatedReview!.status).toBe(TaskStatus.Done);

    const report = await artifactStore.load(project.projectId, 'implementation', 'AuthModule/review.json') as any;
    expect(report).toBeTruthy();
    expect(report.result).toBe('passed');

    codeReviewer.stop();
  });

  it('should ignore non-code-reviewer tasks', async () => {
    const project = await setupImplementationPhase();

    const codeReviewer = new CodeReviewerAgent(eventBus, taskService, artifactStore, llmService);
    codeReviewer.start();

    const devTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Implementation,
      title: 'Dev task',
      assignedTo: AgentRole.Developer,
    });

    const reviewEvents: Event[] = [];
    eventBus.subscribe(EventType.ReviewCompleted, (e) => reviewEvents.push(e));

    await taskService.transitionTask(
      project.projectId, devTask.taskId, TaskStatus.InProgress, 'Starting',
    );

    await new Promise((r) => setTimeout(r, 100));

    expect(reviewEvents).toHaveLength(0);

    codeReviewer.stop();
  });
});

describe('Full Implementation Phase E2E (single component, no LLM)', () => {
  it('should complete: split → code → review → integrate → phase done', async () => {
    const project = await setupImplementationPhase(SINGLE_COMPONENT_DESIGN);

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    const devAgent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
    const codeReviewer = new CodeReviewerAgent(eventBus, taskService, artifactStore, llmService);

    pmAgent.start();
    devAgent.start();
    codeReviewer.start();

    const phaseEvents: Event[] = [];
    eventBus.subscribe(EventType.PhaseCompleted, (e) => phaseEvents.push(e));

    // Kick off implementation
    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Implementation,
      title: '代码实现',
      description: '实现所有模块',
      assignedTo: AgentRole.Developer,
    });

    // The entire chain is serial-await through EventBus,
    // so by the time createTask returns the full chain has executed.
    // Small delay for safety.
    await new Promise((r) => setTimeout(r, 100));

    // All tasks done
    const allTasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Implementation);

    const parentTask = allTasks.find((t) => t.title === '代码实现');
    expect(parentTask).toBeTruthy();
    expect(parentTask!.status).toBe(TaskStatus.Done);

    const subTask = allTasks.find((t) => t.title === '模块开发: CoreModule');
    expect(subTask).toBeTruthy();
    expect(subTask!.status).toBe(TaskStatus.Done);
    expect(subTask!.reviewStatus).toBe('approved');

    const reviewTask = allTasks.find((t) => t.title.startsWith('代码审查: CoreModule'));
    expect(reviewTask).toBeTruthy();
    expect(reviewTask!.status).toBe(TaskStatus.Done);

    // Artifacts
    const code = await artifactStore.load(project.projectId, 'implementation', 'CoreModule/code.json') as any;
    expect(code).toBeTruthy();
    expect(code.moduleName).toBe('CoreModule');

    const review = await artifactStore.load(project.projectId, 'implementation', 'CoreModule/review.json') as any;
    expect(review).toBeTruthy();
    expect(review.result).toBe('passed');

    const integration = await artifactStore.load(project.projectId, 'implementation', 'integration-report.json') as any;
    expect(integration).toBeTruthy();
    expect(integration.result).toBe('passed');

    // Phase completed
    const implCompleted = phaseEvents.find((e) => (e.payload as any).phase === PhaseName.Implementation);
    expect(implCompleted).toBeTruthy();

    const updatedProject = await projectService.getProject(project.projectId);
    expect(updatedProject!.currentPhase).toBe(PhaseName.Testing);

    pmAgent.stop();
    devAgent.stop();
    codeReviewer.stop();
  });

  it('should complete multi-component implementation flow', async () => {
    const project = await setupImplementationPhase(); // 2 components

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    const devAgent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
    const codeReviewer = new CodeReviewerAgent(eventBus, taskService, artifactStore, llmService);

    pmAgent.start();
    devAgent.start();
    codeReviewer.start();

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Implementation,
      title: '代码实现',
      description: '实现所有模块',
      assignedTo: AgentRole.Developer,
    });

    await new Promise((r) => setTimeout(r, 200));

    const authCode = await artifactStore.load(project.projectId, 'implementation', 'AuthModule/code.json') as any;
    expect(authCode).toBeTruthy();
    expect(authCode.moduleName).toBe('AuthModule');

    const taskCode = await artifactStore.load(project.projectId, 'implementation', 'TaskModule/code.json') as any;
    expect(taskCode).toBeTruthy();
    expect(taskCode.moduleName).toBe('TaskModule');

    const integration = await artifactStore.load(project.projectId, 'implementation', 'integration-report.json') as any;
    expect(integration).toBeTruthy();
    expect(integration.result).toBe('passed');
    expect(integration.modules).toHaveLength(2);

    const updatedProject = await projectService.getProject(project.projectId);
    expect(updatedProject!.currentPhase).toBe(PhaseName.Testing);

    pmAgent.stop();
    devAgent.stop();
    codeReviewer.stop();
  });
});

describe('Full E2E: Analysis → Design → Implementation', () => {
  it('should complete all three phases end-to-end', async () => {
    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    const pdAgent = new ProductDesignerAgent(eventBus, taskService, artifactStore, llmService);
    const devAgent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
    const codeReviewer = new CodeReviewerAgent(eventBus, taskService, artifactStore, llmService);

    pmAgent.start();
    pdAgent.start();
    devAgent.start();
    codeReviewer.start();

    const confirmations: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => confirmations.push(e));

    // Step 1: Submit requirement
    await eventBus.emit(
      EventType.UserRequirementSubmitted,
      'temp_proj',
      EventSource.User,
      { requirement: '我需要一个简单的待办事项应用', projectName: 'TodoApp' },
    );

    await new Promise((r) => setTimeout(r, 100));

    const projects = await projectService.listProjects();
    const project = projects[0];

    // Step 2: Confirm PRD
    const prdConfirm = confirmations.find(
      (c) => (c.payload as any).confirmationType === 'prd_review',
    );
    expect(prdConfirm).toBeTruthy();

    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'prd_review',
        taskId: (prdConfirm!.payload as any).taskId,
      },
    );

    await new Promise((r) => setTimeout(r, 200));

    // Step 3: Confirm design
    const designConfirm = confirmations.find(
      (c) => (c.payload as any).confirmationType === 'design_review',
    );
    expect(designConfirm).toBeTruthy();

    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'design_review',
        taskId: (designConfirm!.payload as any).taskId,
      },
    );

    // After design confirm, the chain is:
    // PM completes design → enters implementation → creates task →
    // Developer splits → SubAgents code → PM unblocks → Reviewer reviews →
    // Developer integrates → PM completes implementation
    // All serial through EventBus await.
    await new Promise((r) => setTimeout(r, 200));

    const finalProject = await projectService.getProject(project.projectId);
    expect(finalProject!.currentPhase).toBe(PhaseName.Testing);

    const integration = await artifactStore.load(project.projectId, 'implementation', 'integration-report.json');
    expect(integration).toBeTruthy();

    pmAgent.stop();
    pdAgent.stop();
    devAgent.stop();
    codeReviewer.stop();
  });
});
