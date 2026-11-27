import { env } from './config/env.js';
import { createApp } from './app.js';
import { prisma } from './lib/prisma.js';
import { startSweepTimer } from './modules/allocations/sweep.service.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`FoodRescue API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// Once a minute: expiry notices and near-expiry alerts even when nobody is using the app
const sweepTimer = startSweepTimer(60);

async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  clearInterval(sweepTimer);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
