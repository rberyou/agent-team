import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptLoader } from '../../../src/core/llm/prompt-loader.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'prompt-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('PromptLoader', () => {
  it('should load .md files from directory', async () => {
    await mkdir(join(tempDir, 'agent-a'), { recursive: true });
    await writeFile(join(tempDir, 'agent-a', 'system.md'), 'You are agent A.');
    await writeFile(join(tempDir, 'agent-a', 'task.md'), 'Do the task: {{taskName}}');

    const loader = new PromptLoader(tempDir);
    await loader.loadAll();

    expect(loader.keys).toContain('agent-a/system');
    expect(loader.keys).toContain('agent-a/task');
  });

  it('should render template without variables', async () => {
    await writeFile(join(tempDir, 'simple.md'), 'Hello world');

    const loader = new PromptLoader(tempDir);
    await loader.loadAll();

    expect(loader.render('simple')).toBe('Hello world');
  });

  it('should render template with variable interpolation', async () => {
    await writeFile(join(tempDir, 'greeting.md'), 'Hello {{name}}, welcome to {{project}}!');

    const loader = new PromptLoader(tempDir);
    await loader.loadAll();

    const result = loader.render('greeting', { name: 'Alice', project: 'AgentTeam' });
    expect(result).toBe('Hello Alice, welcome to AgentTeam!');
  });

  it('should leave unresolved variables intact', async () => {
    await writeFile(join(tempDir, 'partial.md'), '{{resolved}} and {{unresolved}}');

    const loader = new PromptLoader(tempDir);
    await loader.loadAll();

    const result = loader.render('partial', { resolved: 'YES' });
    expect(result).toBe('YES and {{unresolved}}');
  });

  it('should throw on missing template key', async () => {
    const loader = new PromptLoader(tempDir);
    await loader.loadAll();

    expect(() => loader.render('nonexistent')).toThrow('Prompt template not found');
  });

  it('should handle empty prompts directory gracefully', async () => {
    const loader = new PromptLoader(join(tempDir, 'nonexistent'));
    await loader.loadAll();

    expect(loader.keys).toEqual([]);
  });

  it('should load .txt files as well', async () => {
    await writeFile(join(tempDir, 'note.txt'), 'A text prompt');

    const loader = new PromptLoader(tempDir);
    await loader.loadAll();

    expect(loader.has('note')).toBe(true);
    expect(loader.render('note')).toBe('A text prompt');
  });

  it('should ignore non .md/.txt files', async () => {
    await writeFile(join(tempDir, 'data.json'), '{"key": "value"}');
    await writeFile(join(tempDir, 'prompt.md'), 'Valid');

    const loader = new PromptLoader(tempDir);
    await loader.loadAll();

    expect(loader.keys).toEqual(['prompt']);
  });
});
