import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../src/core/event-bus/index.js';
import {
  FileStore,
  EventStore,
  ProjectStore,
  PhaseStore,
  TaskStore,
  ArtifactStore,
} from '../../src/core/persistence/index.js';
import { ProjectService } from '../../src/services/project-service.js';
import { TaskService } from '../../src/services/task-service.js';
import { PMAgent } from '../../src/agents/pm/index.js';
import { ProductDesignerAgent } from '../../src/agents/product-designer/index.js';
import { DeveloperAgent } from '../../src/agents/developer/index.js';
import { LLMService, PromptLoader } from '../../src/core/llm/index.js';
import { LLMError } from '../../src/core/llm/index.js';
import type { LLMProvider, LLMResponse, LLMConfig } from '../../src/core/llm/index.js';
import { OpenAICompatibleProvider } from '../../src/core/llm/index.js';
import {
  EventType,
  EventSource,
  PhaseName,
  TaskStatus,
} from '../../src/core/models/index.js';
import type { Event } from '../../src/core/models/index.js';

// --- Helpers ---

function makeResponse(content: string, overrides?: Partial<LLMResponse>): LLMResponse {
  return {
    content,
    usage: { promptTokens: 50, completionTokens: 120, totalTokens: 170 },
    model: 'mock-model-v1',
    latencyMs: 350,
    finishReason: 'stop',
    ...overrides,
  };
}

function createMockProvider(
  responseOrFn: LLMResponse | ((req: any) => LLMResponse | Promise<LLMResponse>),
): LLMProvider {
  return {
    name: 'mock',
    async chatCompletion(request) {
      if (typeof responseOrFn === 'function') {
        return responseOrFn(request);
      }
      return responseOrFn;
    },
  };
}

function createFailingProvider(error: Error): LLMProvider {
  return {
    name: 'mock-failing',
    async chatCompletion() {
      throw error;
    },
  };
}

function createMockPromptLoader(templates: Record<string, string>): PromptLoader {
  const loader = new PromptLoader('/nonexistent');
  const map = (loader as any).templates as Map<string, string>;
  for (const [key, value] of Object.entries(templates)) {
    map.set(key, value);
  }
  return loader;
}

const enabledConfig: LLMConfig = {
  provider: 'mock',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'mock-model-v1',
  temperature: 0.7,
  maxTokens: 4096,
  timeoutMs: 10000,
  maxRetries: 1,
};

const disabledConfig: LLMConfig = {
  provider: 'openai-compatible',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.7,
  maxTokens: 4096,
  timeoutMs: 60000,
  maxRetries: 3,
};

const VALID_PRD_JSON = JSON.stringify({
  title: 'Todo App PRD',
  version: '1.0',
  overview: '一个功能完善的待办事项管理应用，帮助用户管理日常任务。',
  features: [
    {
      id: 'F001',
      name: '任务管理',
      description: '用户可以创建、编辑、删除和标记完成待办事项',
      priority: 'high',
      userStories: ['作为用户，我希望创建新的待办事项以便追踪任务。'],
      acceptanceCriteria: ['用户可以输入标题和描述创建新任务', '任务可以被标记为已完成'],
    },
  ],
  nonFunctionalRequirements: ['响应时间 < 500ms'],
  assumptions: ['用户拥有现代浏览器'],
  modules: [
    {
      name: '任务模块',
      description: '负责所有任务的 CRUD 操作',
      relatedFeatures: ['F001'],
    },
  ],
});

const VALID_DESIGN_JSON = JSON.stringify({
  projectName: 'Todo App',
  version: '1.0',
  techStack: {
    frontend: [{ name: 'React', reason: '组件化开发，生态丰富' }],
    backend: [{ name: 'Node.js + Express', reason: '全栈 JS，开发效率高' }],
    database: [{ name: 'PostgreSQL', reason: '关系型数据支持事务' }],
    infrastructure: [],
  },
  architecture: {
    pattern: '分层架构',
    description: 'Todo App 采用经典三层架构：API 层、业务逻辑层、数据访问层。',
    components: [
      {
        name: '任务服务',
        responsibility: '处理任务的 CRUD 操作和状态管理',
        interfaces: ['REST API'],
      },
    ],
    dataModels: [
      {
        name: 'Task',
        fields: [
          { name: 'id', type: 'string', description: '任务唯一标识' },
          { name: 'title', type: 'string', description: '任务标题' },
          { name: 'completed', type: 'boolean', description: '是否已完成' },
        ],
        relationships: [],
      },
    ],
  },
  apiSpec: {
    baseUrl: '/api',
    endpoints: [
      { method: 'GET', path: '/tasks', summary: '获取任务列表' },
      { method: 'POST', path: '/tasks', summary: '创建新任务' },
      { method: 'PUT', path: '/tasks/:id', summary: '更新任务' },
      { method: 'DELETE', path: '/tasks/:id', summary: '删除任务' },
    ],
  },
});

