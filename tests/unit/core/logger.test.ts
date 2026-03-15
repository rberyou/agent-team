import { describe, it, expect } from 'vitest';
import { createChildLogger } from '../../../src/logger.js';

describe('logger', () => {
  it('should create a child logger with module name', () => {
    const child = createChildLogger('test-module');
    expect(child).toBeDefined();
    // Pino child loggers have bindings
    expect(child.bindings()).toHaveProperty('module', 'test-module');
  });

  it('should have standard log methods', () => {
    const child = createChildLogger('methods-test');
    expect(typeof child.info).toBe('function');
    expect(typeof child.error).toBe('function');
    expect(typeof child.warn).toBe('function');
    expect(typeof child.debug).toBe('function');
    expect(typeof child.trace).toBe('function');
    expect(typeof child.fatal).toBe('function');
  });
});
