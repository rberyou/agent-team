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
import { LLMService, PromptLoader, OpenAICompatibleProvider } from '../../../src/core/llm/index.js';
import type { LLMConfig } from '../../../src/core/llm/index.js';
import {
  EventType,
  EventSource,
  PhaseName,
  PhaseStatus,
  ProjectStatus,
  TaskStatus,
} from '../../../src/core/models/index.js';
import type { Event } from '../../../src/core/models/index.js';

// Create a disabled LLMService (no baseUrl/apiKey → fallback mode)
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

let tempDir: string;
let eventBus: EventBus;
let projectService: ProjectService;
let taskService: TaskService;
let artifactStore: ArtifactStore;
let pmAgent: PMAgent;
let productDesignerAgent: ProductDesignerAgent;
let developerAgent: DeveloperAgent;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'agent-team-e2e-'));
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

  pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
  const llmService = createDisabledLLMService();
  productDesignerAgent = new ProductDesignerAgent(eventBus, taskService, artifactStore, llmService);
  developerAgent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
});

afterEach(async () => {
  pmAgent.stop();
  productDesignerAgent.stop();
  developerAgent.stop();
  await rm(tempDir, { recursive: true, force: true });
});

describe('PM Agent', () => {
  it('should create project and task on requirement submitted', async () => {
    pmAgent.start();

    const confirmHandler = vi.fn();
    eventBus.subscribe(EventType.UserConfirmationNeeded, confirmHandler);

    // Simulate user submitting requirement
    await eventBus.emit(
      EventType.UserRequirementSubmitted,
      'temp_proj',
      EventSource.User,
      { requirement: '我需要一个用户登录系统', projectName: '登录系统' },
    );

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 50));

    // Verify project was created
    const projects = await projectService.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('登录系统');
    expect(projects[0].status).toBe(ProjectStatus.Active);
  });
});

describe('Product Designer Agent', () => {
  it('should produce PRD when task is created', async () => {
    productDesignerAgent.start();

    // Create project manually
    const project = await projectService.createProject('Test', '测试项目');
    await projectService.activateProject(project.projectId);

    const artifactHandler = vi.fn();
    eventBus.subscribe(EventType.ArtifactProduced, artifactHandler);

    // Create task for product designer
    const task = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Analysis,
      title: '需求分析',
      description: '分析用户登录需求',
      assignedTo: 'product_designer',
    });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 50));

    // Check artifact was produced
    expect(artifactHandler).toHaveBeenCalled();

    // Verify PRD file was saved
    const prd = await artifactStore.load(project.projectId, 'analysis', 'prd.json');
    expect(prd).toBeTruthy();

    // Check task is now in review
    const updatedTask = await taskService.getTask(project.projectId, task.taskId);
    expect(updatedTask!.status).toBe(TaskStatus.InReview);
  });
});

