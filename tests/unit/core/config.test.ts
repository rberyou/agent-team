import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../../src/config.js';

describe('config', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env['NODE_ENV'];
    delete process.env['PORT'];
    delete process.env['HOST'];
    delete process.env['DATA_DIR'];
    delete process.env['LOG_LEVEL'];
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('should load default config when no env vars set', () => {
    const config = loadConfig();

    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.host).toBe('localhost');
    expect(config.logLevel).toBe('info');
    expect(config.dataDir).toContain('.agent-team');
  });

  it('should load config from env vars', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['PORT'] = '8080';
    process.env['HOST'] = '0.0.0.0';
    process.env['DATA_DIR'] = '/tmp/agent-data';
    process.env['LOG_LEVEL'] = 'debug';

    const config = loadConfig();

    expect(config.nodeEnv).toBe('production');
    expect(config.port).toBe(8080);
    expect(config.host).toBe('0.0.0.0');
    expect(config.dataDir).toBe('/tmp/agent-data');
    expect(config.logLevel).toBe('debug');
  });

  it('should resolve relative dataDir to absolute path', () => {
    process.env['DATA_DIR'] = 'my-data';

    const config = loadConfig();

    expect(config.dataDir).toMatch(/^\//);
    expect(config.dataDir).toContain('my-data');
  });

  it('should throw on invalid port', () => {
    process.env['PORT'] = '99999';

    expect(() => loadConfig()).toThrow();
  });

  it('should throw on invalid nodeEnv', () => {
    process.env['NODE_ENV'] = 'invalid';

    expect(() => loadConfig()).toThrow();
  });

  it('should freeze the config object', () => {
    const config = loadConfig();

    expect(Object.isFrozen(config)).toBe(true);
  });
});
