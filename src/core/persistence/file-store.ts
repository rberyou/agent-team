import { mkdir, readFile, writeFile, appendFile, readdir, stat, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

/**
 * Low-level file system operations with automatic directory creation.
 */
export class FileStore {
  /**
   * Ensure a directory exists, creating it recursively if needed.
   */
  async ensureDir(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
  }

  /**
   * Read a JSON file and parse it. Returns null if file doesn't exist.
   */
  async readJSON<T>(filePath: string): Promise<T | null> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Write an object as JSON to a file, creating parent dirs if needed.
   */
  async writeJSON(filePath: string, data: unknown): Promise<void> {
    await this.ensureDir(dirname(filePath));
    await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  /**
   * Append a line to a file (for JSONL logs), creating parent dirs if needed.
   */
  async appendLine(filePath: string, line: string): Promise<void> {
    await this.ensureDir(dirname(filePath));
    await appendFile(filePath, line + '\n', 'utf-8');
  }

  /**
   * Read all lines from a JSONL file, parsing each as JSON.
   * Returns empty array if file doesn't exist.
   */
  async readJSONL<T>(filePath: string): Promise<T[]> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as T);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * List files in a directory. Returns empty array if dir doesn't exist.
   */
  async listFiles(dirPath: string): Promise<string[]> {
    try {
      return await readdir(dirPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * Check if a file exists.
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write plain text content to a file, creating parent dirs if needed.
   */
  async writeText(filePath: string, content: string): Promise<void> {
    await this.ensureDir(dirname(filePath));
    await writeFile(filePath, content, 'utf-8');
  }

  /**
   * Recursively list all files under a directory.
   * Returns paths relative to dirPath, e.g. "subdir/file.json".
   * Returns empty array if dir doesn't exist.
   */
  async listFilesRecursive(dirPath: string): Promise<string[]> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true, recursive: true });
      const result: string[] = [];
      for (const entry of entries) {
        if (entry.isFile()) {
          // entry.parentPath is available in Node 20+, use it to build the relative path
          const parentDir = entry.parentPath ?? (entry as any).path ?? dirPath;
          const fullPath = join(parentDir, entry.name);
          result.push(relative(dirPath, fullPath));
        }
      }
      return result;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * Delete a file or directory (recursively).
   */
  async delete(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
}
