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
import { CodeReviewerAgent } from '../../../src/agents/code-reviewer/index.js';
import { QAAgent } from '../../../src/agents/qa/index.js';
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
      acceptanceCriteria: ['用户可以创建新任务', '用户可以标记任务为完成'],
    },
  ],
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

/** Test report with bugs — triggers bug fix loop */
const TEST_REPORT_WITH_BUGS = {
  projectName: '待办事项应用',
  testPlan: [
    { id: 'TC-1', name: '创建任务测试', description: '验证创建任务功能', type: 'e2e', relatedFeature: 'F001' },
  ],
  testResults: [
    { testId: 'TC-1', status: 'failed', details: '创建任务后数据未持久化' },
  ],
  coverage: { statement: 75, branch: 60, function: 80 },
  bugs: [
    { id: 'BUG-001', severity: 'critical', description: '创建任务后数据未持久化到数据库', relatedModule: 'TaskModule' },
    { id: 'BUG-002', severity: 'major', description: '任务状态更新不触发事件通知', relatedModule: 'TaskModule' },
  ],
  overallResult: 'failed',
  summary: '测试发现2个Bug，其中1个严重',
};

/** Test report without bugs — goes to user confirmation */
const TEST_REPORT_PASSED = {
  projectName: '待办事项应用',
  testPlan: [
    { id: 'TC-1', name: '创建任务测试', description: '验证创建任务功能', type: 'e2e', relatedFeature: 'F001' },
  ],
  testResults: [
    { testId: 'TC-1', status: 'passed', details: '测试通过' },
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
let projectStore: ProjectStore;
let llmService: LLMService;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'bugfix-test-'));
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

async function setupTestingPhase() {
  const project = await projectService.createProject('Test', '测试');
  await projectService.activateProject(project.projectId);
  await projectService.completePhase(project.projectId, PhaseName.Analysis);
  await projectService.enterPhase(project.projectId, PhaseName.Design);
  await projectService.completePhase(project.projectId, PhaseName.Design);
  await projectService.enterPhase(project.projectId, PhaseName.Implementation);
  await projectService.completePhase(project.projectId, PhaseName.Implementation);
  await projectService.enterPhase(project.projectId, PhaseName.Testing);

  await artifactStore.save(project.projectId, 'analysis', 'prd.json', SAMPLE_PRD);
  await artifactStore.save(project.projectId, 'design', 'design.json', SAMPLE_DESIGN);
  await artifactStore.save(project.projectId, 'implementation', 'integration-report.json', SAMPLE_INTEGRATION_REPORT);

  return project;
}

// --- Tests ---

