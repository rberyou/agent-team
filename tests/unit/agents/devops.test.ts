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
import { DevOpsAgent } from '../../../src/agents/devops/index.js';
import { LLMService, PromptLoader, OpenAICompatibleProvider } from '../../../src/core/llm/index.js';
import type { LLMConfig } from '../../../src/core/llm/index.js';
import {
  EventType,
  EventSource,
  PhaseName,
  AgentRole,
  TaskStatus,
} from '../../../src/core/models/index.js';
import type { Event } from '../../../src/core/models/index.js';

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
  projectName: 'Test App',
  techStack: {
    runtime: 'Node.js',
    database: 'PostgreSQL',
    backend: [{ name: 'Node.js', reason: 'TypeScript support' }],
    infrastructure: [],
  },
  architecture: {
    pattern: 'layered',
    description: 'Layered architecture',
    components: [
      { name: 'API', responsibility: 'REST endpoints', interfaces: ['createUser'] },
    ],
    dataModels: [],
  },
};

const SAMPLE_INTEGRATION_REPORT = {
  result: 'passed',
  modules: ['API'],
  issues: [],
  summary: '1 module integration passed',
};

const SAMPLE_PRD = {
  title: 'Test App',
  overview: 'A test application',
  features: [
    {
      id: 'F001',
      name: 'User Management',
      description: 'User CRUD',
      priority: 'high',
      userStories: ['As a user, I want to register'],
      acceptanceCriteria: ['User can register'],
    },
  ],
  modules: [{ name: 'UserModule', description: 'Manages users', relatedFeatures: ['F001'] }],
};

const SAMPLE_TEST_REPORT = {
  projectName: 'Test App',
  testPlan: [
    { id: 'TC-1-1', name: 'User registration test', type: 'e2e', relatedFeature: 'F001' },
  ],
  testResults: [{ testId: 'TC-1-1', status: 'passed', details: 'OK' }],
  coverage: { statement: 85, branch: 78, function: 90 },
  bugs: [],
  overallResult: 'passed',
  summary: 'All tests passed',
};

const SAMPLE_ACCEPTANCE_REPORT = {
  overallResult: 'approved',
  criteriaResults: [{ criteriaId: 'AC1', status: 'passed' }],
  featureVerification: [{ featureId: 'F001', status: 'passed' }],
  summary: 'All acceptance criteria met',
};

let tempDir: string;
let eventBus: EventBus;
let projectService: ProjectService;
let taskService: TaskService;
let artifactStore: ArtifactStore;
let llmService: LLMService;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'devops-test-'));
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

async function setupTestingPhase() {
  const project = await projectService.createProject('DevOps Test', 'test');
  await projectService.activateProject(project.projectId);
  await projectService.completePhase(project.projectId, PhaseName.Analysis);
  await projectService.enterPhase(project.projectId, PhaseName.Design);
  await projectService.completePhase(project.projectId, PhaseName.Design);
  await projectService.enterPhase(project.projectId, PhaseName.Implementation);
  await projectService.completePhase(project.projectId, PhaseName.Implementation);
  await projectService.enterPhase(project.projectId, PhaseName.Testing);

  await artifactStore.save(project.projectId, 'design', 'design.json', SAMPLE_DESIGN);
  await artifactStore.save(project.projectId, 'implementation', 'integration-report.json', SAMPLE_INTEGRATION_REPORT);

  return project;
}

async function setupAcceptancePhase() {
  const project = await setupTestingPhase();
  await projectService.completePhase(project.projectId, PhaseName.Testing);
  await projectService.enterPhase(project.projectId, PhaseName.Acceptance);

  await artifactStore.save(project.projectId, 'analysis', 'prd.json', SAMPLE_PRD);
  await artifactStore.save(project.projectId, 'testing', 'test-report.json', SAMPLE_TEST_REPORT);
  await artifactStore.save(project.projectId, 'acceptance', 'acceptance-report.json', SAMPLE_ACCEPTANCE_REPORT);

  return project;
}

