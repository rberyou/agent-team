import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseAgent } from '../../../src/agents/base-agent.js';
import { EventBus } from '../../../src/core/event-bus/index.js';
import { EventType, EventSource } from '../../../src/core/models/index.js';
import type { Event } from '../../../src/core/models/index.js';

// Concrete test agent
class TestAgent extends BaseAgent {
  public receivedEvents: Event[] = [];

  constructor(eventBus: EventBus) {
    super('test', eventBus);
  }

  start(): void {
    this.on('task.*', (event) => {
      this.receivedEvents.push(event);
    });
  }

  async testEmit(): Promise<Event> {
    return this.emit(EventType.TaskCreated, 'proj_001', { taskId: 'task_001' }, { phase: 'analysis' });
  }
}

describe('BaseAgent', () => {
  let bus: EventBus;
  let agent: TestAgent;

  beforeEach(() => {
    bus = new EventBus();
    agent = new TestAgent(bus);
  });

  it('should subscribe to events on start()', async () => {
    agent.start();
    expect(bus.subscriptionCount).toBe(1);

    await bus.emit(EventType.TaskCreated, 'proj_001', EventSource.AgentPM, { taskId: 'task_001' });
    expect(agent.receivedEvents).toHaveLength(1);
  });

  it('should not receive events before start()', async () => {
    await bus.emit(EventType.TaskCreated, 'proj_001', EventSource.AgentPM, {});
    expect(agent.receivedEvents).toHaveLength(0);
  });

  it('should unsubscribe on stop()', async () => {
    agent.start();
    expect(bus.subscriptionCount).toBe(1);

    agent.stop();
    expect(bus.subscriptionCount).toBe(0);

    await bus.emit(EventType.TaskCreated, 'proj_001', EventSource.AgentPM, {});
    expect(agent.receivedEvents).toHaveLength(0);
  });

  it('should emit events through the bus', async () => {
    const handler = vi.fn();
    bus.subscribe(EventType.TaskCreated, handler);

    agent.start();
    const event = await agent.testEmit();

    expect(event.type).toBe(EventType.TaskCreated);
    expect(event.source).toBe('agent:test');
    expect(event.payload).toEqual({ taskId: 'task_001' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
