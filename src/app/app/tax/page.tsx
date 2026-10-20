"use client";
import { CheckCircle2, Circle, CircleDashed, CircleHelp, Info, Loader } from "lucide-react";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { useUi } from "@/components/providers";
import { Badge, Button, Card, clsx, ErrorNote, PageHeader, Segmented, Skeleton } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll } from "@/lib/client/hooks";
import { ANSWER_LABEL, type Answer, type TaxChecklist, type TaxProfile, type StepStatus } from "@/lib/finance/taxsetup";

interface Data {
  profile: TaxProfile | null;
  questions: { key: keyof Omit<TaxProfile, "updatedAt">; en: string; ar: string; options: Answer[] }[];
  checklist: TaxChecklist;
}

const STATUS: Record<StepStatus, { en: string; ar: string; tone: "pos" | "warn" | "neutral" | "info" }> = {
  done: { en: "Done", ar: "خلصت", tone: "pos" },
  in_progress: { en: "In progress", ar: "شغّال فيها", tone: "info" },
  todo: { en: "To do", ar: "لسه", tone: "warn" },
  check: { en: "Check", ar: "اتأكد", tone: "warn" },
  not_needed: { en: "Not needed yet", ar: "مش محتاجها دلوقتي", tone: "neutral" },
};

/* Taxes & papers: no tax is estimated until the owner tells us where their registration stands. */
export default function TaxPage() {
  const { data, error, mutate } = useSWR<Data>("/api/tax-setup");
  const { locale, toast } = useUi();
  const A = locale === "ar";
  const L = (en: string, ar: string) => (A ? ar : en);
  const [answers, setAnswers] = useState<Partial<Record<keyof Omit<TaxProfile, "updatedAt">, Answer>>>({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data?.profile) setAnswers(data.profile);
  }, [data?.profile]);
  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (!data) return <Skeleton className="h-96" />;
  const c = data.checklist;
  const asking = !data.profile || editing;
  const complete = data.questions.every((q) => answers[q.key]);

  const save = async () => {
    setBusy(true);
    try {
      await api.post("/api/tax-setup", answers);
      toast({ title: L("Saved", "اتحفظ"), description: L("Your checklist is updated.", "قايمة خطواتك اتحدّثت.") });
      setEditing(false);
      await mutate();
      refreshAll();
    } catch (x) {
      toast({
        title: L("Not saved", "ما اتحفظش"),
        description: x instanceof ApiError ? x.message : undefined,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5" data-no-translate>
      <PageHeader
        title={L("Taxes & papers", "الضرايب والأوراق")}
        subtitle={L(
          "Tell us where your registration stands. Socio won't estimate any tax until then, and it will tell you exactly what to do next.",
          "قولّنا أوراقك وصلت لفين. Socio مش هيحسب أي ضرايب قبل كده، وهيقولك بالظبط تعمل إيه بعدها.",
        )}
      />

      {asking ? (
        <Card className="p-5 sm:p-6">
          <h2 className="display text-xl">{L("Six quick questions", "6 أسئلة سريعة")}</h2>
          <p className="mt-1 text-[13px] text-ink3">
            {L(
              "Answer what you know. “Not sure” is fine: we'll add a step to check it.",
              "جاوب اللي تعرفه. «مش متأكد» عادي، هنضيفلك خطوة تتأكد منها.",
            )}
          </p>
          <div className="mt-5 space-y-4">
            {data.questions.map((q) => (
              <div key={q.key} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm font-medium text-ink">{A ? q.ar : q.en}</p>
                <Segmented<Answer>
                  label={A ? q.ar : q.en}
                  value={answers[q.key] ?? ("" as Answer)}
                  onChange={(v) => setAnswers({ ...answers, [q.key]: v })}
                  options={q.options.map((o) => ({ value: o, label: A ? ANSWER_LABEL[o].ar : ANSWER_LABEL[o].en }))}
                />
              </div>
            ))}
          </div>
          <div className="mt-6 flex gap-2">
            <Button variant="primary" onClick={save} loading={busy} disabled={!complete}>
              {L("Show my next steps", "وريني الخطوات")}
            </Button>
            {data.profile && (
              <Button
                onClick={() => {
                  setEditing(false);
                  setAnswers(data.profile!);
                }}
              >
                {L("Cancel", "إلغاء")}
              </Button>
            )}
          </div>
        </Card>
      ) : (
        <>
          <Card className="p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="eyebrow">{L("Your progress", "وصلت لفين")}</p>
                <p className="display mt-1 text-2xl">
                  <span className="num">{c.progress.done}</span> / <span className="num">{c.progress.total}</span>{" "}
                  {L("steps done", "خطوات خلصت")}
                </p>
                {c.next && (
                  <p className="mt-2 text-sm text-ink2">
                    {L("Next:", "الخطوة الجاية:")} <b>{A ? c.next.title.ar : c.next.title.en}</b>
                  </p>
                )}
                {!c.next && (
                  <p className="mt-2 text-sm text-ink2">
                    {L("Everything is in order, based on your answers.", "كله تمام حسب إجاباتك.")}
                  </p>
                )}
              </div>
              <Button onClick={() => setEditing(true)}>{L("Update my answers", "عدّل إجاباتي")}</Button>
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-sunken">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${c.progress.total ? (c.progress.done / c.progress.total) * 100 : 0}%` }}
              />
            </div>
          </Card>

          <ol className="space-y-3">
            {c.steps.map((s) => {
              const Icon =
                s.status === "done"
                  ? CheckCircle2
                  : s.status === "in_progress"
                    ? Loader
                    : s.status === "check"
                      ? CircleHelp
                      : s.status === "not_needed"
                        ? CircleDashed
                        : Circle;
              return (
                <li key={s.id}>
                  <Card
                    className={clsx("p-5", s.next && "ring-2 ring-accent", s.status === "not_needed" && "opacity-70")}
                  >
                    <div className="flex items-start gap-3">
                      <Icon
                        className={clsx(
                          "mt-0.5 size-5 shrink-0",
                          s.status === "done" ? "text-pos" : s.next ? "text-accent" : "text-ink3",
                        )}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-semibold text-ink">{A ? s.title.ar : s.title.en}</h3>
                          <Badge tone={STATUS[s.status].tone}>{A ? STATUS[s.status].ar : STATUS[s.status].en}</Badge>
                          {s.next && <Badge tone="accent">{L("Start here", "ابدأ هنا")}</Badge>}
                        </div>
                        <p className="mt-1 text-[13px] text-ink2">{A ? s.why.ar : s.why.en}</p>
                        {s.status !== "done" && s.status !== "not_needed" && (
                          <ol className="mt-3 list-decimal space-y-1 ps-5 text-[13px] text-ink">
                            {(A ? s.how.ar : s.how.en).map((h, i) => (
                              <li key={i}>{h}</li>
                            ))}
                          </ol>
                        )}
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ol>
        </>
      )}

      <p className="flex items-start gap-1.5 text-xs text-ink3">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {L(
          "General guidance for small businesses in Egypt, not legal advice. Rules and thresholds change: confirm with the Egyptian Tax Authority or an accountant.",
          "دي إرشادات عامة للمشروعات الصغيرة في مصر، مش استشارة قانونية. القواعد والحدود بتتغير، فاتأكد من مصلحة الضرائب أو محاسب.",
        )}
      </p>
    </div>
  );
}
