import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { DeveloperAgent } from '../../../src/agents/developer/index.js';
import { DevOpsAgent } from '../../../src/agents/devops/index.js';
import { LLMService, PromptLoader, OpenAICompatibleProvider } from '../../../src/core/llm/index.js';
import type { LLMConfig } from '../../../src/core/llm/index.js';
import {
  EventType,
  EventSource,
  PhaseName,
  TaskStatus,
  AgentRole,
  ProjectStatus,
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

const SAMPLE_DESIGN = {
  projectName: '待办事项应用',
  version: '1.0',
  techStack: {
    frontend: [],
    backend: [{ name: 'Node.js', reason: 'TypeScript support' }],
    database: [{ name: 'SQLite', reason: 'Lightweight' }],
    infrastructure: [],
  },
  architecture: {
    pattern: '分层架构',
    description: '经典分层架构',
    components: [
      { name: 'TaskModule', responsibility: '任务管理CRUD', interfaces: ['createTask'] },
    ],
    dataModels: [],
  },
  apiSpec: {
    baseUrl: '/api',
    endpoints: [{ method: 'POST', path: '/tasks', summary: '创建任务' }],
  },
};

const SAMPLE_INTEGRATION_REPORT = {
  result: 'passed',
  modules: ['TaskModule'],
  issues: [],
  summary: '1 个模块集成验证通过',
};

let tempDir: string;
let eventBus: EventBus;
let projectService: ProjectService;
let taskService: TaskService;
let artifactStore: ArtifactStore;
let projectStore: ProjectStore;
let llmService: LLMService;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'at-test-'));
  const fileStore = new FileStore();
  const eventStore = new EventStore(fileStore, tempDir);
  projectStore = new ProjectStore(fileStore, tempDir);
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

async function setupAcceptancePhase() {
  const project = await projectService.createProject('Test', '测试');
  await projectService.activateProject(project.projectId);
  await projectService.completePhase(project.projectId, PhaseName.Analysis);
  await projectService.enterPhase(project.projectId, PhaseName.Design);
  await projectService.completePhase(project.projectId, PhaseName.Design);
  await projectService.enterPhase(project.projectId, PhaseName.Implementation);
  await projectService.completePhase(project.projectId, PhaseName.Implementation);
  await projectService.enterPhase(project.projectId, PhaseName.Testing);
  await projectService.completePhase(project.projectId, PhaseName.Testing);
  await projectService.enterPhase(project.projectId, PhaseName.Acceptance);

  // Save upstream artifacts
  await artifactStore.save(project.projectId, 'design', 'design.json', SAMPLE_DESIGN);
  await artifactStore.save(project.projectId, 'implementation', 'integration-report.json', SAMPLE_INTEGRATION_REPORT);

  return project;
}

// --- PM Agent Orchestration Tests ---

