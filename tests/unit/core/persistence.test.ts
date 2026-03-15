import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FileStore,
  EventStore,
  ProjectStore,
  TaskStore,
  PhaseStore,
  ArtifactStore,
} from '../../../src/core/persistence/index.js';
import {
  EventType,
  EventSource,
  TaskStatus,
  PhaseName,
  PhaseStatus,
  ProjectStatus,
} from '../../../src/core/models/index.js';
import type { Event, Task, Phase, Project } from '../../../src/core/models/index.js';

let tempDir: string;
let fileStore: FileStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'agent-team-test-'));
  fileStore = new FileStore();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('FileStore', () => {
  it('readJSON returns null for missing file', async () => {
    const result = await fileStore.readJSON(join(tempDir, 'nope.json'));
    expect(result).toBeNull();
  });

  it('writeJSON + readJSON roundtrip', async () => {
    const data = { foo: 'bar', num: 42 };
    const path = join(tempDir, 'deep', 'nested', 'data.json');
    await fileStore.writeJSON(path, data);
    const result = await fileStore.readJSON(path);
    expect(result).toEqual(data);
  });

  it('appendLine + readJSONL roundtrip', async () => {
    const path = join(tempDir, 'log.jsonl');
    await fileStore.appendLine(path, JSON.stringify({ a: 1 }));
    await fileStore.appendLine(path, JSON.stringify({ a: 2 }));
    const lines = await fileStore.readJSONL(path);
    expect(lines).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('readJSONL returns empty for missing file', async () => {
    const result = await fileStore.readJSONL(join(tempDir, 'nope.jsonl'));
    expect(result).toEqual([]);
  });

  it('listFiles returns empty for missing dir', async () => {
    const result = await fileStore.listFiles(join(tempDir, 'nope'));
    expect(result).toEqual([]);
  });

  it('exists returns correct results', async () => {
    const path = join(tempDir, 'test.json');
    expect(await fileStore.exists(path)).toBe(false);
    await fileStore.writeJSON(path, {});
    expect(await fileStore.exists(path)).toBe(true);
  });
});

describe('EventStore', () => {
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = new EventStore(fileStore, tempDir);
  });

  const makeEvent = (type: string, timestamp: string): Event => ({
    id: `evt_${Date.now()}`,
    type: type as Event['type'],
    timestamp,
    source: EventSource.AgentPM,
    projectId: 'proj_001',
    version: 1,
    payload: {},
    metadata: {},
  });

  it('append and readAll', async () => {
    const e1 = makeEvent(EventType.ProjectCreated, '2026-03-12T10:00:00.000Z');
    const e2 = makeEvent(EventType.TaskCreated, '2026-03-12T11:00:00.000Z');

    await eventStore.append(e1);
    await eventStore.append(e2);

    const events = await eventStore.readAll('proj_001');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe(EventType.ProjectCreated);
    expect(events[1].type).toBe(EventType.TaskCreated);
  });

  it('events across multiple dates are ordered', async () => {
    const e1 = makeEvent(EventType.ProjectCreated, '2026-03-10T10:00:00.000Z');
    const e2 = makeEvent(EventType.TaskCreated, '2026-03-12T10:00:00.000Z');

    await eventStore.append(e1);
    await eventStore.append(e2);

    const events = await eventStore.readAll('proj_001');
    expect(events).toHaveLength(2);
    expect(events[0].timestamp).toBe('2026-03-10T10:00:00.000Z');
    expect(events[1].timestamp).toBe('2026-03-12T10:00:00.000Z');
  });

  it('readByDate filters correctly', async () => {
    const e1 = makeEvent(EventType.ProjectCreated, '2026-03-10T10:00:00.000Z');
    const e2 = makeEvent(EventType.TaskCreated, '2026-03-12T10:00:00.000Z');

    await eventStore.append(e1);
    await eventStore.append(e2);

    const day1 = await eventStore.readByDate('proj_001', '2026-03-10');
    expect(day1).toHaveLength(1);

    const day2 = await eventStore.readByDate('proj_001', '2026-03-11');
    expect(day2).toHaveLength(0);
  });

  it('readAll returns empty for nonexistent project', async () => {
    const events = await eventStore.readAll('nonexistent');
    expect(events).toEqual([]);
  });
});