describe('PM Agent — Bug Detection in Test Report', () => {
  it('should create bug fix tasks when test report has bugs', async () => {
    const project = await setupTestingPhase();
    await artifactStore.save(project.projectId, 'testing', 'test-report.json', TEST_REPORT_WITH_BUGS);

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    const confirmEvents: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => confirmEvents.push(e));

    // Emit test_report artifact produced
    await eventBus.emit(
      EventType.ArtifactProduced,
      project.projectId,
      EventSource.AgentQA,
      { artifactType: 'test_report', taskId: 'task_test_1', path: 'artifacts/testing/test-report.json' },
      { phase: PhaseName.Testing },
    );

    await new Promise((r) => setTimeout(r, 100));

    // Should NOT request user confirmation (bugs found)
    const testConfirm = confirmEvents.find(
      (e) => (e.payload as any).confirmationType === 'test_review',
    );
    expect(testConfirm).toBeFalsy();

    // Should create Developer bug fix task
    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Testing);
    const bugFixTask = tasks.find((t) => t.assignedTo === AgentRole.Developer && t.title.includes('Bug修复'));
    expect(bugFixTask).toBeTruthy();
    expect(bugFixTask!.description).toContain('BUG-001');
    expect(bugFixTask!.description).toContain('BUG-002');

    // Review task is NOT created here — it will be created when bugfix artifact is produced.
    // This avoids synchronous event chain race condition.

    pmAgent.stop();
  });

  it('should request user confirmation when test report has no bugs', async () => {
    const project = await setupTestingPhase();
    await artifactStore.save(project.projectId, 'testing', 'test-report.json', TEST_REPORT_PASSED);

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    const confirmEvents: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => confirmEvents.push(e));

    await eventBus.emit(
      EventType.ArtifactProduced,
      project.projectId,
      EventSource.AgentQA,
      { artifactType: 'test_report', taskId: 'task_test_1', path: 'artifacts/testing/test-report.json' },
      { phase: PhaseName.Testing },
    );

    await new Promise((r) => setTimeout(r, 100));

    // Should request user confirmation (no bugs)
    const testConfirm = confirmEvents.find(
      (e) => (e.payload as any).confirmationType === 'test_review',
    );
    expect(testConfirm).toBeTruthy();

    // Should NOT create bug fix tasks
    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Testing);
    const bugFixTask = tasks.find((t) => t.assignedTo === AgentRole.Developer);
    expect(bugFixTask).toBeFalsy();

    pmAgent.stop();
  });

  it('should fall back to user confirmation when max fix rounds exceeded', async () => {
    const project = await setupTestingPhase();
    // Set maxRetryOnFailure to 1 for testing — must persist to store
    const proj = await projectService.getProject(project.projectId);
    proj!.config.maxRetryOnFailure = 1;
    await projectStore.save(proj!);
    await artifactStore.save(project.projectId, 'testing', 'test-report.json', TEST_REPORT_WITH_BUGS);

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    const confirmEvents: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => confirmEvents.push(e));

    // First round — should create bug fix tasks
    await eventBus.emit(
      EventType.ArtifactProduced,
      project.projectId,
      EventSource.AgentQA,
      { artifactType: 'test_report', taskId: 'task_test_1' },
      { phase: PhaseName.Testing },
    );

    await new Promise((r) => setTimeout(r, 100));
    expect(confirmEvents.filter((e) => (e.payload as any).confirmationType === 'test_review')).toHaveLength(0);

    // Second round — should fall back to user confirmation (exceeded limit of 1)
    await eventBus.emit(
      EventType.ArtifactProduced,
      project.projectId,
      EventSource.AgentQA,
      { artifactType: 'test_report', taskId: 'task_test_2' },
      { phase: PhaseName.Testing },
    );

    await new Promise((r) => setTimeout(r, 100));

    const testConfirm = confirmEvents.find(
      (e) => (e.payload as any).confirmationType === 'test_review',
    );
    expect(testConfirm).toBeTruthy();
    expect((testConfirm!.payload as any).message).toContain('最大修复轮次限制');

    pmAgent.stop();
  });
});

describe('Developer Agent — Bug Fix in Testing Phase', () => {
  it('should generate bugfix artifact when receiving bug fix task', async () => {
    const project = await setupTestingPhase();
    await artifactStore.save(project.projectId, 'testing', 'test-report.json', TEST_REPORT_WITH_BUGS);

    const devAgent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
    devAgent.start();

    const artifactEvents: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => artifactEvents.push(e));

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Testing,
      title: 'Bug修复 (第1轮)',
      description: '修复BUG-001和BUG-002',
      assignedTo: AgentRole.Developer,
      priority: 'critical',
    });

    await new Promise((r) => setTimeout(r, 200));

    // Verify bugfix artifact was produced
    const bugfixEvent = artifactEvents.find(
      (e) => (e.payload as any).artifactType === 'bugfix',
    );
    expect(bugfixEvent).toBeTruthy();

    // Verify bugfix artifact saved
    const bugfix = await artifactStore.load(project.projectId, 'testing', 'bugfix.json') as any;
    expect(bugfix).toBeTruthy();
    expect(bugfix.targetBugs).toHaveLength(2);
    expect(bugfix.fixes).toHaveLength(2);
    expect(bugfix.fixes[0].bugId).toBe('BUG-001');
    expect(bugfix.fixes[1].bugId).toBe('BUG-002');

    // Verify task is in review
    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Testing);
    const fixTask = tasks.find((t) => t.title.includes('Bug修复'));
    expect(fixTask!.status).toBe(TaskStatus.InReview);

    devAgent.stop();
  });
});

