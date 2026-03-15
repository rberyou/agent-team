import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../../src/core/event-bus/index.js';
import { FileStore, ProjectStore, PhaseStore, TaskStore } from '../../../src/core/persistence/index.js';
import { ProjectService } from '../../../src/services/project-service.js';
import { TaskService } from '../../../src/services/task-service.js';
import {
  PhaseName,
  PhaseStatus,
  ProjectStatus,
  TaskStatus,
  AgentRole,
} from '../../../src/core/models/index.js';

let tempDir: string;
let eventBus: EventBus;
let projectService: ProjectService;
let taskService: TaskService;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'agent-team-svc-'));
  const fileStore = new FileStore();
  const projectStore = new ProjectStore(fileStore, tempDir);
  const phaseStore = new PhaseStore(fileStore, tempDir);
  const taskStore = new TaskStore(fileStore, tempDir);
  eventBus = new EventBus();
  projectService = new ProjectService(eventBus, projectStore, phaseStore);
  taskService = new TaskService(eventBus, taskStore);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('ProjectService', () => {
  it('should create a project with all phases', async () => {
    const project = await projectService.createProject('Test', 'A test project');

    expect(project.projectId).toMatch(/^proj_/);
    expect(project.name).toBe('Test');
    expect(project.status).toBe(ProjectStatus.Created);
    expect(project.phases).toHaveLength(5);

    // Verify project was persisted
    const loaded = await projectService.getProject(project.projectId);
    expect(loaded).toBeTruthy();
    expect(loaded!.name).toBe('Test');
  });

  it('should activate a project and enter analysis phase', async () => {
    const project = await projectService.createProject('Test', 'desc');
    const activated = await projectService.activateProject(project.projectId);

    expect(activated.status).toBe(ProjectStatus.Active);
    expect(activated.currentPhase).toBe(PhaseName.Analysis);
  });

  it('should reject activating a non-created project', async () => {
    const project = await projectService.createProject('Test', 'desc');
    await projectService.activateProject(project.projectId);

    await expect(
      projectService.activateProject(project.projectId),
    ).rejects.toThrow(/cannot be activated/);
  });

  it('should complete a phase and advance currentPhase', async () => {
    const project = await projectService.createProject('Test', 'desc');
    await projectService.activateProject(project.projectId);

    const completedPhase = await projectService.completePhase(project.projectId, PhaseName.Analysis);
    expect(completedPhase.status).toBe(PhaseStatus.Completed);

    const updated = await projectService.getProject(project.projectId);
    expect(updated!.currentPhase).toBe(PhaseName.Design);
  });

  it('should list all projects', async () => {
    await projectService.createProject('A', 'first');
    await projectService.createProject('B', 'second');

    const all = await projectService.listProjects();
    expect(all).toHaveLength(2);
  });
});

describe('TaskService', () => {
  let projectId: string;

  beforeEach(async () => {
    const project = await projectService.createProject('Test', 'desc');
    await projectService.activateProject(project.projectId);
    projectId = project.projectId;
  });

  it('should create a task', async () => {
    const task = await taskService.createTask({
      projectId,
      phase: PhaseName.Analysis,
      title: '需求分析',
      assignedTo: AgentRole.ProductDesigner,
    });

    expect(task.taskId).toMatch(/^task_/);
    expect(task.status).toBe(TaskStatus.Pending);
    expect(task.assignedTo).toBe(AgentRole.ProductDesigner);
  });

  it('should transition task status', async () => {
    const task = await taskService.createTask({
      projectId,
      phase: PhaseName.Analysis,
      title: '需求分析',
      assignedTo: AgentRole.ProductDesigner,
    });

    // pending → in_progress
    const started = await taskService.transitionTask(projectId, task.taskId, TaskStatus.InProgress, 'Starting work');
    expect(started.status).toBe(TaskStatus.InProgress);
    expect(started.startedAt).toBeTruthy();
    expect(started.history).toHaveLength(1);

    // in_progress → done
    const done = await taskService.transitionTask(projectId, task.taskId, TaskStatus.Done, 'Work complete');
    expect(done.status).toBe(TaskStatus.Done);
    expect(done.completedAt).toBeTruthy();
    expect(done.history).toHaveLength(2);
  });

  it('should reject invalid transitions', async () => {
    const task = await taskService.createTask({
      projectId,
      phase: PhaseName.Analysis,
      title: 'Test',
      assignedTo: AgentRole.ProductDesigner,
    });

    // pending → done is invalid
    await expect(
      taskService.transitionTask(projectId, task.taskId, TaskStatus.Done),
    ).rejects.toThrow();
  });

  it('should list tasks by phase', async () => {
    await taskService.createTask({
      projectId,
      phase: PhaseName.Analysis,
      title: 'Task A',
      assignedTo: AgentRole.ProductDesigner,
    });
    await taskService.createTask({
      projectId,
      phase: PhaseName.Design,
      title: 'Task B',
      assignedTo: AgentRole.Developer,
    });

    const analysisTasks = await taskService.listTasksByPhase(projectId, PhaseName.Analysis);
    expect(analysisTasks).toHaveLength(1);
    expect(analysisTasks[0].title).toBe('Task A');
  });
});
