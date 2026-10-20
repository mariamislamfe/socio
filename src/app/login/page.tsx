"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthShell } from "@/components/app/auth-shell";
import { Button, Field, Input } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll } from "@/lib/client/hooks";

function Form() {
  const router = useRouter();
  const sp = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<{ form?: string; fields?: Record<string, string> }>({});
  const [busy, setBusy] = useState(false);
  return (
    <AuthShell
      title="Welcome back."
      subtitle="Sign in to see where your business stands."
      footer={
        <>
          New to Socio?{" "}
          <Link href="/register" className="font-medium text-accent underline underline-offset-2">
            Create an account
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
            await api.post("/api/auth/login", { email, password });
            await refreshAll();
            const next = sp.get("next");
            router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/app");
          } catch (x) {
            if (x instanceof ApiError) setErr({ form: x.fields ? undefined : x.message, fields: x.fields });
            else setErr({ form: "Could not reach the server. Check your connection." });
          } finally {
            setBusy(false);
          }
        }}
      >
        {sp.get("reset") && (
          <p className="rounded-xl bg-possoft px-3 py-2.5 text-sm text-pos">
            Password updated. Sign in with your new password.
          </p>
        )}
        {err.form && (
          <p role="alert" className="rounded-xl bg-negsoft px-3 py-2.5 text-sm text-neg">
            {err.form}
          </p>
        )}
        <Field label="Email" htmlFor="email" error={err.fields?.email}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            invalid={!!err.fields?.email}
          />
        </Field>
        <Field label="Password" htmlFor="password" error={err.fields?.password}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            invalid={!!err.fields?.password}
          />
        </Field>
        <div className="flex justify-end">
          <Link href="/forgot" className="text-[13px] text-ink2 underline underline-offset-2">
            Forgot your password?
          </Link>
        </div>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Form />
    </Suspense>
  );
}
