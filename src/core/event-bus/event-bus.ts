import { v4 as uuid } from 'uuid';
import { eventSchema, type Event, type EventType } from '../models/index.js';
import { EventStore } from '../persistence/index.js';
import { createChildLogger } from '../../logger.js';

const logger = createChildLogger('event-bus');

/**
 * Event handler function type.
 */
export type EventHandler = (event: Event) => void | Promise<void>;

/**
 * Subscription entry: a pattern to match event types + handler.
 * Pattern supports exact match ("task.created") or prefix wildcard ("task.*").
 */
interface Subscription {
  id: string;
  pattern: string;
  handler: EventHandler;
}

/**
 * EventBus: Central pub/sub message hub.
 *
 * Design decisions:
 * - Synchronous serial dispatch to maintain event causality
 * - Events are persisted (append to JSONL) before dispatch
 * - Pattern matching supports exact match and wildcard prefix (e.g., "task.*")
 */
export class EventBus {
  private subscriptions: Subscription[] = [];
  private eventStore: EventStore | null = null;

  /**
   * Attach an EventStore for persistence. Optional for testing.
   */
  setPersistence(eventStore: EventStore): void {
    this.eventStore = eventStore;
  }

  /**
   * Subscribe to events matching a pattern.
   * Returns an unsubscribe function.
   *
   * @param pattern - "task.created" for exact, "task.*" for prefix match, "*" for all
   */
  subscribe(pattern: string, handler: EventHandler): () => void {
    const id = uuid();
    this.subscriptions.push({ id, pattern, handler });
    logger.debug({ pattern, subscriptionId: id }, 'New subscription registered');

    return () => {
      this.subscriptions = this.subscriptions.filter((s) => s.id !== id);
      logger.debug({ pattern, subscriptionId: id }, 'Subscription removed');
    };
  }

  /**
   * Publish an event: validate → persist → serial dispatch to all matching subscribers.
   */
  async publish(event: Event): Promise<void> {
    // 1. Validate event schema
    const result = eventSchema.safeParse(event);
    if (!result.success) {
      logger.error({ event, errors: result.error }, 'Invalid event rejected');
      throw new Error(`Invalid event: ${JSON.stringify(result.error)}`);
    }

    const validEvent = result.data;
    logger.info({ type: validEvent.type, id: validEvent.id, source: validEvent.source }, 'Publishing event');

    // 2. Persist (if EventStore attached)
    if (this.eventStore) {
      await this.eventStore.append(validEvent);
    }

    // 3. Serial dispatch to matching subscribers
    const matchingSubs = this.subscriptions.filter((s) => this.matchPattern(s.pattern, validEvent.type));
    logger.debug({ type: validEvent.type, matchCount: matchingSubs.length }, 'Dispatching event');

    for (const sub of matchingSubs) {
      try {
        await sub.handler(validEvent);
      } catch (err) {
        logger.error(
          { type: validEvent.type, subscriptionId: sub.id, pattern: sub.pattern, error: err },
          'Handler error during event dispatch',
        );
        // Continue dispatching to other handlers — one failure shouldn't block others
      }
    }
  }

  /**
   * Helper: create and publish an event with auto-generated id and timestamp.
   */
  async emit(
    type: EventType,
    projectId: string,
    source: string,
    payload: Record<string, unknown> = {},
    options: {
      phase?: string;
      correlationId?: string;
      causationId?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<Event> {
    const event: Event = {
      id: `evt_${uuid()}`,
      type,
      timestamp: new Date().toISOString(),
      source,
      projectId,
      phase: options.phase,
      correlationId: options.correlationId,
      causationId: options.causationId,
      version: 1,
      payload,
      metadata: options.metadata ?? {},
    };

    await this.publish(event);
    return event;
  }

  /**
   * Get count of active subscriptions (useful for debugging).
   */
  get subscriptionCount(): number {
    return this.subscriptions.length;
  }

  /**
   * Remove all subscriptions. Useful for shutdown/testing.
   */
  clear(): void {
    this.subscriptions = [];
  }

  /**
   * Match an event type against a subscription pattern.
   * - "*" matches everything
   * - "task.*" matches "task.created", "task.completed", etc.
   * - "task.created" matches only "task.created"
   */
  private matchPattern(pattern: string, eventType: string): boolean {
    if (pattern === '*') return true;

    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return eventType.startsWith(prefix + '.');
    }

    return pattern === eventType;
  }
}