describe('DevOpsAgent — Testing Phase (env config)', () => {
  it('should generate env config and auto-complete task', async () => {
    const project = await setupTestingPhase();

    const devOpsAgent = new DevOpsAgent(eventBus, taskService, artifactStore, llmService);
    devOpsAgent.start();

    const artifactEvents: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => artifactEvents.push(e));

    const task = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Testing,
      title: '测试环境配置',
      description: '配置测试环境',
      assignedTo: AgentRole.DevOps,
    });

    await new Promise((r) => setTimeout(r, 100));

    // Verify env_config artifact was produced
    const envConfigEvent = artifactEvents.find(
      (e) => (e.payload as any).artifactType === 'env_config',
    );
    expect(envConfigEvent).toBeTruthy();
    expect((envConfigEvent!.payload as any).taskId).toBe(task.taskId);

    // Verify env config saved
    const config = (await artifactStore.load(project.projectId, 'testing', 'env-config.json')) as any;
    expect(config).toBeTruthy();
    expect(config.environment).toBe('test');
    expect(config.services.length).toBeGreaterThan(0);
    expect(config.dependencies.length).toBeGreaterThan(0);
    expect(config.configuration.runtime).toBeTruthy();

    // Verify task is auto-completed (Done, not InReview)
    const updatedTask = await taskService.getTask(project.projectId, task.taskId);
    expect(updatedTask!.status).toBe(TaskStatus.Done);

    devOpsAgent.stop();
  });

  it('should ignore tasks not assigned to devops', async () => {
    const project = await setupTestingPhase();

    const devOpsAgent = new DevOpsAgent(eventBus, taskService, artifactStore, llmService);
    devOpsAgent.start();

    const artifactEvents: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => artifactEvents.push(e));

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Testing,
      title: 'QA testing task',
      assignedTo: AgentRole.QA,
    });

    await new Promise((r) => setTimeout(r, 50));

    const devOpsEvents = artifactEvents.filter(
      (e) => (e.payload as any).artifactType === 'env_config',
    );
    expect(devOpsEvents).toHaveLength(0);

    devOpsAgent.stop();
  });
});

describe('DevOpsAgent — Acceptance Phase (deployment plan)', () => {
  it('should generate deployment plan and submit for review', async () => {
    const project = await setupAcceptancePhase();

    const devOpsAgent = new DevOpsAgent(eventBus, taskService, artifactStore, llmService);
    devOpsAgent.start();

    const artifactEvents: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => artifactEvents.push(e));

    const task = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Acceptance,
      title: '生产部署计划',
      description: '制定部署方案',
      assignedTo: AgentRole.DevOps,
    });

    await new Promise((r) => setTimeout(r, 100));

    // Verify deployment_plan artifact was produced
    const deployEvent = artifactEvents.find(
      (e) => (e.payload as any).artifactType === 'deployment_plan',
    );
    expect(deployEvent).toBeTruthy();
    expect((deployEvent!.payload as any).taskId).toBe(task.taskId);

    // Verify deployment plan saved
    const plan = (await artifactStore.load(project.projectId, 'acceptance', 'deployment-plan.json')) as any;
    expect(plan).toBeTruthy();
    expect(plan.environment).toBe('production');
    expect(plan.strategy).toBe('rolling-update');
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.rollbackPlan).toBeTruthy();
    expect(plan.rollbackPlan.steps.length).toBeGreaterThan(0);
    expect(plan.monitoring).toBeTruthy();
    expect(plan.risks.length).toBeGreaterThan(0);

    // Verify task is in review (NOT auto-completed)
    const updatedTask = await taskService.getTask(project.projectId, task.taskId);
    expect(updatedTask!.status).toBe(TaskStatus.InReview);

    devOpsAgent.stop();
  });

  it('should preserve previous deployment plan during rework', async () => {
    const project = await setupAcceptancePhase();

    // Save initial deployment plan
    const originalPlan = {
      environment: 'production',
      strategy: 'blue-green',
      steps: [
        { order: 1, name: '预检查', description: '验证环境', automated: true },
        { order: 2, name: '部署', description: '执行部署', automated: true },
      ],
      rollbackPlan: { trigger: '健康检查失败', steps: ['回退'] },
      monitoring: { healthChecks: ['/health'], alerts: ['错误率>1%'], dashboards: ['监控'] },
      risks: [{ description: '兼容性问题', severity: 'medium' as const, mitigation: '灰度发布' }],
      summary: '原始部署计划',
    };
    await artifactStore.save(project.projectId, 'acceptance', 'deployment-plan.json', originalPlan);

    const devOpsAgent = new DevOpsAgent(eventBus, taskService, artifactStore, llmService);
    devOpsAgent.start();

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Acceptance,
      title: '部署计划修订',
      description: '根据用户反馈修订部署计划:\n\n需要增加金丝雀发布策略',
      assignedTo: AgentRole.DevOps,
    });

    await new Promise((r) => setTimeout(r, 100));

    const reworked = (await artifactStore.load(project.projectId, 'acceptance', 'deployment-plan.json')) as any;
    expect(reworked).toBeTruthy();
    // Original structure preserved
    expect(reworked.environment).toBe('production');
    expect(reworked.strategy).toBe('blue-green');
    expect(reworked.steps).toHaveLength(2);
    expect(reworked.rollbackPlan.trigger).toBe('健康检查失败');
    // Summary contains revision note
    expect(reworked.summary).toContain('需要增加金丝雀发布策略');

    devOpsAgent.stop();
  });
});
