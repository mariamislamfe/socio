/* Starts the local database and the Next.js dev server together. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const port = Number(process.env.LOCAL_DB_PORT || 54329);
const usingSupabase = !!process.env.SUPABASE_DB_URL;
const procs: ReturnType<typeof spawn>[] = [];
const run = (cmd: string, args: string[]) => {
  const p = spawn(cmd, args, { stdio: "inherit", shell: true });
  procs.push(p);
  return p;
};
const waitPort = (p: number, ms = 60_000) =>
  new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tryOnce = () => {
      const s = net.connect(p, "127.0.0.1");
      s.once("connect", () => (s.destroy(), resolve()));
      s.once("error", () => {
        s.destroy();
        if (Date.now() - started > ms) reject(new Error("database did not start"));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });

async function startDb() {
  const child = run("npx", ["tsx", "scripts/dev-db.mts"]);
  const code = await new Promise<number | null>((resolve) => {
    const t = setInterval(async () => {
      try {
        await waitPort(port, 400);
        clearInterval(t);
        resolve(null);
      } catch {
        /* keep waiting */
      }
    }, 500);
    child.once("exit", (c) => (clearInterval(t), resolve(c)));
  });
  return code;
}

if (!usingSupabase) {
  let code = await startDb();
  if (code === 42) {
    const dir =
      process.env.PGLITE_DIR ||
      path.join(
        os.homedir(),
        ".margin-dev",
        crypto.createHash("sha1").update(process.cwd()).digest("hex").slice(0, 8),
        "pglite",
      );
    const aside = `${dir}.corrupt-${Date.now()}`;
    console.warn(`[dev] The local database was left corrupted. Keeping a copy at ${aside} and starting fresh.`);
    fs.renameSync(dir, aside);
    code = await startDb();
  }
  if (code !== null) {
    console.error("[dev] The local database failed to start.");
    process.exit(1);
  }
}
run("npx", ["next", "dev", "-p", process.env.PORT || "3000"]);
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
