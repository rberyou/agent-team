import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { createChildLogger } from '../logger.js';
import type { EventBus } from '../core/event-bus/index.js';
import type { ProjectService } from '../services/project-service.js';
import type { TaskService } from '../services/task-service.js';
import type { ArtifactStore, EventStore } from '../core/persistence/index.js';
import { EventType, EventSource } from '../core/models/index.js';
import { getDashboardHtml } from './dashboard.js';

const logger = createChildLogger('api');

export interface AppDependencies {
  eventBus: EventBus;
  projectService: ProjectService;
  taskService: TaskService;
  artifactStore: ArtifactStore;
  eventStore: EventStore;
  dataDir: string;
}

export async function createApp(deps: AppDependencies) {
  const app = Fastify({
    logger: false, // We use our own pino logger
  });

  // Register WebSocket plugin
  await app.register(websocket);

  // Track connected WebSocket clients
  interface WsClient { send(data: string): void; readyState: number }
  const clients = new Set<WsClient>();

  const { eventBus, projectService, taskService, artifactStore, eventStore, dataDir } = deps;

  // Broadcast all events to connected WebSocket clients
  eventBus.subscribe('*', (event) => {
    const msg = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(msg);
      }
    }
  });

  // --- Dashboard ---
  app.get('/', async (_request, reply) => {
    return reply.type('text/html').send(getDashboardHtml());
  });

  // --- WebSocket endpoint ---
  app.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    logger.info({ clientCount: clients.size }, 'WebSocket client connected');

    socket.on('close', () => {
      clients.delete(socket);
      logger.info({ clientCount: clients.size }, 'WebSocket client disconnected');
    });
  });

  // --- Health check ---
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // --- Projects ---

  // POST /api/projects - Submit requirement and create project
  app.post<{
    Body: { requirement: string; projectName?: string; requiresUI?: boolean };
  }>('/api/projects', async (request, reply) => {
    const { requirement, projectName, requiresUI } = request.body;

    if (!requirement || typeof requirement !== 'string') {
      return reply.status(400).send({ error: 'requirement is required' });
    }

    // Emit the user.requirement_submitted event — PM agent will handle the rest
    const event = await eventBus.emit(
      EventType.UserRequirementSubmitted,
      'pending',
      EventSource.User,
      { requirement, projectName, requiresUI: requiresUI ?? false },
    );

    logger.info({ eventId: event.id }, 'Requirement submitted');

    // Wait briefly for the event chain to process
    await new Promise((r) => setTimeout(r, 200));

    // Return the newly created project
    const projects = await projectService.listProjects();
    const latest = projects[projects.length - 1];

    return reply.status(201).send({
      message: 'Project created from requirement',
      project: latest,
    });
  });

  // GET /api/projects - List all projects
  app.get('/api/projects', async () => {
    const projects = await projectService.listProjects();
    return { projects };
  });

  // GET /api/projects/:projectId - Get project details
  app.get<{
    Params: { projectId: string };
  }>('/api/projects/:projectId', async (request, reply) => {
    const project = await projectService.getProject(request.params.projectId);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    return { project };
  });

  // DELETE /api/projects/:projectId - Delete a project
  app.delete<{
    Params: { projectId: string };
  }>('/api/projects/:projectId', async (request, reply) => {
    const { projectId } = request.params;
    try {
      await projectService.deleteProject(projectId);
      return { success: true };
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });

  // GET /api/projects/:projectId/pending-confirmation - Get pending confirmation
  app.get<{
    Params: { projectId: string };
  }>('/api/projects/:projectId/pending-confirmation', async (request, _reply) => {
    const { projectId } = request.params;
    const confirmation = await eventStore.getPendingConfirmation(projectId);
    return { pendingConfirmation: confirmation };
  });

  // GET /api/projects/:projectId/pending-confirmations - Get all pending confirmations
  app.get<{
    Params: { projectId: string };
  }>('/api/projects/:projectId/pending-confirmations', async (request, _reply) => {
    const { projectId } = request.params;
    const confirmations = await eventStore.getPendingConfirmations(projectId);
    return { pendingConfirmations: confirmations };
  });

  // GET /api/projects/:projectId/events - Get event timeline
  app.get<{
    Params: { projectId: string };
    Querystring: { limit?: string; offset?: string };
  }>('/api/projects/:projectId/events', async (request) => {
    const { projectId } = request.params;
    const limit = Math.min(parseInt(request.query.limit || '500'), 1000);
    const offset = parseInt(request.query.offset || '0');
    const allEvents = await eventStore.readAll(projectId);
    const total = allEvents.length;
    const events = allEvents.slice(offset, offset + limit);
    return { events, total, limit, offset };
  });

  // --- Tasks ---

  // GET /api/projects/:projectId/tasks - List tasks for a project
  app.get<{
    Params: { projectId: string };
    Querystring: { phase?: string };
  }>('/api/projects/:projectId/tasks', async (request) => {
    const { projectId } = request.params;
    const { phase } = request.query;

    if (phase) {
      const tasks = await taskService.listTasksByPhase(projectId, phase);
      return { tasks };
    }
    const tasks = await taskService.listTasks(projectId);
    return { tasks };
  });

  // GET /api/projects/:projectId/tasks/in-progress - Get in-progress tasks
  app.get<{
    Params: { projectId: string };
  }>('/api/projects/:projectId/tasks/in-progress', async (request) => {
    const { projectId } = request.params;
    const tasks = await taskService.listTasks(projectId);
    const inProgressTasks = tasks.filter((t) => t.status === 'in_progress');
    return { tasks: inProgressTasks };
  });

  // --- User Decisions ---

  // POST /api/projects/:projectId/confirm - User confirms (e.g., approve PRD)
  app.post<{
    Params: { projectId: string };
    Body: { confirmationType: string; taskId?: string };
  }>('/api/projects/:projectId/confirm', async (request, reply) => {
    const { projectId } = request.params;
    const { confirmationType, taskId } = request.body;

    if (!confirmationType) {
      return reply.status(400).send({ error: 'confirmationType is required' });
    }

    await eventBus.emit(
      EventType.UserConfirmed,
      projectId,
      EventSource.User,
      { confirmationType, taskId },
    );

    // Wait for event chain
    await new Promise((r) => setTimeout(r, 100));

    const project = await projectService.getProject(projectId);
    return { message: 'Confirmation processed', project };
  });

  // POST /api/projects/:projectId/reject - User rejects (e.g., reject PRD)
  app.post<{
    Params: { projectId: string };
    Body: { confirmationType: string; taskId?: string; feedback?: string };
  }>('/api/projects/:projectId/reject', async (request, reply) => {
    const { projectId } = request.params;
    const { confirmationType, taskId, feedback } = request.body;

    if (!confirmationType) {
      return reply.status(400).send({ error: 'confirmationType is required' });
    }

    await eventBus.emit(
      EventType.UserRejected,
      projectId,
      EventSource.User,
      { confirmationType, taskId, feedback },
    );

    await new Promise((r) => setTimeout(r, 100));

    const tasks = await taskService.listTasks(projectId);
    return { message: 'Rejection processed', tasks };
  });

  // --- Artifacts ---

  // GET /api/projects/:projectId/artifacts/:phase - List artifacts
  app.get<{
    Params: { projectId: string; phase: string };
  }>('/api/projects/:projectId/artifacts/:phase', async (request) => {
    const { projectId, phase } = request.params;
    const files = await artifactStore.list(projectId, phase);
    return { artifacts: files };
  });

  // GET /api/projects/:projectId/artifacts/:phase/:filename - Get artifact content
  app.get<{
    Params: { projectId: string; phase: string; filename: string };
  }>('/api/projects/:projectId/artifacts/:phase/:filename', async (request, reply) => {
    const { projectId, phase, filename } = request.params;
    const content = await artifactStore.load(projectId, phase, filename);
    if (!content) {
      return reply.status(404).send({ error: 'Artifact not found' });
    }
    return { artifact: content };
  });

  // --- Project Preview (static file serving) ---

  const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.gif': 'image/gif',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };

  // Serve project output files: GET /preview/:projectId/* → .agent-team/projects/{id}/output/*
  app.get('/preview/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    return reply.redirect(`/preview/${projectId}/index.html`);
  });

  app.get('/preview/:projectId/*', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const wildcard = (request.params as Record<string, string>)['*'] || 'index.html';

    const outputRoot = resolve(join(dataDir, 'projects', projectId, 'output'));
    const absPath = resolve(join(outputRoot, wildcard));

    // Security: prevent path traversal
    if (!absPath.startsWith(outputRoot)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const ext = extname(absPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
      const content = await readFile(absPath);
      return reply.type(contentType).send(content);
    } catch {
      return reply.status(404).send({ error: 'File not found' });
    }
  });

  return app;
}
