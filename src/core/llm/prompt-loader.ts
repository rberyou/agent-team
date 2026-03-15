import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createChildLogger } from '../../logger.js';

const logger = createChildLogger('prompt-loader');

/**
 * Loads prompt templates from .md/.txt files and supports {{variable}} interpolation.
 *
 * Templates are keyed by their relative path without extension:
 *   prompts/product-designer/system.md → "product-designer/system"
 */
export class PromptLoader {
  private templates = new Map<string, string>();

  constructor(private readonly promptsDir: string) {}

  /**
   * Recursively scan the prompts directory and load all .md/.txt files into memory.
   */
  async loadAll(): Promise<void> {
    await this.scanDir(this.promptsDir);
    logger.info({ count: this.templates.size, dir: this.promptsDir }, 'Prompts loaded');
  }

  /**
   * Get a rendered prompt template with variable interpolation.
   *
   * @param key Template key, e.g. "product-designer/generate-prd"
   * @param variables Map of {{variable}} → value replacements
   */
  render(key: string, variables?: Record<string, string>): string {
    const template = this.templates.get(key);
    if (!template) {
      throw new Error(`Prompt template not found: "${key}". Available: [${[...this.templates.keys()].join(', ')}]`);
    }

    if (!variables) return template;

    return template.replace(/\{\{(\w+)\}\}/g, (match, varName: string) => {
      if (varName in variables) {
        return variables[varName];
      }
      logger.warn({ key, variable: varName }, 'Unresolved template variable');
      return match;
    });
  }

  /**
   * Check if a template key exists.
   */
  has(key: string): boolean {
    return this.templates.has(key);
  }

  /**
   * Get all loaded template keys.
   */
  get keys(): string[] {
    return [...this.templates.keys()];
  }

  private async scanDir(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir, { recursive: true }) as unknown as string[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn({ dir }, 'Prompts directory not found, skipping');
        return;
      }
      throw err;
    }

    for (const entry of entries) {
      const ext = extname(entry);
      if (ext !== '.md' && ext !== '.txt') continue;

      const fullPath = join(dir, entry);
      try {
        const content = await readFile(fullPath, 'utf-8');
        // Key: relative path without extension, normalized to forward slashes
        const key = entry.slice(0, -ext.length).replace(/\\/g, '/');
        this.templates.set(key, content);
      } catch {
        logger.warn({ path: fullPath }, 'Failed to read prompt file, skipping');
      }
    }
  }
}
