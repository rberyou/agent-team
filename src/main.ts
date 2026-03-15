import { createContainer } from './container.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger('main');

async function main() {
  const container = await createContainer();

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Received shutdown signal');
    await container.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await container.start();
    logger.info('Agent-team system is running. Press Ctrl+C to stop.');
  } catch (err) {
    logger.fatal({ error: err }, 'Failed to start agent-team system');
    process.exit(1);
  }
}

main();
