#!/bin/bash
# ============================================================
# Example: Start 3 workers on different task queues
# ============================================================
# This simulates a multi-machine setup on a single machine
# using different terminals. In production, you'd run each
# of these on a different machine.
#
# Usage:
#   chmod +x examples/multi-worker.sh
#   ./examples/multi-worker.sh
# ============================================================

echo "🧠 Open Cortex — Multi-Worker Demo"
echo "==================================="
echo ""
echo "Starting 3 workers in background..."
echo ""

# Worker 1: General tasks
WORKER_NAME=worker-general \
TASK_QUEUES=cortex-tasks \
CAPABILITIES=coding,research \
npx ts-node src/worker.ts &
PID1=$!
echo "  ✅ worker-general (PID $PID1) → cortex-tasks"

sleep 2

# Worker 2: Code-specific tasks
WORKER_NAME=worker-code \
TASK_QUEUES=cortex-tasks,cortex-code \
CAPABILITIES=coding,review,testing \
npx ts-node src/worker.ts &
PID2=$!
echo "  ✅ worker-code (PID $PID2) → cortex-tasks, cortex-code"

sleep 2

# Worker 3: Deploy tasks
WORKER_NAME=worker-deploy \
TASK_QUEUES=cortex-deploy \
CAPABILITIES=deploy,devops \
npx ts-node src/worker.ts &
PID3=$!
echo "  ✅ worker-deploy (PID $PID3) → cortex-deploy"

echo ""
echo "All workers running! Open http://localhost:8233 to see them in Temporal UI."
echo ""
echo "Try these commands in another terminal:"
echo ""
echo "  # General task (picked up by worker-general or worker-code)"
echo "  npm run task -- \"Summarize the recent changes in this repo\""
echo ""
echo "  # Code review (picked up by worker-code)"
echo "  npm run task -- --queue cortex-code \"Review the auth module\""
echo ""
echo "  # Deployment (picked up by worker-deploy)"
echo "  npm run task -- --queue cortex-deploy --approval \"Deploy to staging\""
echo ""
echo "Press Ctrl+C to stop all workers."

# Wait for Ctrl+C
trap "echo ''; echo '🛑 Stopping all workers...'; kill $PID1 $PID2 $PID3 2>/dev/null; exit 0" SIGINT SIGTERM
wait
