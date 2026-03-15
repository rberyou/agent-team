import { join } from 'node:path';
import { FileStore } from './file-store.js';
import type { Task } from '../models/index.js';
import type { Phase } from '../models/index.js';

/**
 * Task persistence.
 * Path: {dataDir}/projects/{projectId}/tasks/{taskId}.json
 */
export class TaskStore {
  constructor(
    private readonly fileStore: FileStore,
    private readonly dataDir: string,
  ) {}

  private taskFile(projectId: string, taskId: string): string {
    return join(this.dataDir, 'projects', projectId, 'tasks', `${taskId}.json`);
  }

  private tasksDir(projectId: string): string {
    return join(this.dataDir, 'projects', projectId, 'tasks');
  }

  async save(task: Task): Promise<void> {
    await this.fileStore.writeJSON(this.taskFile(task.projectId, task.taskId), task);
  }

  async load(projectId: string, taskId: string): Promise<Task | null> {
    return this.fileStore.readJSON<Task>(this.taskFile(projectId, taskId));
  }

  async listAll(projectId: string): Promise<Task[]> {
    const dir = this.tasksDir(projectId);
    const files = await this.fileStore.listFiles(dir);
    const tasks: Task[] = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        const task = await this.fileStore.readJSON<Task>(join(dir, file));
        if (task) {
          tasks.push(task);
        }
      }
    }
    return tasks;
  }
}

/**
 * Phase persistence.
 * Path: {dataDir}/projects/{projectId}/phases/{phaseName}.json
 */
export class PhaseStore {
  constructor(
    private readonly fileStore: FileStore,
    private readonly dataDir: string,
  ) {}

  private phaseFile(projectId: string, phaseName: string): string {
    return join(this.dataDir, 'projects', projectId, 'phases', `${phaseName}.json`);
  }

  private phasesDir(projectId: string): string {
    return join(this.dataDir, 'projects', projectId, 'phases');
  }

  async save(phase: Phase): Promise<void> {
    await this.fileStore.writeJSON(this.phaseFile(phase.projectId, phase.name), phase);
  }

  async load(projectId: string, phaseName: string): Promise<Phase | null> {
    return this.fileStore.readJSON<Phase>(this.phaseFile(projectId, phaseName));
  }

  async listAll(projectId: string): Promise<Phase[]> {
    const dir = this.phasesDir(projectId);
    const files = await this.fileStore.listFiles(dir);
    const phases: Phase[] = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        const phase = await this.fileStore.readJSON<Phase>(join(dir, file));
        if (phase) {
          phases.push(phase);
        }
      }
    }
    return phases;
  }
}

/**
 * Artifact persistence.
 * Path: {dataDir}/projects/{projectId}/artifacts/{phase}/{filename}
 */
export class ArtifactStore {
  constructor(
    private readonly fileStore: FileStore,
    private readonly dataDir: string,
  ) {}

  private artifactPath(projectId: string, phase: string, filename: string): string {
    return join(this.dataDir, 'projects', projectId, 'artifacts', phase, filename);
  }

  async save(projectId: string, phase: string, filename: string, content: unknown): Promise<void> {
    const filePath = this.artifactPath(projectId, phase, filename);
    await this.fileStore.writeJSON(filePath, content);
  }

  async load<T>(projectId: string, phase: string, filename: string): Promise<T | null> {
    return this.fileStore.readJSON<T>(this.artifactPath(projectId, phase, filename));
  }

  async list(projectId: string, phase: string): Promise<string[]> {
    const dir = join(this.dataDir, 'projects', projectId, 'artifacts', phase);
    return this.fileStore.listFiles(dir);
  }

  /**
   * Extract real source files from code artifacts to the project output directory.
   * Reads all code.json files under implementation/, extracts files[] and unitTests[],
   * and writes them as real files to {dataDir}/projects/{projectId}/output/.
   */
  async extractCodeFiles(projectId: string): Promise<{ filesWritten: number; errors: string[] }> {
    const outputDir = join(this.dataDir, 'projects', projectId, 'output');
    const implDir = join(this.dataDir, 'projects', projectId, 'artifacts', 'implementation');

    let filesWritten = 0;
    const errors: string[] = [];

    // Recursively list all files under implementation/
    const allFiles = await this.fileStore.listFilesRecursive(implDir);
    const codeFiles = allFiles.filter((f) => f.endsWith('/code.json') || f === 'code.json');

    for (const codeFile of codeFiles) {
      try {
        const artifact = await this.fileStore.readJSON<{
          files?: Array<{ path: string; content: string }>;
          unitTests?: Array<{ path: string; content: string }>;
        }>(join(implDir, codeFile));

        if (!artifact) continue;

        // Extract source files
        const entries = [
          ...(artifact.files ?? []),
          ...(artifact.unitTests ?? []),
        ];

        for (const entry of entries) {
          if (!entry.path || !entry.content) continue;
          // Security: reject paths with '..'
          if (entry.path.includes('..')) {
            errors.push(`Skipped unsafe path: ${entry.path}`);
            continue;
          }
          await this.fileStore.writeText(join(outputDir, entry.path), entry.content);
          filesWritten++;
        }
      } catch (err) {
        errors.push(`Failed to process ${codeFile}: ${err}`);
      }
    }

    return { filesWritten, errors };
  }
}
