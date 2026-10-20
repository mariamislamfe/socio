"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthShell } from "@/components/app/auth-shell";
import { Button, Field, Input } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";

function Form() {
  const sp = useSearchParams();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <AuthShell title="Choose a new password.">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr("");
          try {
            await api.post("/api/auth/reset", { password, token: sp.get("token") ?? undefined });
            router.replace("/login?reset=1");
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
        <Field label="New password" htmlFor="pw" hint="At least 8 characters.">
          <Input
            id="pw"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Update password
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
