"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthShell } from "@/components/app/auth-shell";
import { Button, Field, Input } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll } from "@/lib/client/hooks";

export default function Page() {
  const router = useRouter();
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const [err, setErr] = useState<{ form?: string; fields?: Record<string, string> }>({});
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (confirm)
    return (
      <AuthShell
        title="Check your email."
        subtitle={`We sent a confirmation link to ${f.email}. Open it to finish creating your account, then sign in.`}
      >
        <Button href="/login" variant="secondary">
          Back to sign in
        </Button>
      </AuthShell>
    );
  return (
    <AuthShell
      title="Start with clarity."
      subtitle="Create your account. Setting up a business takes about two minutes."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-accent underline underline-offset-2">
            Sign in
          </Link>
        </>
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr({});
          try {
            const r = await api.post<{ needsConfirmation: boolean }>("/api/auth/register", f);
            if (r.needsConfirmation) return setConfirm(true);
            await refreshAll();
            router.replace("/onboarding");
          } catch (x) {
            if (x instanceof ApiError) setErr({ form: x.fields ? undefined : x.message, fields: x.fields });
            else setErr({ form: "Could not reach the server. Check your connection." });
          } finally {
            setBusy(false);
          }
        }}
      >
        {err.form && (
          <p role="alert" className="rounded-xl bg-negsoft px-3 py-2.5 text-sm text-neg">
            {err.form}
          </p>
        )}
        <Field label="Your name" htmlFor="name" error={err.fields?.name}>
          <Input
            id="name"
            autoComplete="name"
            required
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            invalid={!!err.fields?.name}
          />
        </Field>
        <Field label="Email" htmlFor="email" error={err.fields?.email}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
            invalid={!!err.fields?.email}
          />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters." error={err.fields?.password}>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            value={f.password}
            onChange={(e) => setF({ ...f, password: e.target.value })}
            invalid={!!err.fields?.password}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
