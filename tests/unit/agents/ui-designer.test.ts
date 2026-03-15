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
import { UIDesignerAgent } from '../../../src/agents/ui-designer/index.js';
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

const SAMPLE_PRD = {
  title: 'UI App',
  overview: 'A test application',
  features: [
    {
      id: 'F001',
      name: 'Dashboard',
      description: 'Main dashboard view',
      priority: 'high',
      userStories: ['As a user, I want a dashboard'],
      acceptanceCriteria: ['Dashboard shows metrics'],
    },
    {
      id: 'F002',
      name: 'Settings',
      description: 'User settings page',
      priority: 'medium',
      userStories: ['As a user, I want to configure settings'],
      acceptanceCriteria: ['Settings can be saved'],
    },
  ],
  modules: [
    { name: 'UI', description: 'Frontend UI', relatedFeatures: ['F001', 'F002'] },
  ],
};

let tempDir: string;
let eventBus: EventBus;
let projectService: ProjectService;
let taskService: TaskService;
let artifactStore: ArtifactStore;
let llmService: LLMService;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ui-designer-test-'));
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

describe('UIDesignerAgent', () => {
  it('should generate UI design when task is created', async () => {
    const project = await projectService.createProject('UI Test', 'test', true);
    await projectService.activateProject(project.projectId);
    await projectService.completePhase(project.projectId, PhaseName.Analysis);
    await projectService.enterPhase(project.projectId, PhaseName.Design);

    // Save PRD
    await artifactStore.save(project.projectId, 'analysis', 'prd.json', SAMPLE_PRD);

    const uiAgent = new UIDesignerAgent(eventBus, taskService, artifactStore, llmService);
    uiAgent.start();

    const artifactEvents: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => artifactEvents.push(e));

    // Create UI design task
    const task = await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Design,
      title: 'UI界面设计',
      description: '设计UI布局和组件',
      assignedTo: AgentRole.UIDesigner,
    });

    await new Promise((r) => setTimeout(r, 100));

    // Verify artifact was produced with correct type
    const uiDesignEvent = artifactEvents.find(
      (e) => (e.payload as any).artifactType === 'ui_design',
    );
    expect(uiDesignEvent).toBeTruthy();
    expect((uiDesignEvent!.payload as any).taskId).toBe(task.taskId);

    // Verify UI design file was saved
    const uiDesign = (await artifactStore.load(project.projectId, 'design', 'ui-design.json')) as any;
    expect(uiDesign).toBeTruthy();
    expect(uiDesign.projectName).toBe('UI App');
    expect(uiDesign.designSystem).toBeTruthy();
    expect(uiDesign.designSystem.colorScheme).toBeTruthy();
    expect(uiDesign.pages).toHaveLength(2); // 2 features → 2 pages
    expect(uiDesign.componentSpecs.length).toBeGreaterThan(0);
    expect(uiDesign.styleGuide).toBeTruthy();
    expect(uiDesign.summary).toContain('2');

    // Verify task is in review
    const updatedTask = await taskService.getTask(project.projectId, task.taskId);
    expect(updatedTask!.status).toBe(TaskStatus.InReview);

    uiAgent.stop();
  });

  it('should ignore tasks not assigned to ui_designer', async () => {
    const project = await projectService.createProject('UI Test', 'test', true);
    await projectService.activateProject(project.projectId);
    await projectService.completePhase(project.projectId, PhaseName.Analysis);
    await projectService.enterPhase(project.projectId, PhaseName.Design);

    const uiAgent = new UIDesignerAgent(eventBus, taskService, artifactStore, llmService);
    uiAgent.start();

    const artifactEvents: Event[] = [];
    eventBus.subscribe(EventType.ArtifactProduced, (e) => artifactEvents.push(e));

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Design,
      title: 'Architecture design',
      assignedTo: AgentRole.Developer,
    });

    await new Promise((r) => setTimeout(r, 50));

    const uiEvents = artifactEvents.filter(
      (e) => (e.payload as any).artifactType === 'ui_design',
    );
    expect(uiEvents).toHaveLength(0);

    uiAgent.stop();
  });

  it('should generate fallback with default page when PRD has no features', async () => {
    const project = await projectService.createProject('Empty PRD', 'test', true);
    await projectService.activateProject(project.projectId);
    await projectService.completePhase(project.projectId, PhaseName.Analysis);
    await projectService.enterPhase(project.projectId, PhaseName.Design);

    // Save PRD without features
    await artifactStore.save(project.projectId, 'analysis', 'prd.json', {
      title: 'Empty App',
      overview: 'No features yet',
      features: [],
    });

    const uiAgent = new UIDesignerAgent(eventBus, taskService, artifactStore, llmService);
    uiAgent.start();

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Design,
      title: 'UI界面设计',
      assignedTo: AgentRole.UIDesigner,
    });

    await new Promise((r) => setTimeout(r, 100));

    const uiDesign = (await artifactStore.load(project.projectId, 'design', 'ui-design.json')) as any;
    expect(uiDesign).toBeTruthy();
    // Fallback creates a default page when features array is empty
    expect(uiDesign.pages.length).toBeGreaterThanOrEqual(1);

    uiAgent.stop();
  });

  it('should preserve previous UI design during rework', async () => {
    const project = await projectService.createProject('UI Rework', 'test', true);
    await projectService.activateProject(project.projectId);
    await projectService.completePhase(project.projectId, PhaseName.Analysis);
    await projectService.enterPhase(project.projectId, PhaseName.Design);

    await artifactStore.save(project.projectId, 'analysis', 'prd.json', {
      title: 'UI Rework App', overview: 'test', features: [],
    });

    // Save initial UI design
    const originalDesign = {
      projectName: 'UI Rework App',
      version: '1.0',
      designSystem: {
        colorScheme: { primary: '#FF0000', secondary: '#00FF00', accent: '#0000FF', background: '#FFF', text: '#000' },
        typography: { headingFont: 'Arial', bodyFont: 'Arial', baseFontSize: '16px' },
        spacing: { unit: '8px', scale: ['4px', '8px'] },
      },
      pages: [{ id: 'P001', name: '首页', description: '主页面', wireframe: '布局', components: ['Header'] }],
      componentSpecs: [{ name: 'Header', purpose: '导航', props: [], styles: '固定顶部' }],
      styleGuide: { layout: 'Flex', responsive: '移动优先', accessibility: 'WCAG AA' },
      summary: '原始UI设计',
    };
    await artifactStore.save(project.projectId, 'design', 'ui-design.json', originalDesign);

    const uiAgent = new UIDesignerAgent(eventBus, taskService, artifactStore, llmService);
    uiAgent.start();

    await taskService.createTask({
      projectId: project.projectId,
      phase: PhaseName.Design,
      title: 'UI设计修订',
      description: '根据用户反馈修订UI设计:\n\n主色调改为蓝色',
      assignedTo: AgentRole.UIDesigner,
    });

    await new Promise((r) => setTimeout(r, 100));

    const reworked = (await artifactStore.load(project.projectId, 'design', 'ui-design.json')) as any;
    expect(reworked).toBeTruthy();
    // Original structure preserved
    expect(reworked.projectName).toBe('UI Rework App');
    expect(reworked.pages).toHaveLength(1);
    expect(reworked.pages[0].id).toBe('P001');
    expect(reworked.designSystem.colorScheme.primary).toBe('#FF0000');
    // Summary contains revision note
    expect(reworked.summary).toContain('主色调改为蓝色');

    uiAgent.stop();
  });
});
