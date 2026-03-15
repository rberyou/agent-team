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
import { ProductDesignerAgent } from '../../../src/agents/product-designer/index.js';
import { DeveloperAgent } from '../../../src/agents/developer/index.js';
import { CodeReviewerAgent } from '../../../src/agents/code-reviewer/index.js';
import { QAAgent } from '../../../src/agents/qa/index.js';
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

const SAMPLE_PRD = {
  title: '待办事项应用',
  version: '1.0',
  overview: '一个简单的待办事项管理应用',
  features: [
    {
      id: 'F001',
      name: '任务管理',
      description: '创建、编辑、删除和完成任务',
      priority: 'high',
      userStories: ['作为用户，我希望创建待办事项'],
      acceptanceCriteria: [
        '用户可以创建新任务',
        '用户可以标记任务为完成',
      ],
    },
  ],
  nonFunctionalRequirements: ['响应时间小于2秒'],
  assumptions: [],
  modules: [{ name: 'TaskModule', description: '任务管理', relatedFeatures: ['F001'] }],
};

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
      { name: 'TaskModule', responsibility: '任务管理CRUD', interfaces: ['createTask', 'getTask'] },
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

const SAMPLE_TEST_REPORT = {
  projectName: '待办事项应用',
  testPlan: [
    { id: 'TC-1-1', name: '任务管理 - 验收标准 1', description: '验证: 用户可以创建新任务', type: 'e2e', relatedFeature: 'F001' },
  ],
  testResults: [
    { testId: 'TC-1-1', status: 'passed', details: '测试通过' },
  ],
  coverage: { statement: 85, branch: 78, function: 90 },
  bugs: [],
  overallResult: 'passed',
  summary: '测试完成，全部通过',
};

let tempDir: string;
let eventBus: EventBus;
let projectService: ProjectService;
let taskService: TaskService;
let artifactStore: ArtifactStore;
let llmService: LLMService;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ta-test-'));
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
 * Setup project in testing phase with all upstream artifacts saved.
 * MUST be called BEFORE starting any agents.
 */
async function setupTestingPhase() {
  const project = await projectService.createProject('Test', '测试');
  await projectService.activateProject(project.projectId);
  await projectService.completePhase(project.projectId, PhaseName.Analysis);
  await projectService.enterPhase(project.projectId, PhaseName.Design);
  await projectService.completePhase(project.projectId, PhaseName.Design);
  await projectService.enterPhase(project.projectId, PhaseName.Implementation);
  await projectService.completePhase(project.projectId, PhaseName.Implementation);
  await projectService.enterPhase(project.projectId, PhaseName.Testing);

  // Save upstream artifacts
  await artifactStore.save(project.projectId, 'analysis', 'prd.json', SAMPLE_PRD);
  await artifactStore.save(project.projectId, 'design', 'design.json', SAMPLE_DESIGN);
  await artifactStore.save(project.projectId, 'implementation', 'integration-report.json', SAMPLE_INTEGRATION_REPORT);

  return project;
}

/**
 * Setup project in acceptance phase with all upstream artifacts saved.
 * MUST be called BEFORE starting any agents.
 */
async function setupAcceptancePhase() {
  const project = await setupTestingPhase();
  await projectService.completePhase(project.projectId, PhaseName.Testing);
  await projectService.enterPhase(project.projectId, PhaseName.Acceptance);

  // Save test report artifact
  await artifactStore.save(project.projectId, 'testing', 'test-report.json', SAMPLE_TEST_REPORT);

  return project;
}

// --- Tests ---