// --- Test scaffold ---

let tempDir: string;
let eventBus: EventBus;
let projectService: ProjectService;
let taskService: TaskService;
let artifactStore: ArtifactStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'llm-flow-'));
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
});

afterEach(async () => {
  eventBus.clear();
  await rm(tempDir, { recursive: true, force: true });
});

// --- Tests ---

describe('LLM integration flow', () => {
  it('should generate PRD via LLM when enabled and provider succeeds', async () => {
    // Setup: LLM enabled with mock provider returning valid PRD JSON
    const mockProvider = createMockProvider(makeResponse(VALID_PRD_JSON));
    const promptLoader = createMockPromptLoader({
      'product-designer/system': 'You are a product designer. Output JSON.',
      'product-designer/generate-prd': 'Analyze: {{title}} - {{description}}',
    });
    const llmService = new LLMService(mockProvider, promptLoader, enabledConfig);
    expect(llmService.isEnabled).toBe(true);

    const agent = new ProductDesignerAgent(eventBus, taskService, artifactStore, llmService);
    agent.start();

    // Create project and task
    const project = await projectService.createProject('Todo App', '待办事项管理');
    await projectService.activateProject(project.projectId);

    const events: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => events.push(e));

    const task = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Analysis,
      title: '需求分析',
      description: '分析待办事项管理需求',
      assignedTo: 'product_designer',
    });

    await new Promise((r) => setTimeout(r, 100));

    // Verify artifact.produced was emitted
    expect(events).toHaveLength(1);
    const artifactEvent = events[0];

    // Verify LLM metadata is attached
    expect(artifactEvent.metadata).toBeDefined();
    const llmMeta = (artifactEvent.metadata as any).llm;
    expect(llmMeta.source).toBe('llm');
    expect(llmMeta.model).toBe('mock-model-v1');
    expect(llmMeta.totalTokens).toBe(170);
    expect(typeof llmMeta.latencyMs).toBe('number');

    // Verify PRD was saved with LLM-generated content
    const prd = await artifactStore.load(project.projectId, 'analysis', 'prd.json') as any;
    expect(prd).toBeTruthy();
    expect(prd.title).toBe('Todo App PRD');
    expect(prd.features).toHaveLength(1);
    expect(prd.features[0].id).toBe('F001');
    expect(prd.modules).toHaveLength(1);

    // Verify task went to in_review
    const updatedTask = await taskService.getTask(project.projectId, task.taskId);
    expect(updatedTask!.status).toBe(TaskStatus.InReview);

    agent.stop();
  });

  it('should fallback to template PRD when LLM is disabled', async () => {
    // Setup: LLM disabled (empty config)
    const promptLoader = new PromptLoader('/nonexistent');
    const provider = new OpenAICompatibleProvider(disabledConfig);
    const llmService = new LLMService(provider, promptLoader, disabledConfig);
    expect(llmService.isEnabled).toBe(false);

    const agent = new ProductDesignerAgent(eventBus, taskService, artifactStore, llmService);
    agent.start();

    // Create project and task
    const project = await projectService.createProject('Chat App', '聊天应用');
    await projectService.activateProject(project.projectId);

    const events: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => events.push(e));

    const task = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Analysis,
      title: '聊天功能分析',
      description: '分析聊天应用需求',
      assignedTo: 'product_designer',
    });

    await new Promise((r) => setTimeout(r, 100));

    // Verify artifact was produced
    expect(events).toHaveLength(1);
    const artifactEvent = events[0];

    // Verify fallback metadata
    const llmMeta = (artifactEvent.metadata as any).llm;
    expect(llmMeta.source).toBe('fallback');

    // Verify template PRD content
    const prd = await artifactStore.load(project.projectId, 'analysis', 'prd.json') as any;
    expect(prd).toBeTruthy();
    expect(prd.title).toBe('聊天功能分析');
    expect(prd.assumptions).toContain(
      'PRD为模板生成（LLM未配置），建议配置LLM以获得更精准的需求分析',
    );

    // Verify task status
    const updatedTask = await taskService.getTask(project.projectId, task.taskId);
    expect(updatedTask!.status).toBe(TaskStatus.InReview);

    agent.stop();
  });

  it('should fallback to template PRD when LLM call fails', async () => {
    // Setup: LLM enabled but provider always throws
    const failingProvider = createFailingProvider(
      new LLMError('Service unavailable', false, 503),
    );
    const promptLoader = createMockPromptLoader({
      'product-designer/system': 'System prompt',
      'product-designer/generate-prd': 'Analyze: {{title}} - {{description}}',
    });
    const llmService = new LLMService(failingProvider, promptLoader, enabledConfig);

    const agent = new ProductDesignerAgent(eventBus, taskService, artifactStore, llmService);
    agent.start();

    // Create project and task
    const project = await projectService.createProject('Fail Test', '失败测试');
    await projectService.activateProject(project.projectId);

    const events: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => events.push(e));

    const task = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Analysis,
      title: '测试任务',
      description: '用于测试LLM失败场景',
      assignedTo: 'product_designer',
    });

    await new Promise((r) => setTimeout(r, 100));

    // Even though LLM failed, artifact should still be produced via fallback
    expect(events).toHaveLength(1);
    const artifactEvent = events[0];

    // Should indicate fallback source since LLM failed
    const llmMeta = (artifactEvent.metadata as any).llm;
    expect(llmMeta.source).toBe('fallback');

    // Template PRD content
    const prd = await artifactStore.load(project.projectId, 'analysis', 'prd.json') as any;
    expect(prd).toBeTruthy();
    expect(prd.title).toBe('测试任务');

    // Task should still reach in_review
    const updatedTask = await taskService.getTask(project.projectId, task.taskId);
    expect(updatedTask!.status).toBe(TaskStatus.InReview);

    agent.stop();
  });

  it('should complete full flow with LLM: requirement → PRD → confirm → advance phase', async () => {
    // Setup full flow with LLM
    const mockProvider = createMockProvider(makeResponse(VALID_PRD_JSON));
    const promptLoader = createMockPromptLoader({
      'product-designer/system': 'You are a product designer.',
      'product-designer/generate-prd': 'Analyze: {{title}} - {{description}}',
    });
    const llmService = new LLMService(mockProvider, promptLoader, enabledConfig);

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    const pdAgent = new ProductDesignerAgent(eventBus, taskService, artifactStore, llmService);

    pmAgent.start();
    pdAgent.start();

    const confirmations: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => confirmations.push(e));

    // Step 1: User submits requirement
    await eventBus.emit(
      EventType.UserRequirementSubmitted,
      'temp_proj',
      EventSource.User,
      { requirement: '我需要一个待办事项管理应用', projectName: 'Todo App' },
    );

    await new Promise((r) => setTimeout(r, 150));

    // Verify project created and PRD produced via LLM
    const projects = await projectService.listProjects();
    expect(projects).toHaveLength(1);
    const project = projects[0];

    const prd = await artifactStore.load(project.projectId, 'analysis', 'prd.json') as any;
    expect(prd).toBeTruthy();
    expect(prd.title).toBe('Todo App PRD'); // LLM-generated title, not task title

    // Step 2: User confirms PRD
    expect(confirmations.length).toBeGreaterThanOrEqual(1);
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

    await new Promise((r) => setTimeout(r, 100));

    // Verify phase advanced to design
    const updatedProject = await projectService.getProject(project.projectId);
    expect(updatedProject!.currentPhase).toBe(PhaseName.Design);

    pmAgent.stop();
    pdAgent.stop();
  });

  it('should validate LLM response against schema and fallback on invalid response', async () => {
    // LLM returns JSON that does NOT match PRD schema (missing required fields)
    const invalidPRD = JSON.stringify({
      title: 'Incomplete PRD',
      // Missing: overview, features
    });
    const mockProvider = createMockProvider(makeResponse(invalidPRD));
    const promptLoader = createMockPromptLoader({
      'product-designer/system': 'System',
      'product-designer/generate-prd': '{{title}} - {{description}}',
    });
    const llmService = new LLMService(mockProvider, promptLoader, enabledConfig);

    const agent = new ProductDesignerAgent(eventBus, taskService, artifactStore, llmService);
    agent.start();

    const project = await projectService.createProject('Schema Test', '验证Schema');
    await projectService.activateProject(project.projectId);

    const events: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => events.push(e));

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Analysis,
      title: 'Schema验证',
      description: '测试LLM返回无效Schema时的降级行为',
      assignedTo: 'product_designer',
    });

    await new Promise((r) => setTimeout(r, 100));

    // Should still produce artifact via fallback
    expect(events).toHaveLength(1);
    const llmMeta = (events[0].metadata as any).llm;
    expect(llmMeta.source).toBe('fallback');

    // Fallback PRD
    const prd = await artifactStore.load(project.projectId, 'analysis', 'prd.json') as any;
    expect(prd.title).toBe('Schema验证');

    agent.stop();
  });
});