describe('Acceptance Trial — PM Agent Orchestration', () => {
  it('should create DevOps preview deployment task when testing phase completes', async () => {
    // Setup project in testing phase (not yet acceptance)
    const project = await projectService.createProject('T', 'desc');
    await projectService.activateProject(project.projectId);
    await projectService.completePhase(project.projectId, PhaseName.Analysis);
    await projectService.enterPhase(project.projectId, PhaseName.Design);
    await projectService.completePhase(project.projectId, PhaseName.Design);
    await projectService.enterPhase(project.projectId, PhaseName.Implementation);
    await projectService.completePhase(project.projectId, PhaseName.Implementation);
    await projectService.enterPhase(project.projectId, PhaseName.Testing);

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    await projectService.completePhase(project.projectId, PhaseName.Testing);

    await new Promise((r) => setTimeout(r, 100));

    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Acceptance);
    const previewTask = tasks.find((t) => t.title === '预览环境部署');
    expect(previewTask).toBeTruthy();
    expect(previewTask!.assignedTo).toBe(AgentRole.DevOps);

    pmAgent.stop();
  });

  it('should emit acceptance_trial when preview_deployment artifact is produced', async () => {
    const project = await setupAcceptancePhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    const confirmEvents: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => confirmEvents.push(e));

    await eventBus.emit(
      EventType.ArtifactProduced,
      project.projectId,
      EventSource.AgentDevOps,
      {
        artifactType: 'preview_deployment',
        taskId: 'task_preview_1',
        path: 'artifacts/acceptance/preview-deployment.json',
      },
      { phase: PhaseName.Acceptance },
    );

    const trialConfirm = confirmEvents.find(
      (e) => (e.payload as any).confirmationType === 'acceptance_trial',
    );
    expect(trialConfirm).toBeTruthy();
    expect((trialConfirm!.payload as any).message).toContain('预览环境已部署');

    pmAgent.stop();
  });

  it('should create DevOps production deployment task on acceptance_trial confirm', async () => {
    const project = await setupAcceptancePhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      { confirmationType: 'acceptance_trial', taskId: 'task_preview_1' },
    );

    await new Promise((r) => setTimeout(r, 100));

    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Acceptance);
    const deployTask = tasks.find((t) => t.title === '生产部署计划');
    expect(deployTask).toBeTruthy();
    expect(deployTask!.assignedTo).toBe(AgentRole.DevOps);

    pmAgent.stop();
  });

  it('should create Developer fix task on acceptance_trial rejection', async () => {
    const project = await setupAcceptancePhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    await eventBus.emit(
      EventType.UserRejected,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'acceptance_trial',
        taskId: 'task_preview_1',
        feedback: '登录按钮点击无反应',
      },
    );

    await new Promise((r) => setTimeout(r, 100));

    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Acceptance);
    const fixTask = tasks.find((t) => t.title.includes('验收修复'));
    expect(fixTask).toBeTruthy();
    expect(fixTask!.assignedTo).toBe(AgentRole.Developer);
    expect(fixTask!.priority).toBe('critical');
    expect(fixTask!.description).toContain('登录按钮点击无反应');

    pmAgent.stop();
  });

  it('should create DevOps redeploy task when Developer acceptance fix completes', async () => {
    const project = await setupAcceptancePhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    // Create a Developer fix task and complete it
    const fixTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Acceptance,
      title: '验收修复 (第1轮)',
      assignedTo: AgentRole.Developer,
    });
    await taskService.transitionTask(project.projectId, fixTask.taskId, TaskStatus.InProgress);
    await taskService.transitionTask(project.projectId, fixTask.taskId, TaskStatus.Done);

    await new Promise((r) => setTimeout(r, 100));

    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Acceptance);
    const redeployTask = tasks.find((t) => t.title === '预览环境更新');
    expect(redeployTask).toBeTruthy();
    expect(redeployTask!.assignedTo).toBe(AgentRole.DevOps);

    pmAgent.stop();
  });

  it('should escalate when acceptance fix rounds exceed maxRetryOnFailure', async () => {
    const project = await setupAcceptancePhase();

    // Set maxRetryOnFailure to 1 — must persist to store
    const proj = await projectService.getProject(project.projectId);
    proj!.config.maxRetryOnFailure = 1;
    await projectStore.save(proj!);

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    const confirmEvents: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => confirmEvents.push(e));

    // First rejection — should create Developer fix task
    await eventBus.emit(
      EventType.UserRejected,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'acceptance_trial',
        feedback: '第一次反馈',
      },
    );

    await new Promise((r) => setTimeout(r, 100));

    const tasks1 = await taskService.listTasksByPhase(project.projectId, PhaseName.Acceptance);
    const fixTask1 = tasks1.find((t) => t.title.includes('验收修复'));
    expect(fixTask1).toBeTruthy();

    // Second rejection — should escalate (exceeded limit of 1)
    await eventBus.emit(
      EventType.UserRejected,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'acceptance_trial',
        feedback: '第二次反馈',
      },
    );

    await new Promise((r) => setTimeout(r, 100));

    // Should emit a warning confirmation instead of creating another fix task
    const warningConfirm = confirmEvents.find(
      (e) => (e.payload as any).message?.includes('最大修复轮次限制'),
    );
    expect(warningConfirm).toBeTruthy();

    pmAgent.stop();
  });
});

