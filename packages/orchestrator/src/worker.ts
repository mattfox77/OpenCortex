import { Worker, NativeConnection } from '@temporalio/worker';
import { createClient } from '@supabase/supabase-js';
import * as activities from './activities';
import * as os from 'os';
import * as dotenv from 'dotenv';

dotenv.config();

const WORKER_NAME = process.env.WORKER_NAME || `${os.hostname()}-${process.pid}`;
const TASK_QUEUES = (process.env.TASK_QUEUES || 'cortex-tasks').split(',').map(q => q.trim());
const CAPABILITIES = (process.env.CAPABILITIES || 'coding,research').split(',').map(c => c.trim());

async function run() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Register this worker in Open Brain
  await supabase.from('worker_registry').upsert(
    {
      worker_name: WORKER_NAME,
      worker_type: process.env.WORKER_TYPE || 'claude-code',
      task_queues: TASK_QUEUES,
      capabilities: CAPABILITIES,
      machine_info: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        memory_gb: Math.round(os.totalmem() / 1e9),
      },
      status: 'online',
      last_heartbeat: new Date().toISOString(),
    },
    { onConflict: 'worker_name' }
  );

  console.log(`🧠 Open Cortex Worker "${WORKER_NAME}" registered`);
  console.log(`   Task Queues: ${TASK_QUEUES.join(', ')}`);
  console.log(`   Capabilities: ${CAPABILITIES.join(', ')}`);

  // Heartbeat to Open Brain every 30 seconds
  const heartbeat = setInterval(async () => {
    await supabase
      .from('worker_registry')
      .update({ last_heartbeat: new Date().toISOString(), status: 'online' })
      .eq('worker_name', WORKER_NAME);
  }, 30_000);

  // Connect to Temporal
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
  });

  // Create a worker for each task queue
  const workers = await Promise.all(
    TASK_QUEUES.map(queue =>
      Worker.create({
        connection,
        namespace: process.env.TEMPORAL_NAMESPACE || 'default',
        taskQueue: queue,
        workflowsPath: require.resolve('./workflows/cortex'),
        activities,
      })
    )
  );

  console.log(`🚀 Polling ${TASK_QUEUES.length} queue(s)...`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    clearInterval(heartbeat);
    await supabase
      .from('worker_registry')
      .update({ status: 'offline' })
      .eq('worker_name', WORKER_NAME);
    for (const w of workers) w.shutdown();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Run (blocks until shutdown)
  await Promise.all(workers.map(w => w.run()));
}

run().catch(err => {
  console.error('❌ Worker failed:', err);
  process.exit(1);
});
