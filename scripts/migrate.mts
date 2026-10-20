/* Applies supabase/migrations/*.sql to SUPABASE_DB_URL (or the local dev database). */
import { migrateNow } from "../src/lib/server/db";

await migrateNow();
console.log("Migrations applied.");
process.exit(0);