describe('QAAgent — Testing Phase', () => {
  it('should generate test report when testing task is created', async () => {
    const project = await setupTestingPhase();

    const qaAgent = new QAAgent(eventBus, taskService, artifactStore, llmService);
    qaAgent.start();

    const artifactEvents: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => artifactEvents.push(e));

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Testing,
      title: '系统测试',
      description: '执行系统测试',
      assignedTo: AgentRole.QA,
    });

    await new Promise((r) => setTimeout(r, 100));

    // Verify artifact was produced
    const testReportEvent = artifactEvents.find(
      (e) => (e.payload as any).artifactType === 'test_report',
    );
    expect(testReportEvent).toBeTruthy();
    expect((testReportEvent!.payload as any).taskId).toBeTruthy();

    // Verify test report saved
    const report = await artifactStore.load(project.projectId, 'testing', 'test-report.json') as any;
    expect(report).toBeTruthy();
    expect(report.overallResult).toBe('passed');
    expect(report.testPlan.length).toBeGreaterThan(0);
    expect(report.testResults.length).toBeGreaterThan(0);
    expect(report.bugs).toHaveLength(0);

    // Verify task is in review
    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Testing);
    const testTask = tasks.find((t) => t.title === '系统测试');
    expect(testTask!.status).toBe(TaskStatus.InReview);

    qaAgent.stop();
  });

  it('should ignore tasks not assigned to qa', async () => {
    const project = await setupTestingPhase();

    const qaAgent = new QAAgent(eventBus, taskService, artifactStore, llmService);
    qaAgent.start();

    const artifactEvents: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => artifactEvents.push(e));

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Testing,
      title: 'Other task',
      assignedTo: AgentRole.Developer,
    });

    await new Promise((r) => setTimeout(r, 50));

    const testReportEvents = artifactEvents.filter(
      (e) => (e.payload as any).artifactType === 'test_report',
    );
    expect(testReportEvents).toHaveLength(0);

    qaAgent.stop();
  });
});

describe('QAAgent — Acceptance Phase', () => {
  it('should generate acceptance report when acceptance task is created', async () => {
    const project = await setupAcceptancePhase();

    const qaAgent = new QAAgent(eventBus, taskService, artifactStore, llmService);
    qaAgent.start();

    const artifactEvents: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => artifactEvents.push(e));

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Acceptance,
      title: '项目验收',
      description: '执行项目验收',
      assignedTo: AgentRole.QA,
    });

    await new Promise((r) => setTimeout(r, 100));

    // Verify artifact was produced
    const acceptanceEvent = artifactEvents.find(
      (e) => (e.payload as any).artifactType === 'acceptance_report',
    );
    expect(acceptanceEvent).toBeTruthy();

    // Verify acceptance report saved
    const report = await artifactStore.load(project.projectId, 'acceptance', 'acceptance-report.json') as any;
    expect(report).toBeTruthy();
    expect(report.overallResult).toBe('approved');
    expect(report.criteriaResults.length).toBeGreaterThan(0);
    expect(report.featureVerification.length).toBeGreaterThan(0);

    // Verify task is in review
    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Acceptance);
    const acceptTask = tasks.find((t) => t.title === '项目验收');
    expect(acceptTask!.status).toBe(TaskStatus.InReview);

    qaAgent.stop();
  });
});

describe('QAAgent — Testing Phase rework', () => {
  it('should preserve previous test report during rework', async () => {
    const project = await setupTestingPhase();

    // Save an initial test report
    const originalReport = {
      projectName: 'Test App',
      testPlan: [{ id: 'TC-1', name: 'Login Test', description: 'Test login', type: 'e2e', relatedFeature: 'F001' }],
      testResults: [{ testId: 'TC-1', status: 'passed', details: 'OK' }],
      coverage: { statement: 80, branch: 70, function: 85 },
      bugs: [],
      overallResult: 'passed',
      summary: '原始测试报告',
    };
    await artifactStore.save(project.projectId, 'testing', 'test-report.json', originalReport);

    const qaAgent = new QAAgent(eventBus, taskService, artifactStore, llmService);
    qaAgent.start();

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Testing,
      title: '测试报告修订',
      description: '根据用户反馈修订测试报告:\n\n需要补充边界条件测试',
      assignedTo: AgentRole.QA,
    });

    await new Promise((r) => setTimeout(r, 100));

    const reworked = await artifactStore.load(project.projectId, 'testing', 'test-report.json') as any;
    expect(reworked).toBeTruthy();
    expect(reworked.projectName).toBe('Test App');
    expect(reworked.testPlan).toHaveLength(1);
    expect(reworked.coverage.statement).toBe(80);
    expect(reworked.summary).toContain('需要补充边界条件测试');

    qaAgent.stop();
  });
});

