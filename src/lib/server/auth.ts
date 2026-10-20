import "server-only";
import { cookies, headers } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { asService } from "./db";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto";

export interface AuthUser {
  id: string;
  email: string;
}

export type AuthMode = "supabase" | "local";
export const authMode: AuthMode =
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_DB_URL
    ? "supabase"
    : "local";

const SESSION_COOKIE = "margin_session";
const SESSION_DAYS = 30;

export class AuthError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "auth_error",
  ) {
    super(message);
  }
}

// Supabase mode

async function supabase() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (all) => {
        try {
          for (const c of all) store.set(c.name, c.value, c.options);
        } catch {
          /* called from a Server Component: refresh handled by route handlers */
        }
      },
    },
  });
}

// shared

async function ensureProfile(u: AuthUser, name?: string) {
  await asService((q) =>
    q.query(
      `insert into public.profiles(id, email, name) values ($1,$2,$3)
       on conflict (id) do update set email = excluded.email`,
      [u.id, u.email, name ?? ""],
    ),
  );
}

export async function currentUser(): Promise<AuthUser | null> {
  if (authMode === "supabase") {
    const { data } = await (await supabase()).auth.getUser();
    if (!data.user?.email) return null;
    const u = { id: data.user.id, email: data.user.email };
    return u;
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await asService((q) =>
    q.query<{ id: string; email: string }>(
      `select u.id, u.email from auth.local_sessions s join auth.users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now()`,
      [sha256(token)],
    ),
  );
  return rows[0] ?? null;
}

async function startLocalSession(userId: string) {
  const token = randomToken();
  await asService((q) =>
    q.query(
      `insert into auth.local_sessions(token_hash, user_id, expires_at) values ($1,$2, now() + interval '${SESSION_DAYS} days')`,
      [sha256(token), userId],
    ),
  );
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

// Basic per-process throttle against password guessing.
const attempts = new Map<string, { n: number; until: number }>();
function throttle(key: string) {
  const a = attempts.get(key);
  if (a && a.until > Date.now() && a.n >= 8)
    throw new AuthError("Too many attempts. Please wait a few minutes and try again.", 429, "rate_limited");
}
function fail(key: string) {
  const a = attempts.get(key);
  attempts.set(key, { n: (a && a.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 10 * 60_000 });
}

export async function signUp(email: string, password: string, name: string): Promise<{ needsConfirmation: boolean }> {
  email = email.trim().toLowerCase();
  if (password.length < 8) throw new AuthError("Password must be at least 8 characters.", 422, "weak_password");
  if (authMode === "supabase") {
    const sb = await supabase();
    const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name } } });
    if (error) throw new AuthError(error.message, 400, "signup_failed");
    if (!data.user) throw new AuthError("Sign-up did not return a user.", 500);
    await ensureProfile({ id: data.user.id, email }, name);
    return { needsConfirmation: !data.session };
  }
  const exists = await asService((q) => q.query("select 1 from auth.users where email = $1", [email]));
  if (exists.length) throw new AuthError("An account with this email already exists.", 409, "email_taken");
  const rows = await asService((q) =>
    q.query<{ id: string }>("insert into auth.users(email, encrypted_password) values ($1,$2) returning id", [
      email,
      hashPassword(password),
    ]),
  );
  await ensureProfile({ id: rows[0].id, email }, name);
  await startLocalSession(rows[0].id);
  return { needsConfirmation: false };
}

export async function signIn(email: string, password: string): Promise<void> {
  email = email.trim().toLowerCase();
  const ip = (await headers()).get("x-forwarded-for") ?? "local";
  const key = `${email}|${ip}`;
  throttle(key);
  if (authMode === "supabase") {
    const { data, error } = await (await supabase()).auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      fail(key);
      throw new AuthError("Incorrect email or password.", 401, "invalid_credentials");
    }
    await ensureProfile({ id: data.user.id, email });
    return;
  }
  const rows = await asService((q) =>
    q.query<{ id: string; encrypted_password: string }>(
      "select id, encrypted_password from auth.users where email = $1",
      [email],
    ),
  );
  const ok = rows[0] && rows[0].encrypted_password && verifyPassword(password, rows[0].encrypted_password);
  if (!ok) {
    fail(key);
    throw new AuthError("Incorrect email or password.", 401, "invalid_credentials");
  }
  await startLocalSession(rows[0].id);
}