// --- DevOps Agent Tests ---

describe('Acceptance Trial — DevOps Agent', () => {
  it('should generate preview-deployment.json and auto-complete', async () => {
    const project = await setupAcceptancePhase();

    const devOpsAgent = new DevOpsAgent(eventBus, taskService, artifactStore, llmService);
    devOpsAgent.start();

    const artifactEvents: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => artifactEvents.push(e));

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Acceptance,
      title: '预览环境部署',
      description: '将项目部署到预览环境，供用户验收试用',
      assignedTo: AgentRole.DevOps,
    });

    await new Promise((r) => setTimeout(r, 100));

    // Verify artifact
    const preview = await artifactStore.load(project.projectId, 'acceptance', 'preview-deployment.json') as any;
    expect(preview).toBeTruthy();
    expect(preview.environment).toBe('preview');
    expect(preview.previewUrl).toBeTruthy();
    expect(preview.services.length).toBeGreaterThan(0);

    // Verify artifact event
    const previewEvent = artifactEvents.find(
      (e) => (e.payload as any).artifactType === 'preview_deployment',
    );
    expect(previewEvent).toBeTruthy();

    // Verify task auto-completed (Done)
    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Acceptance);
    const previewTask = tasks.find((t) => t.title === '预览环境部署');
    expect(previewTask!.status).toBe(TaskStatus.Done);

    devOpsAgent.stop();
  });

  it('should detect rework mode when preview-deployment.json already exists', async () => {
    const project = await setupAcceptancePhase();

    // Save previous deployment
    await artifactStore.save(project.projectId, 'acceptance', 'preview-deployment.json', {
      previewUrl: 'http://preview.localhost:3000',
      environment: 'preview',
      services: [],
      deployedAt: '2026-01-01T00:00:00Z',
      buildInfo: { version: '1.0.0-preview', modules: [] },
      summary: '初次部署',
    });

    const devOpsAgent = new DevOpsAgent(eventBus, taskService, artifactStore, llmService);
    devOpsAgent.start();

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Acceptance,
      title: '预览环境更新',
      description: '验收修复已完成，请更新预览环境部署',
      assignedTo: AgentRole.DevOps,
    });

    await new Promise((r) => setTimeout(r, 100));

    const updated = await artifactStore.load(project.projectId, 'acceptance', 'preview-deployment.json') as any;
    expect(updated).toBeTruthy();
    // Rework mode generates version 1.0.1-preview
    expect(updated.buildInfo.version).toBe('1.0.1-preview');
    expect(updated.summary).toContain('已更新');

    devOpsAgent.stop();
  });
});

// --- Developer Agent Tests ---

describe('Acceptance Trial — Developer Agent', () => {
  it('should generate acceptance-fix.json and transition to Done (no InReview)', async () => {
    const project = await setupAcceptancePhase();

    // Save preview deployment for Developer to load
    await artifactStore.save(project.projectId, 'acceptance', 'preview-deployment.json', {
      previewUrl: 'http://preview.localhost:3000',
      environment: 'preview',
      services: [{ name: 'app', status: 'running', port: 3000 }],
      deployedAt: new Date().toISOString(),
      buildInfo: { version: '1.0.0-preview', modules: ['TaskModule'] },
      summary: '预览环境已部署',
    });

    const devAgent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
    devAgent.start();

    const artifactEvents: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => artifactEvents.push(e));

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Acceptance,
      title: '验收修复 (第1轮)',
      description: '根据用户试用反馈修复问题:\n\n登录按钮无法点击',
      assignedTo: AgentRole.Developer,
    });

    await new Promise((r) => setTimeout(r, 100));

    // Verify fix artifact
    const fix = await artifactStore.load(project.projectId, 'acceptance', 'acceptance-fix.json') as any;
    expect(fix).toBeTruthy();
    expect(fix.userFeedback).toContain('登录按钮无法点击');
    expect(fix.fixes.length).toBeGreaterThan(0);

    // Verify artifact event
    const fixEvent = artifactEvents.find(
      (e) => (e.payload as any).artifactType === 'acceptance_fix',
    );
    expect(fixEvent).toBeTruthy();

    // Verify task is Done (NOT InReview — no Code Review)
    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Acceptance);
    const fixTask = tasks.find((t) => t.title.includes('验收修复'));
    expect(fixTask!.status).toBe(TaskStatus.Done);

    devAgent.stop();
  });
});

