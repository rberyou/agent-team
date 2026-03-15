import { EventBus, type EventHandler } from '../core/event-bus/index.js';
import type { Event, EventType } from '../core/models/index.js';
import { createChildLogger } from '../logger.js';

/**
 * Base class for all Agents.
 *
 * Each agent has a name, subscribes to relevant event patterns,
 * and can emit new events through the shared EventBus.
 */
export abstract class BaseAgent {
  protected readonly logger;
  private unsubscribers: (() => void)[] = [];

  constructor(
    readonly name: string,
    protected readonly eventBus: EventBus,
  ) {
    this.logger = createChildLogger(`agent:${name}`);
  }

  /**
   * Subscribe to an event pattern. Called during start().
   */
  protected on(pattern: string, handler: EventHandler): void {
    const unsub = this.eventBus.subscribe(pattern, handler);
    this.unsubscribers.push(unsub);
  }

  /**
   * Emit an event through the EventBus.
   */
  protected async emit(
    type: EventType,
    projectId: string,
    payload: Record<string, unknown> = {},
    options: {
      phase?: string;
      correlationId?: string;
      causationId?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<Event> {
    return this.eventBus.emit(type, projectId, `agent:${this.name}`, payload, options);
  }

  /**
   * Defer long-running work to the next event loop tick.
   * Use this in event handlers that perform LLM calls or other slow I/O
   * to prevent blocking the event dispatch chain.
   */
  protected deferWork(fn: () => Promise<void>): void {
    setImmediate(() => {
      fn().catch((err) => {
        this.logger.error({ error: err }, 'Deferred work failed');
      });
    });
  }

  /**
   * Initialize the agent: register all event subscriptions.
   * Subclasses must implement this to define their event reactions.
   */
  abstract start(): void;

  /**
   * Stop the agent: remove all event subscriptions.
   */
  stop(): void {
    this.logger.info('Stopping agent');
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }
}