describe('QAAgent — Acceptance Phase rework', () => {
  it('should preserve previous acceptance report during rework', async () => {
    const project = await setupAcceptancePhase();

    // Save an initial acceptance report
    const originalReport = {
      projectName: 'Test App',
      criteriaResults: [{ criterionId: 'AC-1', description: '功能正常', result: 'met', evidence: '已验证' }],
      featureVerification: [{ featureId: 'F001', featureName: '用户管理', status: 'verified', notes: '通过' }],
      overallResult: 'approved',
      recommendations: ['建议优化性能'],
      summary: '原始验收报告',
    };
    await artifactStore.save(project.projectId, 'acceptance', 'acceptance-report.json', originalReport);

    const qaAgent = new QAAgent(eventBus, taskService, artifactStore, llmService);
    qaAgent.start();

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Acceptance,
      title: '验收报告修订',
      description: '根据用户反馈修订验收报告:\n\n安全测试不充分',
      assignedTo: AgentRole.QA,
    });

    await new Promise((r) => setTimeout(r, 100));

    const reworked = await artifactStore.load(project.projectId, 'acceptance', 'acceptance-report.json') as any;
    expect(reworked).toBeTruthy();
    expect(reworked.projectName).toBe('Test App');
    expect(reworked.criteriaResults).toHaveLength(1);
    expect(reworked.overallResult).toBe('approved');
    expect(reworked.recommendations.some((r: string) => r.includes('安全测试不充分'))).toBe(true);
    expect(reworked.summary).toContain('安全测试不充分');

    qaAgent.stop();
  });
});

