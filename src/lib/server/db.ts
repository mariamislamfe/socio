import "server-only";
import fs from "node:fs";
import path from "node:path";
import { PGlite, types as pgTypes } from "@electric-sql/pglite";
import postgres from "postgres";

export type Row = Record<string, any>;
export interface Q {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
}

export type DbMode = "supabase" | "local";
export const dbMode: DbMode = process.env.SUPABASE_DB_URL ? "supabase" : "local";

// Local development talks to an embedded Postgres (PGlite) over a socket, using the same driver as production.
// Tests set PGLITE_DIR to run PGlite in-process instead.
const LOCAL_URL = process.env.LOCAL_DB_URL || "postgres://postgres:postgres@127.0.0.1:54329/postgres";

type Driver = {
  tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  exec(sqlText: string): Promise<void>;
};

const ROOT = process.cwd();
const g = globalThis as unknown as { __margin?: { driver: Driver; ready: Promise<void> } };

function makePglite(): Driver {
  const dir = process.env.PGLITE_DIR || path.join(ROOT, ".data", "pglite");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const db = new PGlite(dir, {
    parsers: {
      [pgTypes.INT8]: (v: string) => Number(v),
      [pgTypes.NUMERIC]: (v: string) => Number(v),
      [pgTypes.DATE]: (v: string) => v,
    },
  });
  return {
    async tx(fn) {
      return db.transaction(async (t) =>
        fn({ query: async (text, params) => (await t.query(text, params as any[])).rows as any }),
      );
    },
    async exec(s) {
      try {
        await db.waitReady;
      } catch (e) {
        console.error("[pglite] init failed:", e, (e as any)?.cause);
        throw e;
      }
      await db.exec(s);
    },
  };
}

function makePostgres(): Driver {
  const sql = postgres(process.env.SUPABASE_DB_URL ?? LOCAL_URL, {
    max: dbMode === "supabase" ? 5 : 1,
    idle_timeout: dbMode === "supabase" ? undefined : 30,
    prepare: false, // required for Supabase transaction pooler
    types: {
      bigint: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
      numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
      date: { to: 1082, from: [1082], serialize: (x: unknown) => String(x), parse: (x: string) => x },
    },
  });
  return {
    async tx(fn) {
      return (await sql.begin(async (t) =>
        fn({ query: async (text, params) => (await t.unsafe(text, params as any[])) as any }),
      )) as any;
    },
    async exec(s) {
      await sql.unsafe(s);
    },
  };
}

async function migrate(driver: Driver) {
  if (dbMode === "local") {
    await driver.exec(fs.readFileSync(path.join(ROOT, "db", "local-shim.sql"), "utf8"));
  }
  await driver.exec(
    "create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const dir = path.join(ROOT, "supabase", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied = await driver.tx((q) => q.query<{ name: string }>("select name from public.schema_migrations"));
  const done = new Set(applied.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    await driver.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    await driver.tx((q) => q.query("insert into public.schema_migrations(name) values ($1)", [f]));
  }
}

function state() {
  if (!g.__margin) {
    const driver = dbMode === "supabase" || !process.env.PGLITE_DIR ? makePostgres() : makePglite();
    // Hosted databases are migrated explicitly (`npm run db:migrate`); local dev migrates itself.
    const ready = dbMode === "local" ? migrate(driver) : Promise.resolve();
    g.__margin = { driver, ready };
  }
  return g.__margin;
}

export async function migrateNow() {
  const driver = state().driver;
  await migrate(driver);
}

/* * Run queries as the authenticated end user: Postgres RLS is the tenant boundary. */
async function ready() {
  const s = state();
  try {
    await s.ready;
  } catch (e) {
    // A transient failure (database restarting, migration error) must not poison the process: retry on the next request.
    g.__margin = undefined;
    throw e;
  }
  return s;
}

export async function asUser<T>(userId: string, fn: (q: Q) => Promise<T>): Promise<T> {
  const s = await ready();
  return s.driver.tx(async (q) => {
    await q.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await q.query("set local role authenticated");
    return fn(q);
  });
}

/* * Privileged server-side access (sync jobs, webhooks, provisioning). Always scope by business_id explicitly. */
export async function asService<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  const s = await ready();
  return s.driver.tx(fn);
}
