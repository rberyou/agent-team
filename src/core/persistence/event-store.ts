import { join } from 'node:path';
import { FileStore } from './file-store.js';
import type { Event } from '../models/index.js';

/**
 * Append-only event log storage.
 * Events are stored as JSONL files partitioned by date.
 * Path: {dataDir}/projects/{projectId}/events/YYYY-MM-DD.jsonl
 */
export class EventStore {
  constructor(
    private readonly fileStore: FileStore,
    private readonly dataDir: string,
  ) {}

  private eventsDir(projectId: string): string {
    return join(this.dataDir, 'projects', projectId, 'events');
  }

  private dateFile(projectId: string, timestamp: string): string {
    const date = timestamp.slice(0, 10); // YYYY-MM-DD
    return join(this.eventsDir(projectId), `${date}.jsonl`);
  }

  /**
   * Append an event to the date-partitioned JSONL log.
   */
  async append(event: Event): Promise<void> {
    const filePath = this.dateFile(event.projectId, event.timestamp);
    await this.fileStore.appendLine(filePath, JSON.stringify(event));
  }

  /**
   * Read all events for a project, across all date files, in chronological order.
   */
  async readAll(projectId: string): Promise<Event[]> {
    const dir = this.eventsDir(projectId);
    const files = await this.fileStore.listFiles(dir);
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl')).sort();

    const allEvents: Event[] = [];
    for (const file of jsonlFiles) {
      const events = await this.fileStore.readJSONL<Event>(join(dir, file));
      allEvents.push(...events);
    }
    return allEvents;
  }

  /**
   * Read events for a specific date.
   */
  async readByDate(projectId: string, date: string): Promise<Event[]> {
    const filePath = join(this.eventsDir(projectId), `${date}.jsonl`);
    return this.fileStore.readJSONL<Event>(filePath);
  }

  /**
   * Get all pending confirmations for a project.
   * Returns all user.confirmation_needed events that haven't been
   * followed by a user.confirmed or user.rejected event.
   */
  async getPendingConfirmations(projectId: string): Promise<Event[]> {
    const events = await this.readAll(projectId);

    const pendingConfirmations: Event[] = [];

    for (const event of events) {
      if (event.type === 'user.confirmation_needed') {
        pendingConfirmations.push(event);
      } else if (event.type === 'user.confirmed' || event.type === 'user.rejected') {
        const newType = event.payload?.confirmationType;
        const index = pendingConfirmations.findIndex(
          (p) => p.payload?.confirmationType === newType
        );
        if (index !== -1) {
          pendingConfirmations.splice(index, 1);
        }
      }
    }

    return pendingConfirmations;
  }

  /**
   * Get the latest pending confirmation for a project.
   * Returns the last user.confirmation_needed event that hasn't been
   * followed by a user.confirmed or user.rejected event.
   */
  async getPendingConfirmation(projectId: string): Promise<Event | null> {
    const all = await this.getPendingConfirmations(projectId);
    return all.length > 0 ? all[all.length - 1] : null;
  }
}
