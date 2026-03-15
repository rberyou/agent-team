import { v4 as uuid } from 'uuid';
import { EventBus } from '../core/event-bus/index.js';
import { TaskStore } from '../core/persistence/index.js';
import { canTaskTransition } from '../core/state-machine/index.js';
import { EventType, EventSource, TaskStatus, taskSchema } from '../core/models/index.js';
import type { Task, TaskHistoryEntry } from '../core/models/index.js';
import { createChildLogger } from '../logger.js';

const logger = createChildLogger('task-service');

export class TaskService {
  constructor(
    private readonly eventBus: EventBus,
    private readonly taskStore: TaskStore,
  ) {}

  /**
   * Create a new task.
   */
  async createTask(params: {
    projectId: string;
    phase: string;
    title: string;
    description?: string;
    assignedTo: string;
    priority?: string;
    dependencies?: string[];
  }): Promise<Task> {
    const now = new Date().toISOString();
    const taskId = `task_${uuid()}`;

    const task = taskSchema.parse({
      taskId,
      projectId: params.projectId,
      phase: params.phase,
      title: params.title,
      description: params.description ?? '',
      assignedTo: params.assignedTo,
      status: TaskStatus.Pending,
      priority: params.priority ?? 'medium',
      dependencies: params.dependencies ?? [],
      createdAt: now,
      updatedAt: now,
    });

    await this.taskStore.save(task);

    await this.eventBus.emit(EventType.TaskCreated, params.projectId, EventSource.AgentPM, {
      taskId,
      title: params.title,
      assignedTo: params.assignedTo,
      phase: params.phase,
      priority: params.priority ?? 'medium',
    }, { phase: params.phase });

    logger.info({ taskId, title: params.title, assignedTo: params.assignedTo }, 'Task created');
    return task;
  }

  /**
   * Transition a task to a new status with validation.
   */
  async transitionTask(
    projectId: string,
    taskId: string,
    newStatus: string,
    reason?: string,
    triggerEventId?: string,
  ): Promise<Task> {
    const task = await this.taskStore.load(projectId, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const transition = canTaskTransition(task.status, newStatus);
    if (!transition.valid) throw new Error(transition.reason);

    const now = new Date().toISOString();
    const historyEntry: TaskHistoryEntry = {
      from: task.status,
      to: newStatus,
      timestamp: now,
      triggerEvent: triggerEventId,
      reason,
    };

    task.status = newStatus as Task['status'];
    task.updatedAt = now;
    task.history.push(historyEntry);

    if (newStatus === TaskStatus.InProgress && !task.startedAt) {
      task.startedAt = now;
    }
    if (newStatus === TaskStatus.Done) {
      task.completedAt = now;
    }

    await this.taskStore.save(task);

    // Emit appropriate event
    const eventTypeMap: Record<string, string> = {
      [TaskStatus.InProgress]: EventType.TaskStarted,
      [TaskStatus.Done]: EventType.TaskCompleted,
      [TaskStatus.Blocked]: EventType.TaskBlocked,
      [TaskStatus.Cancelled]: EventType.TaskCancelled,
    };

    const eventType = eventTypeMap[newStatus];
    if (eventType) {
      await this.eventBus.emit(
        eventType as any,
        projectId,
        EventSource.System,
        { taskId, status: newStatus, reason },
        { phase: task.phase },
      );
    }

    logger.info({ taskId, from: transition.from, to: transition.to }, 'Task transitioned');
    return task;
  }

  /**
   * Update specific fields on a task (without status transition).
   */
  async updateTask(
    projectId: string,
    taskId: string,
    updates: Partial<Pick<Task, 'reviewStatus' | 'reviewRounds' | 'subTasks' | 'blockedBy' | 'artifacts' | 'description' | 'parentTask'>>,
  ): Promise<Task> {
    const task = await this.taskStore.load(projectId, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    await this.taskStore.save(task);
    logger.info({ taskId, updates: Object.keys(updates) }, 'Task updated');
    return task;
  }

  async getTask(projectId: string, taskId: string): Promise<Task | null> {
    return this.taskStore.load(projectId, taskId);
  }

  async listTasks(projectId: string): Promise<Task[]> {
    return this.taskStore.listAll(projectId);
  }

  async listTasksByPhase(projectId: string, phase: string): Promise<Task[]> {
    const all = await this.taskStore.listAll(projectId);
    return all.filter((t) => t.phase === phase);
  }
}