describe('PM Agent — Bug Fix Completion Triggers QA Retest', () => {
  it('should create QA retest task when Developer bug fix task completes', async () => {
    const project = await setupTestingPhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    // Create and complete a Developer bug fix task in Testing phase
    const bugFixTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Testing,
      title: 'Bug修复 (第1轮)',
      assignedTo: AgentRole.Developer,
    });
    await taskService.transitionTask(project.projectId, bugFixTask.taskId, TaskStatus.InProgress);
    await taskService.transitionTask(project.projectId, bugFixTask.taskId, TaskStatus.InReview);
    await taskService.transitionTask(project.projectId, bugFixTask.taskId, TaskStatus.Done, 'Bug fix passed review');

    await new Promise((r) => setTimeout(r, 100));

    // Verify QA retest task was created
    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Testing);
    const retestTask = tasks.find((t) => t.title === '回归测试');
    expect(retestTask).toBeTruthy();
    expect(retestTask!.assignedTo).toBe(AgentRole.QA);
    expect(retestTask!.description).toContain('Bug修复已完成');

    pmAgent.stop();
  });
});

describe('PM Agent — Bugfix Artifact Unblocks Review', () => {
  it('should unblock Testing review task when bugfix artifact is produced', async () => {
    const project = await setupTestingPhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    pmAgent.start();

    // Create a bug fix task and a blocked review task
    const bugFixTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Testing,
      title: 'Bug修复 (第1轮)',
      assignedTo: AgentRole.Developer,
    });

    const reviewTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Testing,
      title: 'Bug修复代码审查 (第1轮)',
      assignedTo: AgentRole.CodeReviewer,
    });
    await taskService.updateTask(project.projectId, reviewTask.taskId, {
      blockedBy: [bugFixTask.taskId],
    });
    await taskService.transitionTask(project.projectId, reviewTask.taskId, TaskStatus.Blocked);

    // Emit bugfix artifact produced
    await eventBus.emit(
      EventType.ArtifactProduced,
      project.projectId,
      EventSource.AgentDeveloper,
      { artifactType: 'bugfix', taskId: bugFixTask.taskId, path: 'artifacts/testing/bugfix.json' },
      { phase: PhaseName.Testing },
    );

    await new Promise((r) => setTimeout(r, 100));

    // Verify review task was unblocked
    const updatedReview = await taskService.getTask(project.projectId, reviewTask.taskId);
    expect(updatedReview!.status).toBe(TaskStatus.InProgress);

    pmAgent.stop();
  });
});

describe('CodeReviewer Agent — Testing Phase Bug Fix Review', () => {
  it('should review bugfix artifact in Testing phase', async () => {
    const project = await setupTestingPhase();

    // Save bugfix artifact for reviewer to load
    const bugfix = {
      targetBugs: TEST_REPORT_WITH_BUGS.bugs,
      fixes: [
        { bugId: 'BUG-001', moduleName: 'TaskModule', description: '修复持久化', files: [] },
        { bugId: 'BUG-002', moduleName: 'TaskModule', description: '修复事件通知', files: [] },
      ],
      summary: '修复2个Bug',
    };
    await artifactStore.save(project.projectId, 'testing', 'bugfix.json', bugfix);
    await artifactStore.save(project.projectId, 'testing', 'test-report.json', TEST_REPORT_WITH_BUGS);

    const codeReviewer = new CodeReviewerAgent(eventBus, taskService, artifactStore, llmService);
    codeReviewer.start();

    const reviewEvents: Event[] = [];
    eventBus.subscribe(EventType.ReviewCompleted, (e) => reviewEvents.push(e));

    // Create bug fix task and review task (unblocked = InProgress)
    const bugFixTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Testing,
      title: 'Bug修复 (第1轮)',
      assignedTo: AgentRole.Developer,
    });
    await taskService.transitionTask(project.projectId, bugFixTask.taskId, TaskStatus.InProgress);

    const reviewTask = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Testing,
      title: 'Bug修复代码审查 (第1轮)',
      assignedTo: AgentRole.CodeReviewer,
    });
    await taskService.updateTask(project.projectId, reviewTask.taskId, {
      blockedBy: [bugFixTask.taskId],
    });

    // Transition review task to in_progress (simulating PM unblock via TaskStarted)
    await taskService.transitionTask(
      project.projectId, reviewTask.taskId, TaskStatus.InProgress,
      'Bugfix produced, starting review',
    );

    await new Promise((r) => setTimeout(r, 200));

    // Verify review.completed was emitted
    const reviewEvent = reviewEvents.find(
      (e) => (e.payload as any).subTaskId === bugFixTask.taskId,
    );
    expect(reviewEvent).toBeTruthy();
    expect((reviewEvent!.payload as any).result).toBe('passed'); // fallback always passes
    expect(reviewEvent!.phase).toBe(PhaseName.Testing);

    // Verify review report saved
    const report = await artifactStore.load(project.projectId, 'testing', 'bugfix-review.json') as any;
    expect(report).toBeTruthy();
    expect(report.result).toBe('passed');

    // Verify review task completed
    const updatedReviewTask = await taskService.getTask(project.projectId, reviewTask.taskId);
    expect(updatedReviewTask!.status).toBe(TaskStatus.Done);

    codeReviewer.stop();
  });
});

