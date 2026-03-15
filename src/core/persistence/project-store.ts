import { join } from 'node:path';
import { FileStore } from './file-store.js';
import type { Project } from '../models/index.js';

/**
 * Project metadata persistence.
 * Path: {dataDir}/projects/{projectId}/project.json
 */
export class ProjectStore {
  constructor(
    private readonly fileStore: FileStore,
    private readonly dataDir: string,
  ) {}

  private projectFile(projectId: string): string {
    return join(this.dataDir, 'projects', projectId, 'project.json');
  }

  private projectsListDir(): string {
    return join(this.dataDir, 'projects');
  }

  /**
   * Save or update a project.
   */
  async save(project: Project): Promise<void> {
    await this.fileStore.writeJSON(this.projectFile(project.projectId), project);
  }

  /**
   * Load a project by ID. Returns null if not found.
   */
  async load(projectId: string): Promise<Project | null> {
    return this.fileStore.readJSON<Project>(this.projectFile(projectId));
  }

  /**
   * List all project IDs by scanning the projects directory.
   */
  async listIds(): Promise<string[]> {
    const entries = await this.fileStore.listFiles(this.projectsListDir());
    const ids: string[] = [];
    for (const entry of entries) {
      const hasProjectFile = await this.fileStore.exists(
        join(this.projectsListDir(), entry, 'project.json'),
      );
      if (hasProjectFile) {
        ids.push(entry);
      }
    }
    return ids;
  }

  /**
   * List all projects (load each project.json).
   */
  async listAll(): Promise<Project[]> {
    const ids = await this.listIds();
    const projects: Project[] = [];
    for (const id of ids) {
      const project = await this.load(id);
      if (project) {
        projects.push(project);
      }
    }
    return projects;
  }
}