describe('PM Agent — Testing/Acceptance Orchestration', () => {
  it('should create devops env config task when implementation phase completes', async () => {
    const project = await projectService.createProject('T', 'desc');
    await projectService.activateProject(project.projectId);
    await projectService.completePhase(project.projectId, PhaseName.Analysis);
    await projectService.enterPhase(project.projectId, PhaseName.Design);
    await projectService.completePhase(project.projectId, PhaseName.Design);
    await projectService.enterPhase(project.projectId, PhaseName.Implementation);

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    await projectService.completePhase(project.projectId, PhaseName.Implementation);

    await new Promise((r) => setTimeout(r, 100));

    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Testing);
    const devOpsTask = tasks.find((t) => t.title === '测试环境配置');
    expect(devOpsTask).toBeTruthy();
    expect(devOpsTask!.assignedTo).toBe(AgentRole.DevOps);

    pmAgent.stop();
  });

  it('should request user confirmation when test_report is produced', async () => {
    const project = await setupTestingPhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    const confirmEvents: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => confirmEvents.push(e));

    await eventBus.emit(
      EventType.ArtifactProduced,
      project.projectId,
      EventSource.AgentQA,
      {
        artifactType: 'test_report',
        taskId: 'task_test_1',
        path: 'artifacts/testing/test-report.json',
      },
      { phase: PhaseName.Testing },
    );

    await new Promise((r) => setTimeout(r, 50));

    const testConfirm = confirmEvents.find(
      (e) => (e.payload as any).confirmationType === 'test_review',
    );
    expect(testConfirm).toBeTruthy();
    expect((testConfirm!.payload as any).message).toContain('测试报告');

    pmAgent.stop();
  });

  it('should request user confirmation when preview_deployment is produced', async () => {
    const project = await setupAcceptancePhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    const confirmEvents: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => confirmEvents.push(e));

    await eventBus.emit(
      EventType.ArtifactProduced,
      project.projectId,
      EventSource.AgentQA,
      {
        artifactType: 'preview_deployment',
        taskId: 'task_preview_1',
        path: 'artifacts/acceptance/preview-deployment.json',
      },
      { phase: PhaseName.Acceptance },
    );

    await new Promise((r) => setTimeout(r, 50));

    const trialConfirm = confirmEvents.find(
      (e) => (e.payload as any).confirmationType === 'acceptance_trial',
    );
    expect(trialConfirm).toBeTruthy();
    expect((trialConfirm!.payload as any).message).toContain('预览环境已部署');

    pmAgent.stop();
  });

  it('should complete testing phase on user confirm and create acceptance task', async () => {
    const project = await setupTestingPhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    // Create a testing task first (so PM can transition it to done)
    const testTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Testing,
      title: '系统测试',
      assignedTo: AgentRole.QA,
    });
    await taskService.transitionTask(project.projectId, testTask.taskId, TaskStatus.InProgress);
    await taskService.transitionTask(project.projectId, testTask.taskId, TaskStatus.InReview);

    // User confirms test report
    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      { confirmationType: 'test_review', taskId: testTask.taskId },
    );

    await new Promise((r) => setTimeout(r, 100));

    // Testing task should be done
    const updatedTestTask = await taskService.getTask(project.projectId, testTask.taskId);
    expect(updatedTestTask!.status).toBe(TaskStatus.Done);

    // Acceptance task should be created (DevOps preview deployment)
    const acceptanceTasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Acceptance);
    const acceptTask = acceptanceTasks.find((t) => t.title === '预览环境部署');
    expect(acceptTask).toBeTruthy();
    expect(acceptTask!.assignedTo).toBe(AgentRole.DevOps);

    // Project should be in acceptance phase
    const updatedProject = await projectService.getProject(project.projectId);
    expect(updatedProject!.currentPhase).toBe(PhaseName.Acceptance);

    pmAgent.stop();
  });

  it('should create devops deployment task on acceptance_trial confirm', async () => {
    const project = await setupAcceptancePhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    // Create preview deploy task (already done by DevOps)
    const previewTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Acceptance,
      title: '预览环境部署',
      assignedTo: AgentRole.DevOps,
    });
    await taskService.transitionTask(project.projectId, previewTask.taskId, TaskStatus.InProgress);
    await taskService.transitionTask(project.projectId, previewTask.taskId, TaskStatus.Done);

    // User confirms acceptance trial → triggers DevOps production deployment task
    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      { confirmationType: 'acceptance_trial', taskId: previewTask.taskId },
    );

    await new Promise((r) => setTimeout(r, 100));

    // DevOps production deployment task should be created
    const acceptanceTasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Acceptance);
    const deployTask = acceptanceTasks.find((t) => t.title === '生产部署计划');
    expect(deployTask).toBeTruthy();
    expect(deployTask!.assignedTo).toBe(AgentRole.DevOps);

    pmAgent.stop();
  });

  it('should complete project after deployment_review confirm', async () => {
    const project = await setupAcceptancePhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    // Create deployment task
    const deployTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Acceptance,
      title: '生产部署计划',
      assignedTo: AgentRole.DevOps,
    });
    await taskService.transitionTask(project.projectId, deployTask.taskId, TaskStatus.InProgress);
    await taskService.transitionTask(project.projectId, deployTask.taskId, TaskStatus.InReview);

    // User confirms deployment plan
    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      { confirmationType: 'deployment_review', taskId: deployTask.taskId },
    );

    await new Promise((r) => setTimeout(r, 100));

    // Task should be done
    const updatedTask = await taskService.getTask(project.projectId, deployTask.taskId);
    expect(updatedTask!.status).toBe(TaskStatus.Done);

    // Project should be completed
    const updatedProject = await projectService.getProject(project.projectId);
    expect(updatedProject!.status).toBe(ProjectStatus.Completed);

    pmAgent.stop();
  });

  it('should create rework task on test report rejection', async () => {
    const project = await setupTestingPhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    await eventBus.emit(
      EventType.UserRejected,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'test_review',
        taskId: 'task_test_1',
        feedback: '测试覆盖不足',
      },
    );

    await new Promise((r) => setTimeout(r, 100));

    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Testing);
    const reworkTask = tasks.find((t) => t.title === '测试报告修订');
    expect(reworkTask).toBeTruthy();
    expect(reworkTask!.assignedTo).toBe(AgentRole.QA);
    expect(reworkTask!.description).toContain('测试覆盖不足');

    pmAgent.stop();
  });

  it('should create developer fix task on acceptance_trial rejection', async () => {
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
        feedback: '登录功能无法正常使用',
      },
    );

    await new Promise((r) => setTimeout(r, 100));

    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Acceptance);
    const fixTask = tasks.find((t) => t.title.includes('验收修复'));
    expect(fixTask).toBeTruthy();
    expect(fixTask!.assignedTo).toBe(AgentRole.Developer);
    expect(fixTask!.description).toContain('登录功能无法正常使用');

    pmAgent.stop();
  });

  it('should create rework task on deployment plan rejection', async () => {
    const project = await setupAcceptancePhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    await eventBus.emit(
      EventType.UserRejected,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'deployment_review',
        taskId: 'task_deploy_1',
        feedback: '需要增加灰度发布策略',
      },
    );

    await new Promise((r) => setTimeout(r, 100));

    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Acceptance);
    const reworkTask = tasks.find((t) => t.title === '部署计划修订');
    expect(reworkTask).toBeTruthy();
    expect(reworkTask!.assignedTo).toBe(AgentRole.DevOps);
    expect(reworkTask!.description).toContain('需要增加灰度发布策略');

    pmAgent.stop();
  });
});