describe('Full MVP flow: PM + Product Designer', () => {
  it('should complete the analysis phase end-to-end', async () => {
    pmAgent.start();
    productDesignerAgent.start();

    // Collect user.confirmation_needed events
    const confirmations: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => {
      confirmations.push(e);
    });

    // Step 1: User submits requirement
    await eventBus.emit(
      EventType.UserRequirementSubmitted,
      'temp_proj',
      EventSource.User,
      { requirement: '我需要一个待办事项管理应用', projectName: 'Todo App' },
    );

    // Wait for chain: PM creates project → creates task → PD produces PRD → PM asks for confirmation
    await new Promise((r) => setTimeout(r, 100));

    // Verify project was created and is active
    const projects = await projectService.listProjects();
    expect(projects).toHaveLength(1);
    const project = projects[0];
    expect(project.status).toBe(ProjectStatus.Active);
    expect(project.currentPhase).toBe(PhaseName.Analysis);

    // Verify PRD was produced
    const prd = await artifactStore.load(project.projectId, 'analysis', 'prd.json');
    expect(prd).toBeTruthy();

    // Verify user confirmation was requested
    expect(confirmations.length).toBeGreaterThanOrEqual(1);
    const prdConfirm = confirmations.find(
      (c) => (c.payload as any).confirmationType === 'prd_review',
    );
    expect(prdConfirm).toBeTruthy();

    // Step 2: User confirms PRD
    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'prd_review',
        taskId: (prdConfirm!.payload as any).taskId,
      },
    );

    await new Promise((r) => setTimeout(r, 50));

    // Verify analysis phase is completed and project advanced
    const updatedProject = await projectService.getProject(project.projectId);
    expect(updatedProject!.currentPhase).toBe(PhaseName.Design);
  });

  it('should handle PRD rejection and rework', async () => {
    pmAgent.start();
    productDesignerAgent.start();

    const confirmations: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => {
      confirmations.push(e);
    });

    // Submit requirement
    await eventBus.emit(
      EventType.UserRequirementSubmitted,
      'temp_proj',
      EventSource.User,
      { requirement: '我需要一个聊天应用', projectName: 'Chat App' },
    );

    await new Promise((r) => setTimeout(r, 100));

    const projects = await projectService.listProjects();
    const project = projects[0];

    // User rejects the PRD
    const prdConfirm = confirmations.find(
      (c) => (c.payload as any).confirmationType === 'prd_review',
    );

    await eventBus.emit(
      EventType.UserRejected,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'prd_review',
        taskId: (prdConfirm!.payload as any).taskId,
        feedback: '需要增加群聊功能的描述',
      },
    );

    await new Promise((r) => setTimeout(r, 100));

    // Verify rework task was created and PD processed it
    const tasks = await taskService.listTasks(project.projectId);
    const reworkTasks = tasks.filter((t) => t.title === 'PRD修订');
    expect(reworkTasks).toHaveLength(1);

    // A new confirmation should have been requested for the rework
    const newConfirmations = confirmations.filter(
      (c) =>
        (c.payload as any).confirmationType === 'prd_review' &&
        c !== prdConfirm,
    );
    expect(newConfirmations.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Developer Agent', () => {
  it('should produce design document when task is created', async () => {
    developerAgent.start();

    // Create project and activate
    const project = await projectService.createProject('Test Design', '测试设计');
    await projectService.activateProject(project.projectId);

    // Pre-save a mock PRD (Developer reads this)
    await artifactStore.save(project.projectId, 'analysis', 'prd.json', {
      title: 'Test Design',
      overview: '测试设计项目',
      features: [
        {
          id: 'F001',
          name: '用户管理',
          description: '用户注册和登录',
          priority: 'high',
          userStories: ['作为用户，我希望注册账号'],
          acceptanceCriteria: ['可以注册'],
        },
      ],
      modules: [
        { name: '用户模块', description: '处理用户相关功能', relatedFeatures: ['F001'] },
      ],
    });

    const artifactHandler = vi.fn();
    eventBus.subscribe(EventType.ArtifactProduced, artifactHandler);

    // Enter design phase and create task
    await projectService.enterPhase(project.projectId, PhaseName.Design);
    const task = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Design,
      title: '系统架构设计',
      description: '进行技术选型和架构设计',
      assignedTo: 'developer',
    });

    await new Promise((r) => setTimeout(r, 50));

    // Verify artifact was produced
    expect(artifactHandler).toHaveBeenCalled();

    // Verify design document was saved
    const design = await artifactStore.load(project.projectId, 'design', 'design.json');
    expect(design).toBeTruthy();

    // Check task is now in review
    const updatedTask = await taskService.getTask(project.projectId, task.taskId);
    expect(updatedTask!.status).toBe(TaskStatus.InReview);
  });
});

