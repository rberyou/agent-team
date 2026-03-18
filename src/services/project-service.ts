import { v4 as uuid } from 'uuid';
import { EventBus } from '../core/event-bus/index.js';
import { ProjectStore, PhaseStore } from '../core/persistence/index.js';
import { canPhaseTransition } from '../core/state-machine/index.js';
import {
  EventType,
  EventSource,
  PhaseName,
  PhaseStatus,
  ProjectStatus,
  projectSchema,
  phaseSchema,
} from '../core/models/index.js';
import type { Project, Phase } from '../core/models/index.js';
import { createChildLogger } from '../logger.js';

const logger = createChildLogger('project-service');

// Phase order for linear progression
const PHASE_ORDER: string[] = [
  PhaseName.Analysis,
  PhaseName.Design,
  PhaseName.Implementation,
  PhaseName.Testing,
  PhaseName.Acceptance,
];

export class ProjectService {
  constructor(
    private readonly eventBus: EventBus,
    private readonly projectStore: ProjectStore,
    private readonly phaseStore: PhaseStore,
  ) {}

  /**
   * Create a new project and initialize all 5 phases.
   */
  async createProject(name: string, description: string, requiresUI = false): Promise<Project> {
    const projectId = `proj_${uuid()}`;
    const now = new Date().toISOString();

    const project = projectSchema.parse({
      projectId,
      name,
      description,
      status: ProjectStatus.Created,
      currentPhase: null,
      phases: PHASE_ORDER.map((p) => `phase_${p}`),
      config: { requiresUI, maxRetryOnFailure: 3 },
      createdAt: now,
      updatedAt: now,
    });

    // Create all phase records
    for (const phaseName of PHASE_ORDER) {
      const phase = phaseSchema.parse({
        phaseId: `phase_${phaseName}`,
        projectId,
        name: phaseName,
        status: PhaseStatus.Pending,
      });
      await this.phaseStore.save(phase);
    }

    await this.projectStore.save(project);

    // Emit project.created event
    await this.eventBus.emit(EventType.ProjectCreated, projectId, EventSource.System, {
      projectId,
      name,
      description,
    });

    logger.info({ projectId, name }, 'Project created');
    return project;
  }

  /**
   * Activate a project and enter the analysis phase.
   */
  async activateProject(projectId: string): Promise<Project> {
    const project = await this.projectStore.load(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (project.status !== ProjectStatus.Created) {
      throw new Error(`Project ${projectId} cannot be activated from status '${project.status}'`);
    }

    const now = new Date().toISOString();
    project.status = ProjectStatus.Active;
    project.currentPhase = PhaseName.Analysis;
    project.updatedAt = now;
    await this.projectStore.save(project);

    // Activate the analysis phase
    await this.enterPhase(projectId, PhaseName.Analysis);

    await this.eventBus.emit(EventType.ProjectStatusChanged, projectId, EventSource.System, {
      projectId,
      status: ProjectStatus.Active,
    });

    return project;
  }

  /**
   * Enter (activate) a phase.
   */
  async enterPhase(projectId: string, phaseName: string): Promise<Phase> {
    const phase = await this.phaseStore.load(projectId, phaseName);
    if (!phase) throw new Error(`Phase not found: ${phaseName} in project ${projectId}`);

    const transition = canPhaseTransition(phase.status, PhaseStatus.Active);
    if (!transition.valid) throw new Error(transition.reason);

    const now = new Date().toISOString();
    phase.status = PhaseStatus.Active;
    phase.startedAt = phase.startedAt ?? now;
    await this.phaseStore.save(phase);

    await this.eventBus.emit(EventType.PhaseEntered, projectId, EventSource.System, {
      phase: phaseName,
    }, { phase: phaseName });

    logger.info({ projectId, phase: phaseName }, 'Phase entered');
    return phase;
  }

  /**
   * Complete a phase and optionally advance to the next.
   */
  async completePhase(projectId: string, phaseName: string): Promise<Phase> {
    const phase = await this.phaseStore.load(projectId, phaseName);
    if (!phase) throw new Error(`Phase not found: ${phaseName}`);

    const transition = canPhaseTransition(phase.status, PhaseStatus.Completed);
    if (!transition.valid) throw new Error(transition.reason);

    const now = new Date().toISOString();
    phase.status = PhaseStatus.Completed;
    phase.completedAt = now;
    await this.phaseStore.save(phase);

    await this.eventBus.emit(EventType.PhaseCompleted, projectId, EventSource.System, {
      phase: phaseName,
    }, { phase: phaseName });

    // Advance to next phase if available.
    // Re-load project AFTER emitting PhaseCompleted, because the synchronous
    // event chain may have already advanced currentPhase further.
    const currentIndex = PHASE_ORDER.indexOf(phaseName);
    if (currentIndex >= 0 && currentIndex < PHASE_ORDER.length - 1) {
      const nextPhase = PHASE_ORDER[currentIndex + 1];
      const project = await this.projectStore.load(projectId);
      if (project) {
        const projectPhaseIndex = PHASE_ORDER.indexOf(project.currentPhase as string);
        // Only advance if the project hasn't already moved past this phase
        if (projectPhaseIndex <= currentIndex) {
          project.currentPhase = nextPhase as Project['currentPhase'];
          project.updatedAt = now;
          await this.projectStore.save(project);
        }
      }
    } else if (currentIndex === PHASE_ORDER.length - 1) {
      // Last phase completed — mark project as completed
      const project = await this.projectStore.load(projectId);
      if (project) {
        project.status = ProjectStatus.Completed;
        project.completedAt = now;
        project.updatedAt = now;
        await this.projectStore.save(project);
      }
    }

    logger.info({ projectId, phase: phaseName }, 'Phase completed');
    return phase;
  }

  async getProject(projectId: string): Promise<Project | null> {
    return this.projectStore.load(projectId);
  }

  async listProjects(): Promise<Project[]> {
    return this.projectStore.listAll();
  }

  async deleteProject(projectId: string): Promise<void> {
    const project = await this.projectStore.load(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    await this.projectStore.delete(projectId);
    logger.info({ projectId }, 'Project deleted');
  }
}
