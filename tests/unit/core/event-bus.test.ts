import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../../src/core/event-bus/index.js';
import { EventType, EventSource } from '../../../src/core/models/index.js';
import type { Event } from '../../../src/core/models/index.js';

function makeEvent(type: string, overrides?: Partial<Event>): Event {
  return {
    id: `evt_${Date.now()}`,
    type: type as Event['type'],
    timestamp: new Date().toISOString(),
    source: EventSource.AgentPM,
    projectId: 'proj_001',
    version: 1,
    payload: {},
    metadata: {},
    ...overrides,
  };
}

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('should dispatch event to exact match subscriber', async () => {
    const handler = vi.fn();
    bus.subscribe(EventType.TaskCreated, handler);

    await bus.publish(makeEvent(EventType.TaskCreated));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe(EventType.TaskCreated);
  });

  it('should dispatch event to wildcard subscriber', async () => {
    const handler = vi.fn();
    bus.subscribe('task.*', handler);

    await bus.publish(makeEvent(EventType.TaskCreated));
    await bus.publish(makeEvent(EventType.TaskCompleted));
    await bus.publish(makeEvent(EventType.ProjectCreated)); // should not match

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should dispatch to "*" (catch-all) subscriber', async () => {
    const handler = vi.fn();
    bus.subscribe('*', handler);

    await bus.publish(makeEvent(EventType.TaskCreated));
    await bus.publish(makeEvent(EventType.ProjectCreated));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should dispatch serially (in order)', async () => {
    const order: number[] = [];

    bus.subscribe(EventType.TaskCreated, async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    bus.subscribe(EventType.TaskCreated, () => {
      order.push(2);
    });

    await bus.publish(makeEvent(EventType.TaskCreated));

    // Handler 1 should complete before handler 2 starts (serial dispatch)
    expect(order).toEqual([1, 2]);
  });

  it('should continue dispatch even if a handler throws', async () => {
    const handler1 = vi.fn(() => {
      throw new Error('boom');
    });
    const handler2 = vi.fn();

    bus.subscribe(EventType.TaskCreated, handler1);
    bus.subscribe(EventType.TaskCreated, handler2);

    // Should not throw
    await bus.publish(makeEvent(EventType.TaskCreated));

    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it('unsubscribe removes the handler', async () => {
    const handler = vi.fn();
    const unsub = bus.subscribe(EventType.TaskCreated, handler);

    expect(bus.subscriptionCount).toBe(1);
    unsub();
    expect(bus.subscriptionCount).toBe(0);

    await bus.publish(makeEvent(EventType.TaskCreated));
    expect(handler).not.toHaveBeenCalled();
  });

  it('clear removes all subscriptions', () => {
    bus.subscribe('*', vi.fn());
    bus.subscribe('task.*', vi.fn());
    expect(bus.subscriptionCount).toBe(2);

    bus.clear();
    expect(bus.subscriptionCount).toBe(0);
  });

  it('should reject invalid event', async () => {
    const badEvent = { type: 'invalid' } as unknown as Event;
    await expect(bus.publish(badEvent)).rejects.toThrow();
  });

  it('emit() creates and publishes an event', async () => {
    const handler = vi.fn();
    bus.subscribe(EventType.TaskCreated, handler);

    const event = await bus.emit(
      EventType.TaskCreated,
      'proj_001',
      EventSource.AgentPM,
      { taskId: 'task_001' },
      { phase: 'analysis', correlationId: 'corr_001' },
    );

    expect(event.id).toMatch(/^evt_/);
    expect(event.type).toBe(EventType.TaskCreated);
    expect(event.payload).toEqual({ taskId: 'task_001' });
    expect(event.phase).toBe('analysis');
    expect(event.correlationId).toBe('corr_001');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should persist events when EventStore is attached', async () => {
    const mockAppend = vi.fn();
    const mockEventStore = { append: mockAppend } as any;
    bus.setPersistence(mockEventStore);

    await bus.publish(makeEvent(EventType.ProjectCreated));

    expect(mockAppend).toHaveBeenCalledTimes(1);
  });
});