export async function signOut(): Promise<void> {
  if (authMode === "supabase") {
    await (await supabase()).auth.signOut();
  } else {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token)
      await asService((q) => q.query("delete from auth.local_sessions where token_hash = $1", [sha256(token)]));
    store.delete(SESSION_COOKIE);
  }
  (await cookies()).delete("margin_biz");
}

/* * Returns a reset link only in local development, where no email service exists. */
export async function requestPasswordReset(email: string, origin: string): Promise<{ devLink?: string }> {
  email = email.trim().toLowerCase();
  if (authMode === "supabase") {
    await (await supabase()).auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/callback?next=/reset` });
    return {};
  }
  const rows = await asService((q) => q.query<{ id: string }>("select id from auth.users where email = $1", [email]));
  if (!rows[0]) return {};
  const token = randomToken();
  await asService((q) =>
    q.query(
      "insert into auth.local_resets(token_hash, user_id, expires_at) values ($1,$2, now() + interval '30 minutes')",
      [sha256(token), rows[0].id],
    ),
  );
  return { devLink: `${origin}/reset?token=${token}` };
}

export async function resetPassword(password: string, token?: string): Promise<void> {
  if (password.length < 8) throw new AuthError("Password must be at least 8 characters.", 422, "weak_password");
  if (authMode === "supabase") {
    const { error } = await (await supabase()).auth.updateUser({ password });
    if (error) throw new AuthError(error.message, 400, "reset_failed");
    return;
  }
  if (!token) throw new AuthError("Reset link is invalid or expired.", 400, "invalid_token");
  const rows = await asService((q) =>
    q.query<{ user_id: string }>(
      "update auth.local_resets set used = true where token_hash = $1 and used = false and expires_at > now() returning user_id",
      [sha256(token)],
    ),
  );
  if (!rows[0]) throw new AuthError("Reset link is invalid or expired.", 400, "invalid_token");
  await asService(async (q) => {
    await q.query("update auth.users set encrypted_password = $1 where id = $2", [
      hashPassword(password),
      rows[0].user_id,
    ]);
    await q.query("delete from auth.local_sessions where user_id = $1", [rows[0].user_id]);
  });
}

export async function exchangeCode(code: string): Promise<boolean> {
  if (authMode !== "supabase") return false;
  const { error } = await (await supabase()).auth.exchangeCodeForSession(code);
  return !error;
}

export async function changePassword(userId: string, email: string, current: string, next: string): Promise<void> {
  if (next.length < 8) throw new AuthError("Password must be at least 8 characters.", 422, "weak_password");
  if (authMode === "supabase") {
    const sb = await supabase();
    const { error: e1 } = await sb.auth.signInWithPassword({ email, password: current });
    if (e1) throw new AuthError("Current password is incorrect.", 401, "invalid_credentials");
    const { error } = await sb.auth.updateUser({ password: next });
    if (error) throw new AuthError(error.message, 400);
    return;
  }
  const rows = await asService((q) =>
    q.query<{ encrypted_password: string }>("select encrypted_password from auth.users where id = $1", [userId]),
  );
  if (!rows[0] || !verifyPassword(current, rows[0].encrypted_password))
    throw new AuthError("Current password is incorrect.", 401, "invalid_credentials");
  await asService((q) =>
    q.query("update auth.users set encrypted_password = $1 where id = $2", [hashPassword(next), userId]),
  );
}

/* * Permanently removes the account and every workspace it exclusively owns. */
export async function deleteAccount(userId: string): Promise<void> {
  await asService(async (q) => {
    const owned = await q.query<{ business_id: string }>(
      `select m.business_id from memberships m where m.user_id = $1 and m.role = 'owner'
       and not exists (select 1 from memberships o where o.business_id = m.business_id and o.user_id <> $1)`,
      [userId],
    );
    for (const b of owned) await q.query("delete from businesses where id = $1", [b.business_id]);
    await q.query("delete from profiles where id = $1", [userId]);
  });
  if (authMode === "local") {
    await asService((q) => q.query("delete from auth.users where id = $1", [userId]));
  } else {
    // Removing the auth user requires the service-role key. We deliberately keep it out of the app; sign the user out
    // and leave the Supabase Auth record for the project owner to purge, which is stated in the UI.
  }
  await signOut();
}