describe('Full Bug Feedback Loop E2E', () => {
  it('should complete: QA finds bugs → PM → Dev fix → Review → Dev done → PM creates retest', async () => {
    const project = await setupTestingPhase();

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    const devAgent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
    const codeReviewer = new CodeReviewerAgent(eventBus, taskService, artifactStore, llmService);

    pmAgent.start();
    devAgent.start();
    codeReviewer.start();

    // Save test report with bugs
    await artifactStore.save(project.projectId, 'testing', 'test-report.json', TEST_REPORT_WITH_BUGS);

    // Trigger: PM receives test_report artifact with bugs
    await eventBus.emit(
      EventType.ArtifactProduced,
      project.projectId,
      EventSource.AgentQA,
      { artifactType: 'test_report', taskId: 'task_qa_1', path: 'artifacts/testing/test-report.json' },
      { phase: PhaseName.Testing },
    );

    // Wait for full chain: PM detects bugs → creates fix+review tasks →
    // Developer generates fix → PM unblocks review → CodeReviewer reviews →
    // Developer marks done → PM creates QA retest task
    await new Promise((r) => setTimeout(r, 1000));

    // Verify: bugfix artifact was created
    const bugfix = await artifactStore.load(project.projectId, 'testing', 'bugfix.json') as any;
    expect(bugfix).toBeTruthy();
    expect(bugfix.targetBugs.length).toBeGreaterThan(0);
    expect(bugfix.fixes.length).toBeGreaterThan(0);

    // Verify: bugfix review was created (fallback always passes)
    const review = await artifactStore.load(project.projectId, 'testing', 'bugfix-review.json') as any;
    expect(review).toBeTruthy();
    expect(review.result).toBe('passed');

    // Verify: Developer bug fix task completed
    const tasks = await taskService.listTasksByPhase(project.projectId, PhaseName.Testing);
    const bugFixTask = tasks.find((t) => t.assignedTo === AgentRole.Developer && t.title.includes('Bug修复'));
    expect(bugFixTask).toBeTruthy();
    expect(bugFixTask!.status).toBe(TaskStatus.Done);
    expect(bugFixTask!.reviewStatus).toBe('approved');

    // Verify: CodeReviewer review task completed
    const reviewTask = tasks.find((t) => t.assignedTo === AgentRole.CodeReviewer && t.title.includes('Bug修复代码审查'));
    expect(reviewTask).toBeTruthy();
    expect(reviewTask!.status).toBe(TaskStatus.Done);

    // Verify: PM created QA retest task
    const retestTask = tasks.find((t) => t.title === '回归测试');
    expect(retestTask).toBeTruthy();
    expect(retestTask!.assignedTo).toBe(AgentRole.QA);

    pmAgent.stop();
    devAgent.stop();
    codeReviewer.stop();
  });
});