// --- E2E Tests ---

describe('Acceptance Trial — Full Feedback Loop E2E', () => {
  it('should complete: DevOps preview → user reject → Developer fix → DevOps redeploy → user confirm → production deploy', async () => {
    const project = await setupAcceptancePhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    const devAgent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
    const devOpsAgent = new DevOpsAgent(eventBus, taskService, artifactStore, llmService);

    pmAgent.start();
    devAgent.start();
    devOpsAgent.start();

    const confirmEvents: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => confirmEvents.push(e));

    // Step 1: Create preview deployment task (PM would do this on phase enter)
    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Acceptance,
      title: '预览环境部署',
      description: '将项目部署到预览环境，供用户验收试用',
      assignedTo: AgentRole.DevOps,
    });

    await new Promise((r) => setTimeout(r, 200));

    // Verify: preview deployed + user notified
    const preview = await artifactStore.load(project.projectId, 'acceptance', 'preview-deployment.json') as any;
    expect(preview).toBeTruthy();

    const firstTrial = confirmEvents.find(
      (e) => (e.payload as any).confirmationType === 'acceptance_trial',
    );
    expect(firstTrial).toBeTruthy();

    // Step 2: User rejects with feedback
    await eventBus.emit(
      EventType.UserRejected,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'acceptance_trial',
        taskId: (firstTrial!.payload as any).taskId,
        feedback: '数据列表不能翻页',
      },
    );

    // Full chain fires synchronously:
    // PM creates Developer fix → Developer generates fix → Done
    // → PM creates DevOps redeploy → DevOps updates preview → Done
    // → PM receives preview_deployment → notifies user
    await new Promise((r) => setTimeout(r, 300));

    // Verify: acceptance fix was generated
    const fix = await artifactStore.load(project.projectId, 'acceptance', 'acceptance-fix.json') as any;
    expect(fix).toBeTruthy();

    // Verify: preview was redeployed (updated)
    const updatedPreview = await artifactStore.load(project.projectId, 'acceptance', 'preview-deployment.json') as any;
    expect(updatedPreview).toBeTruthy();
    expect(updatedPreview.summary).toContain('已更新');

    // Verify: second acceptance_trial confirmation was sent
    const secondTrial = confirmEvents.filter(
      (e) => (e.payload as any).confirmationType === 'acceptance_trial',
    );
    expect(secondTrial.length).toBeGreaterThanOrEqual(2);

    // Step 3: User confirms
    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'acceptance_trial',
        taskId: secondTrial[secondTrial.length - 1].payload
          ? (secondTrial[secondTrial.length - 1].payload as any).taskId
          : undefined,
      },
    );

    await new Promise((r) => setTimeout(r, 300));

    // Verify: deployment plan was generated
    const deployPlan = await artifactStore.load(project.projectId, 'acceptance', 'deployment-plan.json') as any;
    expect(deployPlan).toBeTruthy();
    expect(deployPlan.strategy).toBe('rolling-update');

    // Verify: deployment_review confirmation was sent
    const deployConfirm = confirmEvents.find(
      (e) => (e.payload as any).confirmationType === 'deployment_review',
    );
    expect(deployConfirm).toBeTruthy();

    // Step 4: User confirms deployment → project complete
    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'deployment_review',
        taskId: (deployConfirm!.payload as any).taskId,
      },
    );

    await new Promise((r) => setTimeout(r, 100));

    const finalProject = await projectService.getProject(project.projectId);
    expect(finalProject!.status).toBe(ProjectStatus.Completed);

    pmAgent.stop();
    devAgent.stop();
    devOpsAgent.stop();
  });
});