describe('ProjectStore', () => {
  let projectStore: ProjectStore;

  beforeEach(() => {
    projectStore = new ProjectStore(fileStore, tempDir);
  });

  const makeProject = (id: string): Project => ({
    projectId: id,
    name: `Project ${id}`,
    description: '',
    status: ProjectStatus.Created,
    currentPhase: null,
    phases: [],
    config: { requiresUI: false, maxRetryOnFailure: 3 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pausedAt: null,
    completedAt: null,
  });

  it('save and load', async () => {
    const project = makeProject('proj_001');
    await projectStore.save(project);

    const loaded = await projectStore.load('proj_001');
    expect(loaded).toEqual(project);
  });

  it('load returns null for missing project', async () => {
    const loaded = await projectStore.load('nonexistent');
    expect(loaded).toBeNull();
  });

  it('listIds and listAll', async () => {
    await projectStore.save(makeProject('proj_a'));
    await projectStore.save(makeProject('proj_b'));

    const ids = await projectStore.listIds();
    expect(ids.sort()).toEqual(['proj_a', 'proj_b']);

    const all = await projectStore.listAll();
    expect(all).toHaveLength(2);
  });
});

describe('TaskStore', () => {
  let taskStore: TaskStore;

  beforeEach(() => {
    taskStore = new TaskStore(fileStore, tempDir);
  });

  const makeTask = (taskId: string): Task => ({
    taskId,
    projectId: 'proj_001',
    phase: PhaseName.Analysis,
    title: `Task ${taskId}`,
    description: '',
    assignedTo: 'product_designer',
    status: TaskStatus.Pending,
    priority: 'medium',
    dependencies: [],
    blockedBy: [],
    parentTask: null,
    subTasks: [],
    reviewStatus: 'none',
    reviewRounds: 0,
    testStatus: 'none',
    artifacts: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    updatedAt: new Date().toISOString(),
    history: [],
    changeRequestIds: [],
  });

  it('save and load', async () => {
    const task = makeTask('task_001');
    await taskStore.save(task);

    const loaded = await taskStore.load('proj_001', 'task_001');
    expect(loaded).toEqual(task);
  });

  it('listAll returns all tasks', async () => {
    await taskStore.save(makeTask('task_001'));
    await taskStore.save(makeTask('task_002'));

    const all = await taskStore.listAll('proj_001');
    expect(all).toHaveLength(2);
  });
});

describe('PhaseStore', () => {
  let phaseStore: PhaseStore;

  beforeEach(() => {
    phaseStore = new PhaseStore(fileStore, tempDir);
  });

  it('save and load', async () => {
    const phase: Phase = {
      phaseId: 'phase_analysis',
      projectId: 'proj_001',
      name: PhaseName.Analysis,
      status: PhaseStatus.Pending,
      startedAt: null,
      completedAt: null,
      tasks: [],
      entryCriteria: [],
      exitCriteria: [],
      artifacts: [],
    };

    await phaseStore.save(phase);
    const loaded = await phaseStore.load('proj_001', PhaseName.Analysis);
    expect(loaded).toEqual(phase);
  });
});

describe('ArtifactStore', () => {
  let artifactStore: ArtifactStore;

  beforeEach(() => {
    artifactStore = new ArtifactStore(fileStore, tempDir);
  });

  it('save and load artifact', async () => {
    const prd = { title: 'Test PRD', features: ['login', 'register'] };
    await artifactStore.save('proj_001', 'analysis', 'prd.json', prd);

    const loaded = await artifactStore.load('proj_001', 'analysis', 'prd.json');
    expect(loaded).toEqual(prd);
  });

  it('list artifacts', async () => {
    await artifactStore.save('proj_001', 'analysis', 'prd.json', {});
    await artifactStore.save('proj_001', 'analysis', 'requirements.json', {});

    const files = await artifactStore.list('proj_001', 'analysis');
    expect(files.sort()).toEqual(['prd.json', 'requirements.json']);
  });
});