describe('Full Design Phase flow: PM + ProductDesigner + Developer', () => {
  it('should complete analysis → design phase end-to-end', async () => {
    pmAgent.start();
    productDesignerAgent.start();
    developerAgent.start();

    const confirmations: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => {
      confirmations.push(e);
    });

    // Step 1: User submits requirement
    await eventBus.emit(
      EventType.UserRequirementSubmitted,
      'temp_proj',
      EventSource.User,
      { requirement: '我需要一个待办事项管理应用', projectName: 'Todo App' },
    );

    await new Promise((r) => setTimeout(r, 100));

    const projects = await projectService.listProjects();
    expect(projects).toHaveLength(1);
    const project = projects[0];

    // Step 2: User confirms PRD
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

    // Wait for: PM completes analysis → PM creates design task → Developer produces design
    await new Promise((r) => setTimeout(r, 200));

    // Verify design document was produced
    const design = await artifactStore.load(project.projectId, 'design', 'design.json');
    expect(design).toBeTruthy();

    // Verify design_review confirmation was requested
    const designConfirm = confirmations.find(
      (c) => (c.payload as any).confirmationType === 'design_review',
    );
    expect(designConfirm).toBeTruthy();

    // Step 3: User confirms design
    await eventBus.emit(
      EventType.UserConfirmed,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'design_review',
        taskId: (designConfirm!.payload as any).taskId,
      },
    );

    await new Promise((r) => setTimeout(r, 100));

    // Verify project advanced to implementation
    const updatedProject = await projectService.getProject(project.projectId);
    expect(updatedProject!.currentPhase).toBe(PhaseName.Implementation);
  });

  it('should handle design rejection and rework', async () => {
    pmAgent.start();
    productDesignerAgent.start();
    developerAgent.start();

    const confirmations: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => {
      confirmations.push(e);
    });

    // Submit requirement and confirm PRD
    await eventBus.emit(
      EventType.UserRequirementSubmitted,
      'temp_proj',
      EventSource.User,
      { requirement: '我需要一个电商平台', projectName: 'E-Shop' },
    );

    await new Promise((r) => setTimeout(r, 100));

    const projects = await projectService.listProjects();
    const project = projects[0];

    // Confirm PRD to enter design phase
    const prdConfirm = confirmations.find(
      (c) => (c.payload as any).confirmationType === 'prd_review',
    );

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

    // Now reject the design
    const designConfirm = confirmations.find(
      (c) => (c.payload as any).confirmationType === 'design_review',
    );
    expect(designConfirm).toBeTruthy();

    await eventBus.emit(
      EventType.UserRejected,
      project.projectId,
      EventSource.User,
      {
        confirmationType: 'design_review',
        taskId: (designConfirm!.payload as any).taskId,
        feedback: '需要使用微服务架构',
      },
    );

    await new Promise((r) => setTimeout(r, 200));

    // Verify rework task was created
    const tasks = await taskService.listTasks(project.projectId);
    const reworkTasks = tasks.filter((t) => t.title === '架构设计修订');
    expect(reworkTasks).toHaveLength(1);

    // A new design_review confirmation should have been requested
    const newDesignConfirms = confirmations.filter(
      (c) =>
        (c.payload as any).confirmationType === 'design_review' &&
        c !== designConfirm,
    );
    expect(newDesignConfirms.length).toBeGreaterThanOrEqual(1);
  });

  it('should preserve previous PRD content during rework', async () => {
    productDesignerAgent.start();

    const project = await projectService.createProject('Rework Test', '测试修订');
    await projectService.activateProject(project.projectId);

    // Save an initial PRD (simulates first generation)
    const originalPrd = {
      title: 'Rework Test',
      version: '1.0',
      overview: '原始需求描述',
      features: [
        { id: 'F001', name: '用户管理', description: '用户注册登录', priority: 'high', userStories: ['注册'], acceptanceCriteria: ['可注册'] },
      ],
      nonFunctionalRequirements: ['响应时间<2秒'],
      assumptions: ['初始假设'],
    };
    await artifactStore.save(project.projectId, 'analysis', 'prd.json', originalPrd);

    // Create rework task (same as PM creates on rejection)
    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Analysis,
      title: 'PRD修订',
      description: '根据用户反馈修订PRD文档:\n\n需要新增支付功能',
      assignedTo: 'product_designer',
    });

    await new Promise((r) => setTimeout(r, 100));

    // Verify reworked PRD preserves original content
    const reworkedPrd = await artifactStore.load(project.projectId, 'analysis', 'prd.json') as any;
    expect(reworkedPrd).toBeTruthy();
    // Original title should be preserved
    expect(reworkedPrd.title).toBe('Rework Test');
    // Original features should be preserved
    expect(reworkedPrd.features).toHaveLength(1);
    expect(reworkedPrd.features[0].id).toBe('F001');
    // Should contain revision note in assumptions
    expect(reworkedPrd.assumptions.some((a: string) => a.includes('需要新增支付功能'))).toBe(true);
  });

  it('should preserve previous design content during rework', async () => {
    developerAgent.start();

    const project = await projectService.createProject('Design Rework', '测试设计修订');
    await projectService.activateProject(project.projectId);
    await projectService.completePhase(project.projectId, PhaseName.Analysis);
    await projectService.enterPhase(project.projectId, PhaseName.Design);

    // Save PRD + initial design
    await artifactStore.save(project.projectId, 'analysis', 'prd.json', {
      title: 'Design Rework', overview: '测试', features: [], modules: [],
    });
    const originalDesign = {
      projectName: 'Design Rework',
      version: '1.0',
      techStack: { backend: [{ name: 'Node.js', reason: '类型安全' }], database: [{ name: 'PostgreSQL', reason: '关系型' }], infrastructure: [] },
      architecture: { pattern: '分层架构', description: '分层', components: [{ name: 'API', responsibility: 'REST', interfaces: [] }], dataModels: [] },
      apiSpec: { baseUrl: '/api', endpoints: [{ method: 'GET', path: '/health', summary: '健康检查' }] },
      assumptions: ['初始假设'],
    };
    await artifactStore.save(project.projectId, 'design', 'design.json', originalDesign);

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Design,
      title: '架构设计修订',
      description: '根据用户反馈修订架构设计:\n\n需要使用微服务架构',
      assignedTo: 'developer',
    });

    await new Promise((r) => setTimeout(r, 100));

    const reworkedDesign = await artifactStore.load(project.projectId, 'design', 'design.json') as any;
    expect(reworkedDesign).toBeTruthy();
    expect(reworkedDesign.projectName).toBe('Design Rework');
    expect(reworkedDesign.architecture.pattern).toBe('分层架构');
    expect(reworkedDesign.assumptions.some((a: string) => a.includes('需要使用微服务架构'))).toBe(true);
  });
});
