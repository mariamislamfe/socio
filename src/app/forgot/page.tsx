"use client";
import Link from "next/link";
import { useState } from "react";
import { AuthShell } from "@/components/app/auth-shell";
import { Button, Field, Input } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";

export default function Page() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ devLink?: string; delivery: string } | null>(null);
  const [err, setErr] = useState("");
  return (
    <AuthShell
      title="Reset your password."
      subtitle={done ? undefined : "Enter your email and we will send a reset link."}
      footer={
        <Link href="/login" className="font-medium text-accent underline underline-offset-2">
          Back to sign in
        </Link>
      }
    >
      {done ? (
        <div className="space-y-4 text-[15px] text-ink2">
          {done.delivery === "email" ? (
            <p>
              If an account exists for <strong className="text-ink">{email}</strong>, a reset link is on its way.
            </p>
          ) : (
            <>
              <p className="rounded-xl bg-warnsoft px-3 py-2.5 text-sm text-warn">
                This server has no email service configured, so no email was sent. In local development the link is
                shown here instead.
              </p>
              {done.devLink ? (
                <Button href={done.devLink.replace(/^https?:\/\/[^/]+/, "")} variant="primary">
                  Open reset link
                </Button>
              ) : (
                <p>No account exists for that email.</p>
              )}
            </>
          )}
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr("");
            try {
              setDone(await api.post("/api/auth/forgot", { email }));
            } catch (x) {
              setErr(x instanceof ApiError ? x.message : "Could not reach the server.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {err && (
            <p role="alert" className="rounded-xl bg-negsoft px-3 py-2.5 text-sm text-neg">
              {err}
            </p>
          )}
          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
