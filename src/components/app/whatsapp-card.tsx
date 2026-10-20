"use client";
import { CheckCheck, MessageCircle, Send } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { useUi } from "@/components/providers";
import { Badge, Button, Card, clsx, Field, Input, Segmented, Skeleton } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";

interface Data {
  configured: boolean;
  missingEnv: string[];
  template: string;
  templateText: { en: string; ar: string };
  settings: { optIn: boolean; lang: "en" | "ar"; phone: string | null };
  preview: { en: string; ar: string };
  deliveries: { kind: string; to_masked: string; status: string; error: string | null; created_at: string }[];
}

export function WhatsAppCard({ compact }: { compact?: boolean }) {
  const { data, mutate } = useSWR<Data>("/api/whatsapp");
  const { toast } = useUi();
  const [phone, setPhone] = useState("");
  const [lang, setLang] = useState<"en" | "ar">("ar");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (data) setLang(data.settings.lang);
  }, [data]);
  if (!data) return <Skeleton className="h-72" />;
  const on = data.settings.optIn;

  const save = async (optIn: boolean) => {
    setBusy("save");
    setErr("");
    try {
      await api.patch("/api/whatsapp", { optIn, lang, ...(phone ? { phone } : {}) });
      setPhone("");
      await mutate();
      toast({
        title: optIn ? "Morning briefing on WhatsApp is on" : "WhatsApp briefing turned off",
        description: optIn ? "You'll get it once a day after 7:00 in your business time zone." : undefined,
      });
    } catch (x) {
      setErr(x instanceof ApiError ? (x.fields?.phone ?? x.message) : "Could not save.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="grid gap-6 p-5 sm:p-6 md:grid-cols-[1fr_300px]">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="grid size-9 place-items-center rounded-xl bg-[#25D366]/15 text-[#128C7E]">
              <MessageCircle className="size-5" aria-hidden />
            </span>
            <h3 className="text-[16px] font-semibold text-ink">Morning briefing on WhatsApp</h3>
            <Badge tone={on ? "pos" : "neutral"}>{on ? "On" : "Off"}</Badge>
            {!data.configured && <Badge tone="warn">Server setup required</Badge>}
          </div>
          <p className="mt-2 text-[14px] text-ink2">
            Every morning: how many things need you, the cash you really have, and the one thing to do first — on the
            app you already open fifty times a day. Only to your own number, only if you turn it on.
          </p>
          {!compact && (
            <div className="mt-4 space-y-3">
              <Field
                label="Your WhatsApp number"
                hint={
                  data.settings.phone ? `Saved: ${data.settings.phone}` : "International format, e.g. +201001234567"
                }
                error={err}
              >
                <Input
                  inputMode="tel"
                  dir="ltr"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder={data.settings.phone ?? "+20…"}
                />
              </Field>
              <Field label="Language">
                <Segmented
                  value={lang}
                  onChange={setLang}
                  options={[
                    { value: "ar", label: "العربية" },
                    { value: "en", label: "English" },
                  ]}
                  label="Language"
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" loading={busy === "save"} onClick={() => save(true)}>
                  {on ? "Save" : "Turn on"}
                </Button>
                {on && (
                  <Button variant="ghost" onClick={() => save(false)}>
                    Turn off
                  </Button>
                )}
                {on && (
                  <Button
                    variant="ghost"
                    loading={busy === "test"}
                    onClick={async () => {
                      setBusy("test");
                      try {
                        const r = await api.post<{ status: string; error?: string | null }>("/api/whatsapp/test");
                        toast({
                          title:
                            r.status === "sent"
                              ? "Sent to WhatsApp"
                              : r.status === "skipped"
                                ? "Not sent"
                                : "Sending failed",
                          description: r.error ?? undefined,
                          tone: r.status === "sent" ? "success" : "warning",
                        });
                        mutate();
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    <Send className="size-4" aria-hidden /> Send me today&apos;s now
                  </Button>
                )}
              </div>
              {!data.configured && (
                <p className="rounded-xl bg-sunken px-3.5 py-2.5 text-[13px] text-ink2">
                  To deliver for real, the server needs a WhatsApp Business number: set{" "}
                  <code className="font-mono text-[12px]">{data.missingEnv.join(", ")}</code> and get a template named{" "}
                  <code className="font-mono text-[12px]">{data.template}</code> approved in WhatsApp Manager. Until
                  then nothing is sent and nothing is claimed — the preview shows exactly what you would receive.
                </p>
              )}
              {data.deliveries.length > 0 && (
                <ul className="divide-y divide-line rounded-xl border border-line text-[13px]">
                  {data.deliveries.slice(0, 4).map((d, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <span className="text-ink2">{new Date(d.created_at).toLocaleString()}</span>
                      <span className="text-ink3">to {d.to_masked}</span>
                      <span className="flex-1" />
                      <Badge tone={d.status === "sent" ? "pos" : d.status === "failed" ? "neg" : "neutral"}>
                        {d.status}
                      </Badge>
                      {d.error && <span className="w-full text-xs text-ink3">{d.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <PhonePreview text={data.preview[lang]} rtl={lang === "ar"} />
      </div>
      {!compact && <RecordByMessage on={on} />}
    </Card>
  );
}

const EXAMPLES = ["دفعت 500 شحن", "بعت ب 1200", "صرفت 2 ألف إعلانات", "الرصيد", "الغي"];

function RecordByMessage({ on }: { on: boolean }) {
  const [chat, setChat] = useState<{ me: boolean; text: string }[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (t: string) => {
    const msg = t.trim();
    if (!msg || busy) return;
    setText("");
    setChat((c) => [...c, { me: true, text: msg }]);
    setBusy(true);
    try {
      const r = await api.post<{ reply: string }>("/api/whatsapp/simulate", { text: msg });
      setChat((c) => [...c, { me: false, text: r.reply }]);
    } catch (x) {
      setChat((c) => [...c, { me: false, text: x instanceof ApiError ? x.message : "Something went wrong." }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-6 border-t border-line bg-sunken/40 p-5 sm:p-6 md:grid-cols-[1fr_300px]">
      <div>
        <h3 className="text-[16px] font-semibold text-ink">Record money with a message</h3>
        <p className="mt-1 text-[14px] text-ink2">
          Send “دفعت 500 شحن” or “بعت ب 1200” to the business number and it is recorded instantly, in the right
          category, with a confirmation. “الغي” undoes the last one. No AI guesses: the same message always records the
          same thing, and only messages from your own number are accepted
          {on ? "" : " (turn the briefing on above to enable it)"}.
        </p>
        <p className="mt-3 text-[13px] font-medium text-ink">Try it here — it records for real in this workspace:</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              dir="rtl"
              onClick={() => send(e)}
              className="rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] text-ink2 hover:border-accent hover:text-ink"
            >
              {e}
            </button>
          ))}
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <Input
            dir="auto"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="اكتبي رسالة… / type a message"
            aria-label="Message"
          />
          <Button type="submit" variant="primary" loading={busy} aria-label="Send">
            <Send className="size-4" aria-hidden />
          </Button>
        </form>
      </div>
      <div className="mx-auto flex h-[360px] w-full max-w-[300px] flex-col rounded-[2rem] border-[6px] border-ink/85 bg-[#efe7dd] p-3 shadow-xl dark:bg-[#0b141a]">
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-[#075E54] px-3 py-2 text-white">
          <span className="grid size-7 place-items-center rounded-full bg-white/20 text-[11px] font-semibold">AI</span>
          <p className="text-[13px] font-semibold">Your finance co-pilot</p>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto pe-1">
          {chat.length === 0 && <p className="mt-10 text-center text-[12px] text-[#667781]">Tap an example to start</p>}
          {chat.map((m, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              dir="auto"
              className={clsx(
                "max-w-[88%] whitespace-pre-line rounded-xl px-3 py-1.5 text-[13px] shadow-sm",
                m.me
                  ? "ms-auto bg-[#d9fdd3] text-[#111b21] dark:bg-[#005c4b] dark:text-white"
                  : "bg-white text-[#111b21] dark:bg-[#202c33] dark:text-[#e9edef]",
              )}
            >
              {m.text}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PhonePreview({ text, rtl }: { text: string; rtl: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-[2rem] border-[6px] border-ink/85 bg-[#efe7dd] p-3 shadow-xl dark:bg-[#0b141a]">
      <div className="mb-3 flex items-center gap-2 rounded-xl bg-[#075E54] px-3 py-2 text-white">
        <span className="grid size-7 place-items-center rounded-full bg-white/20 text-[11px] font-semibold">AI</span>
        <div className="leading-tight">
          <p className="text-[13px] font-semibold">Your finance co-pilot</p>
          <p className="text-[10px] opacity-80">business account</p>
        </div>
      </div>
      <motion.div
        key={text}
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 22 }}
        dir={rtl ? "rtl" : "ltr"}
        className={clsx(
          "relative max-w-[92%] whitespace-pre-line rounded-xl bg-white px-3 py-2 text-[13px] leading-relaxed text-[#111b21] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]",
          rtl ? "ms-auto rounded-se-sm" : "rounded-ss-sm",
        )}
      >
        {text}
        <span className="mt-1 flex items-center justify-end gap-1 text-[10px] text-[#667781]">
          07:00 <CheckCheck className="size-3.5 text-[#53bdeb]" aria-hidden />
        </span>
      </motion.div>
    </div>
  );
}