describe('Full Testing Phase E2E (QA + PM, no LLM)', () => {
  it('should complete: create testing task → QA generates report → user confirms → phase done', async () => {
    const project = await setupTestingPhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    const qaAgent = new QAAgent(eventBus, taskService, artifactStore, llmService);

    pmAgent.start();
    qaAgent.start();

    const confirmEvents: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => confirmEvents.push(e));

    // PM creates testing task → QA auto-generates report → PM requests confirmation
    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Testing,
      title: '系统测试',
      description: '执行系统测试',
      assignedTo: AgentRole.QA,
    });

    await new Promise((r) => setTimeout(r, 200));

    // Verify test report artifact exists
    const report = await artifactStore.load(project.projectId, 'testing', 'test-report.json') as any;
    expect(report).toBeTruthy();
    expect(report.overallResult).toBe('passed');

    // Verify confirmation was requested
    const testConfirm = confirmEvents.find(
      (e) => (e.payload as any).confirmationType === 'test_review',
    );
    expect(testConfirm).toBeTruthy();

    // User confirms
    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'test_review',
        taskId: (testConfirm!.payload as any).taskId,
      },
    );

    await new Promise((r) => setTimeout(r, 100));

    // Phase should advance to acceptance
    const updatedProject = await projectService.getProject(project.projectId);
    expect(updatedProject!.currentPhase).toBe(PhaseName.Acceptance);

    pmAgent.stop();
    qaAgent.stop();
  });
});

describe('Full Acceptance Phase E2E (DevOps + PM, no LLM)', () => {
  it('should complete: DevOps preview → user confirms → DevOps deployment → user confirms → project completed', async () => {
    const project = await setupAcceptancePhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    const devOpsAgent = new DevOpsAgent(eventBus, taskService, artifactStore, llmService);

    pmAgent.start();
    devOpsAgent.start();

    const confirmEvents: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => confirmEvents.push(e));

    // Create preview deployment task → DevOps auto-generates → PM requests user trial
    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Acceptance,
      title: '预览环境部署',
      description: '将项目部署到预览环境，供用户验收试用',
      assignedTo: AgentRole.DevOps,
    });

    await new Promise((r) => setTimeout(r, 200));

    // Verify preview deployment artifact exists
    const preview = await artifactStore.load(project.projectId, 'acceptance', 'preview-deployment.json') as any;
    expect(preview).toBeTruthy();
    expect(preview.environment).toBe('preview');

    // Verify acceptance_trial confirmation was requested
    const trialConfirm = confirmEvents.find(
      (e) => (e.payload as any).confirmationType === 'acceptance_trial',
    );
    expect(trialConfirm).toBeTruthy();

    // User confirms acceptance trial → triggers DevOps production deployment task
    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'acceptance_trial',
        taskId: (trialConfirm!.payload as any).taskId,
      },
    );

    // Wait for DevOps to generate deployment plan
    await new Promise((r) => setTimeout(r, 200));

    // Verify deployment plan exists
    const deployPlan = await artifactStore.load(project.projectId, 'acceptance', 'deployment-plan.json') as any;
    expect(deployPlan).toBeTruthy();
    expect(deployPlan.strategy).toBe('rolling-update');

    // Verify deployment_review confirmation was requested
    const deployConfirm = confirmEvents.find(
      (e) => (e.payload as any).confirmationType === 'deployment_review',
    );
    expect(deployConfirm).toBeTruthy();

    // User confirms deployment plan → project completes
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

    // Project should be completed
    const updatedProject = await projectService.getProject(project.projectId);
    expect(updatedProject!.status).toBe(ProjectStatus.Completed);

    pmAgent.stop();
    devOpsAgent.stop();
  });
});