describe('Developer Agent LLM integration', () => {
  it('should generate design via LLM when enabled', async () => {
    const mockProvider = createMockProvider(makeResponse(VALID_DESIGN_JSON));
    const promptLoader = createMockPromptLoader({
      'developer/system': 'You are a software architect. Output JSON.',
      'developer/generate-design': 'Design based on PRD: {{prd}}',
    });
    const llmService = new LLMService(mockProvider, promptLoader, enabledConfig);

    const agent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
    agent.start();

    // Create project, activate, save PRD
    const project = await projectService.createProject('Todo App', '待办事项');
    await projectService.activateProject(project.projectId);
    await artifactStore.save(project.projectId, 'analysis', 'prd.json', JSON.parse(VALID_PRD_JSON));

    const events: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => events.push(e));

    // Enter design phase and create task
    await projectService.enterPhase(project.projectId, PhaseName.Design);
    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Design,
      title: '系统架构设计',
      description: '技术选型和架构设计',
      assignedTo: 'developer',
    });

    await new Promise((r) => setTimeout(r, 100));

    // Verify artifact produced with LLM metadata
    expect(events).toHaveLength(1);
    const llmMeta = (events[0].metadata as any).llm;
    expect(llmMeta.source).toBe('llm');
    expect(llmMeta.model).toBe('mock-model-v1');
    expect(llmMeta.totalTokens).toBe(170);

    // Verify design content
    const design = await artifactStore.load(project.projectId, 'design', 'design.json') as any;
    expect(design).toBeTruthy();
    expect(design.projectName).toBe('Todo App');
    expect(design.techStack.backend).toHaveLength(1);
    expect(design.architecture.components).toHaveLength(1);
    expect(design.apiSpec.endpoints).toHaveLength(4);

    agent.stop();
  });

  it('should fallback to template design when LLM fails', async () => {
    const failingProvider = createFailingProvider(
      new LLMError('Rate limited', true, 429),
    );
    const promptLoader = createMockPromptLoader({
      'developer/system': 'System',
      'developer/generate-design': '{{prd}}',
    });
    const llmService = new LLMService(failingProvider, promptLoader, enabledConfig);

    const agent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
    agent.start();

    const project = await projectService.createProject('Fallback Test', '降级测试');
    await projectService.activateProject(project.projectId);
    await artifactStore.save(project.projectId, 'analysis', 'prd.json', JSON.parse(VALID_PRD_JSON));

    const events: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => events.push(e));

    await projectService.enterPhase(project.projectId, PhaseName.Design);
    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Design,
      title: '架构设计',
      description: '测试降级',
      assignedTo: 'developer',
    });

    await new Promise((r) => setTimeout(r, 3000));

    expect(events).toHaveLength(1);
    const llmMeta = (events[0].metadata as any).llm;
    expect(llmMeta.source).toBe('fallback');

    // Template design should still have proper structure
    const design = await artifactStore.load(project.projectId, 'design', 'design.json') as any;
    expect(design).toBeTruthy();
    expect(design.projectName).toBe('Todo App PRD');
    expect(design.techStack.backend).toHaveLength(1);
    expect(design.architecture.pattern).toBe('分层架构');

    agent.stop();
  });

  it('should complete full analysis→design flow with LLM', async () => {
    // Mock provider returns different content based on prompt
    let callCount = 0;
    const mockProvider = createMockProvider(() => {
      callCount++;
      if (callCount === 1) {
        return makeResponse(VALID_PRD_JSON);
      }
      return makeResponse(VALID_DESIGN_JSON);
    });
    const promptLoader = createMockPromptLoader({
      'product-designer/system': 'Product designer',
      'product-designer/generate-prd': '{{title}} - {{description}}',
      'developer/system': 'Software architect',
      'developer/generate-design': '{{prd}}',
    });
    const llmService = new LLMService(mockProvider, promptLoader, enabledConfig);

    const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
    const pdAgent = new ProductDesignerAgent(eventBus, taskService, artifactStore, llmService);
    const devAgent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);

    pmAgent.start();
    pdAgent.start();
    devAgent.start();

    const confirmations: Event[] = [];
    eventBus.subscribe(EventType.UserConfirmationNeeded, (e) => confirmations.push(e));

    // Step 1: Submit requirement
    await eventBus.emit(
      EventType.UserRequirementSubmitted,
      'temp_proj',
      EventSource.User,
      { requirement: '待办事项管理应用', projectName: 'Todo App' },
    );

    await new Promise((r) => setTimeout(r, 150));

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

    // Wait for: analysis complete → PM enters design → creates task → Developer generates design
    await new Promise((r) => setTimeout(r, 200));

    // Verify design produced
    const design = await artifactStore.load(project.projectId, 'design', 'design.json') as any;
    expect(design).toBeTruthy();
    expect(design.projectName).toBe('Todo App');

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

    await new Promise((r) => setTimeout(r, 100));

    // Verify project advanced to implementation
    const updatedProject = await projectService.getProject(project.projectId);
    expect(updatedProject!.currentPhase).toBe(PhaseName.Implementation);

    pmAgent.stop();
    pdAgent.stop();
    devAgent.stop();
  });
});
