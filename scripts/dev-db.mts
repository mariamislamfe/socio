/* Local development database: PGlite (real Postgres in WASM) exposed on a TCP port.
   Exit code 42 means the data directory could not be opened (usually a force-killed process left it corrupted);
   `npm run dev` then sets it aside and starts a fresh one. */
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

// Kept OUTSIDE the project: database writes inside the repo make the Next.js file watcher rebuild in a loop.
const dir =
  process.env.PGLITE_DIR ||
  path.join(
    os.homedir(),
    ".margin-dev",
    crypto.createHash("sha1").update(process.cwd()).digest("hex").slice(0, 8),
    "pglite",
  );
const port = Number(process.env.LOCAL_DB_PORT || 54329);
fs.mkdirSync(path.dirname(dir), { recursive: true });

let db: PGlite;
try {
  db = await PGlite.create(dir);
  await db.query("select 1");
} catch (e) {
  console.error(`[dev-db] could not open ${dir}: ${(e as Error).message}`);
  console.error(
    "[dev-db] The data directory is probably corrupted. Delete it (or run `npm run dev`, which sets it aside automatically).",
  );
  process.exit(42);
}
// A force-killed client must not hold the only slot forever: allow a few connections and reap idle ones.
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 4, idleTimeout: 300_000 });
await server.start();
console.log(`[dev-db] PGlite listening on 127.0.0.1:${port} (data: ${dir})`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
