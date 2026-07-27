import { Worker, NativeConnection } from '@temporalio/worker';
import { VersioningBehavior } from '@temporalio/common';
import { createClient } from '@supabase/supabase-js';
import * as activities from './activities';
import * as os from 'os';
import * as dotenv from 'dotenv';
import packageJson from '../package.json';

dotenv.config();

const WORKER_NAME = process.env.WORKER_NAME || `${os.hostname()}-${process.pid}`;
const TASK_QUEUES = (process.env.TASK_QUEUES || 'cortex-tasks').split(',').map(q => q.trim());
const CAPABILITIES = (process.env.CAPABILITIES || 'coding,research').split(',').map(c => c.trim());
const WORKER_DEPLOYMENT_NAME =
  process.env.OPENCORTEX_WORKER_DEPLOYMENT_NAME || 'opencortex-orchestrator';
const WORKER_BUILD_ID = sanitizeBuildId(
  process.env.OPENCORTEX_WORKER_BUILD_ID ||
    process.env.GIT_COMMIT ||
    `${packageJson.name}@${packageJson.version}-dev`,
);
const USE_WORKER_VERSIONING =
  process.env.OPENCORTEX_WORKER_VERSIONING === '1' ||
  process.env.OPENCORTEX_WORKER_VERSIONING === 'true';

async function run() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Register this worker in Cortex Memory
  await supabase.from('workers').upsert(
    {
      name: WORKER_NAME,
      kind: process.env.WORKER_TYPE || 'opencode',
      queues: TASK_QUEUES,
      capabilities: CAPABILITIES,
      machine: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        memory_gb: Math.round(os.totalmem() / 1e9),
        deployment_name: WORKER_DEPLOYMENT_NAME,
        build_id: WORKER_BUILD_ID,
        worker_versioning: USE_WORKER_VERSIONING,
      },
      status: 'online',
      heartbeat: new Date().toISOString(),
    },
    { onConflict: 'name' }
  );

  console.log(`🧠 Open Cortex Worker "${WORKER_NAME}" registered`);
  console.log(`   Task Queues: ${TASK_QUEUES.join(', ')}`);
  console.log(`   Capabilities: ${CAPABILITIES.join(', ')}`);
  console.log(`   Deployment: ${WORKER_DEPLOYMENT_NAME}.${WORKER_BUILD_ID}`);

  // Heartbeat to Cortex Memory every 30 seconds
  const heartbeat = setInterval(async () => {
    await supabase
      .from('workers')
      .update({ heartbeat: new Date().toISOString(), status: 'online' })
      .eq('name', WORKER_NAME);
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
        workflowsPath: require.resolve('./workflows'),
        activities,
        workerDeploymentOptions: USE_WORKER_VERSIONING
          ? {
              version: {
                deploymentName: WORKER_DEPLOYMENT_NAME,
                buildId: WORKER_BUILD_ID,
              },
              useWorkerVersioning: true,
              defaultVersioningBehavior: VersioningBehavior.AUTO_UPGRADE,
            }
          : {
              version: {
                deploymentName: WORKER_DEPLOYMENT_NAME,
                buildId: WORKER_BUILD_ID,
              },
              useWorkerVersioning: false,
            },
      })
    )
  );

  console.log(`🚀 Polling ${TASK_QUEUES.length} queue(s)...`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    clearInterval(heartbeat);
    await supabase
      .from('workers')
      .update({ status: 'offline' })
      .eq('name', WORKER_NAME);
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

function sanitizeBuildId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.@-]/g, '-').slice(0, 255);
}
