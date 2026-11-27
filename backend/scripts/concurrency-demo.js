// Scripted concurrency demonstration (command-line version of the admin button).
//
//   npm run demo:concurrency                  -> uses the database in .env
//   npm run demo:concurrency -- --compare     -> also shows what happens WITHOUT the lock
//   npm run demo:concurrency -- --n=20        -> number of simultaneous attempts
//   npx dotenv -e .env.test -- node scripts/concurrency-demo.js --compare   (local DB, fastest)
//
// The logic lives in src/modules/notifications-admin/concurrency-demo.service.js
// so the script and POST /api/admin/demo/concurrency run exactly the same code.
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { runConcurrencyDemo } from '../src/modules/notifications-admin/concurrency-demo.service.js';

// Never run against a production deployment unless demo tools were explicitly enabled
if (process.env.NODE_ENV === 'production' && process.env.ENABLE_DEMO_TOOLS !== 'true') {
  console.error('Refusing to run: NODE_ENV is production. demo:concurrency is a demo tool (set ENABLE_DEMO_TOOLS=true to override).');
  process.exit(1);
}

const attempts = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] || 12);
const compare = process.argv.includes('--compare');

function print(title, r) {
  console.log(`\n${title}  [${r.durationMs} ms]`);
  console.log(`  attempts fired at the same time : ${r.attempts}`);
  console.log(`  succeeded                       : ${r.succeeded}`);
  console.log(`  refused                         : ${r.refused}`);
  console.log(`  servings allocated              : ${r.servingsAllocated} of ${r.servingsConfirmed} confirmed  ${r.overAllocated ? '<-- OVER-ALLOCATED!' : '(never more than confirmed)'}`);
  if (r.refusalReasons.length) console.log(`  refusal reasons                 : ${r.refusalReasons.join(' | ')}`);
}

try {
  const result = await runConcurrencyDemo({ attempts, compare });
  console.log(result.scenario);
  print('WITH the advisory lock (the real allocation engine)', result.withLock);
  if (result.withoutLock) print('WITHOUT a lock (naive check-then-insert, NOT used by the app)', result.withoutLock);
  console.log('\nDemo data cleaned up.');
} catch (e) {
  console.error(e.message || e);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
