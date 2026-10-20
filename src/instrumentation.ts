// Starts the durable job worker inside the Node.js server process (not on the edge, not during builds).
// Disable with MARGIN_WORKER=off when an external scheduler calls /api/cron/tick instead.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.MARGIN_WORKER === "off") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startWorker } = await import("./lib/server/worker");
  startWorker();
}
