// Demo reset: wipes ALL data and re-seeds. Use before a demonstration.
//   npm run demo:reset -- --yes
// The database is shared by the whole team, so it refuses to run without --yes.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seed } from '../prisma/seed.js';

const prisma = new PrismaClient();

// Never run against a production deployment unless demo tools were explicitly enabled
if (process.env.NODE_ENV === 'production' && process.env.ENABLE_DEMO_TOOLS !== 'true') {
  console.error('Refusing to run: NODE_ENV is production. demo:reset is a demo tool (set ENABLE_DEMO_TOOLS=true to override).');
  process.exit(1);
}

if (!process.argv.includes('--yes')) {
  console.error('This deletes ALL data in the database in DATABASE_URL and re-seeds it.');
  console.error('Run again with:  npm run demo:reset -- --yes');
  process.exit(1);
}

const TABLES = [
  'match_decisions', 'handover_records', 'reports', 'rescue_tasks', 'allocations', 'ngo_requests',
  'surplus_listings', 'event_food_plans', 'events', 'daily_food_records', 'food_items', 'notifications',
  'status_history', 'system_config', 'volunteer_profiles', 'users', 'organisations', 'food_categories',
];

try {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  console.log('All tables emptied.');
  console.log('Seeded:', await seed(prisma, { activity: true, log: (m) => console.log(m) }));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
