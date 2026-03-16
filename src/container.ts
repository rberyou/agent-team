import { config } from './config.js';
import { createChildLogger } from './logger.js';
import { EventBus } from './core/event-bus/index.js';
import {
  FileStore,
  EventStore,
  ProjectStore,
  PhaseStore,
  TaskStore,
  ArtifactStore,
} from './core/persistence/index.js';
import { PromptLoader, LLMService, OpenAICompatibleProvider } from './core/llm/index.js';
import type { LLMConfig } from './core/llm/index.js';
import { ProjectService } from './services/project-service.js';
import { TaskService } from './services/task-service.js';
import { PMAgent } from './agents/pm/index.js';
import { ProductDesignerAgent } from './agents/product-designer/index.js';
import { DeveloperAgent } from './agents/developer/index.js';
import { CodeReviewerAgent } from './agents/code-reviewer/index.js';
import { QAAgent } from './agents/qa/index.js';
import { UIDesignerAgent } from './agents/ui-designer/index.js';
import { DevOpsAgent } from './agents/devops/index.js';
import { createApp } from './api/server.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const logger = createChildLogger('container');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Dependency injection container.
 * Creates and wires all components, provides a start/stop lifecycle.
 */
export async function createContainer() {
  // Core infrastructure
  const fileStore = new FileStore();
  const eventBus = new EventBus();

  // Persistence stores
  const eventStore = new EventStore(fileStore, config.dataDir);
  const projectStore = new ProjectStore(fileStore, config.dataDir);
  const phaseStore = new PhaseStore(fileStore, config.dataDir);
  const taskStore = new TaskStore(fileStore, config.dataDir);
  const artifactStore = new ArtifactStore(fileStore, config.dataDir);

  // Wire EventBus to persistence
  eventBus.setPersistence(eventStore);

  // Services
  const projectService = new ProjectService(eventBus, projectStore, phaseStore);
  const taskService = new TaskService(eventBus, taskStore);

  // LLM layer
  const llmConfig: LLMConfig = {
    provider: config.llmProvider,
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    temperature: config.llmTemperature,
    maxTokens: config.llmMaxTokens,
    timeoutMs: config.llmTimeoutMs,
    maxRetries: config.llmMaxRetries,
  };

  const promptLoader = new PromptLoader(join(__dirname, 'prompts'));
  const llmProvider = new OpenAICompatibleProvider(llmConfig);
  const llmService = new LLMService(llmProvider, promptLoader, llmConfig);

  // Agents
  const pmAgent = new PMAgent(eventBus, projectService, taskService, artifactStore);
  const productDesignerAgent = new ProductDesignerAgent(eventBus, taskService, artifactStore, llmService);
  const developerAgent = new DeveloperAgent(eventBus, taskService, artifactStore, llmService, projectService);
  const codeReviewerAgent = new CodeReviewerAgent(eventBus, taskService, artifactStore, llmService);
  const qaAgent = new QAAgent(eventBus, taskService, artifactStore, llmService);
  const uiDesignerAgent = new UIDesignerAgent(eventBus, taskService, artifactStore, llmService);
  const devOpsAgent = new DevOpsAgent(eventBus, taskService, artifactStore, llmService, config.port);

  // API server
  const app = await createApp({ eventBus, projectService, taskService, artifactStore, eventStore, dataDir: config.dataDir });

  return {
    eventBus,
    projectService,
    taskService,
    artifactStore,
    llmService,
    pmAgent,
    productDesignerAgent,
    developerAgent,
    codeReviewerAgent,
    qaAgent,
    uiDesignerAgent,
    devOpsAgent,
    app,

    async start() {
      logger.info({ dataDir: config.dataDir }, 'Starting agent-team system');

      // Ensure data directory exists
      await fileStore.ensureDir(config.dataDir);

      // Load prompt templates
      await promptLoader.loadAll();

      // Start agents
      pmAgent.start();
      productDesignerAgent.start();
      developerAgent.start();
      codeReviewerAgent.start();
      qaAgent.start();
      uiDesignerAgent.start();
      devOpsAgent.start();

      // Start HTTP server
      await app.listen({ port: config.port, host: config.host });
      logger.info({ port: config.port, host: config.host }, 'HTTP server listening');
    },

    async stop() {
      logger.info('Shutting down agent-team system');
      pmAgent.stop();
      productDesignerAgent.stop();
      developerAgent.stop();
      codeReviewerAgent.stop();
      qaAgent.stop();
      uiDesignerAgent.stop();
      devOpsAgent.stop();
      eventBus.clear();
      await app.close();
    },
  };
}