describe('Full 5-Phase E2E: Analysis → Design → Implementation → Testing → Acceptance', () => {
  it('should complete all five phases end-to-end', async () => {
    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    const pdAgent = new ProductDesignerAgent(eventBus, taskService, artifactStore, llmService);
    const devAgent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
    const codeReviewer = new CodeReviewerAgent(eventBus, taskService, artifactStore, llmService);
    const qaAgent = new QAAgent(eventBus, taskService, artifactStore, llmService);
    const devOpsAgent = new DevOpsAgent(eventBus, taskService, artifactStore, llmService);

    pmAgent.start();
    pdAgent.start();
    devAgent.start();
    codeReviewer.start();
    qaAgent.start();
    devOpsAgent.start();

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

    // Implementation phase runs automatically:
    // Developer splits → SubAgents code → PM unblocks → Reviewer reviews →
    // Developer integrates → PM completes implementation →
    // PM enters testing → DevOps generates env config → PM creates QA task →
    // QA generates test report
    await new Promise((r) => setTimeout(r, 400));

    // Step 4: Confirm test report
    const testConfirm = confirmations.find(
      (c) => (c.payload as any).confirmationType === 'test_review',
    );
    expect(testConfirm).toBeTruthy();

    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'test_review',
        taskId: (testConfirm!.payload as any).taskId,
      },
    );

    // Testing confirmed → PM enters acceptance → DevOps deploys preview
    await new Promise((r) => setTimeout(r, 300));

    // Step 5: Confirm acceptance trial (preview) → triggers DevOps production deployment
    const trialConfirm = confirmations.find(
      (c) => (c.payload as any).confirmationType === 'acceptance_trial',
    );
    expect(trialConfirm).toBeTruthy();

    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'acceptance_trial',
        taskId: (trialConfirm!.payload as any).taskId,
      },
    );

    // Wait for DevOps to generate deployment plan
    await new Promise((r) => setTimeout(r, 300));

    // Step 6: Confirm deployment plan → project completes
    const deployConfirm = confirmations.find(
      (c) => (c.payload as any).confirmationType === 'deployment_review',
    );
    expect(deployConfirm).toBeTruthy();

    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'deployment_review',
        taskId: (deployConfirm!.payload as any).taskId,
      },
    );

    await new Promise((r) => setTimeout(r, 200));

    // Verify: project is completed
    const finalProject = await projectService.getProject(project.projectId);
    expect(finalProject!.status).toBe(ProjectStatus.Completed);

    // Verify: all key artifacts exist
    const prd = await artifactStore.load(project.projectId, 'analysis', 'prd.json');
    expect(prd).toBeTruthy();

    const design = await artifactStore.load(project.projectId, 'design', 'design.json');
    expect(design).toBeTruthy();

    const integration = await artifactStore.load(project.projectId, 'implementation', 'integration-report.json');
    expect(integration).toBeTruthy();

    const envConfig = await artifactStore.load(project.projectId, 'testing', 'env-config.json');
    expect(envConfig).toBeTruthy();

    const testReport = await artifactStore.load(project.projectId, 'testing', 'test-report.json');
    expect(testReport).toBeTruthy();

    const previewDeployment = await artifactStore.load(project.projectId, 'acceptance', 'preview-deployment.json');
    expect(previewDeployment).toBeTruthy();

    const deploymentPlan = await artifactStore.load(project.projectId, 'acceptance', 'deployment-plan.json');
    expect(deploymentPlan).toBeTruthy();

    pmAgent.stop();
    pdAgent.stop();
    devAgent.stop();
    codeReviewer.stop();
    qaAgent.stop();
    devOpsAgent.stop();
  });
});
