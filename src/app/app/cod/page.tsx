"use client";
import { AlertTriangle, Check, Plus, Truck } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { useUi } from "@/components/providers";
import {
  Badge,
  Button,
  Card,
  clsx,
  ErrorNote,
  Field,
  Input,
  Modal,
  MoneyInput,
  PageHeader,
  Select,
  Skeleton,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll } from "@/lib/client/hooks";
import { COURIERS, type CodSummary } from "@/lib/finance/cod";
import { formatMoney } from "@/lib/finance/money";

interface Data {
  summary: CodSummary;
  today: string;
  currency: string;
  accounts: { id: string; name: string }[];
}

const addDays = (d: string, n: number) =>
  new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/* Money with couriers: cash on delivery that Bosta, Mylerz and others collected and haven't paid out yet. */
export default function CodPage() {
  const { data, error, mutate } = useSWR<Data>("/api/cod");
  const { locale, toast } = useUi();
  const A = locale === "ar";
  const L = (en: string, ar: string) => (A ? ar : en);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (!data) return <Skeleton className="h-96" />;
  const s = data.summary;
  const fm = (v: number) => formatMoney(v, data.currency);

  const received = async (id: string, amount: number) => {
    if (!data.accounts[0]) return toast({ title: L("Add an account first", "ضيف حساب الأول"), tone: "error" });
    setBusy(id);
    try {
      await api.post(`/api/invoices/${id}/payments`, { amount, paid_on: data.today, account_id: data.accounts[0].id });
      toast({
        title: L("Marked as received", "اتسجّل إنه وصل"),
        description: L(`Added to ${data.accounts[0].name}.`, `اتضاف على ${data.accounts[0].name}.`),
      });
      await mutate();
      refreshAll();
    } catch (x) {
      toast({
        title: L("Not saved", "ما اتحفظش"),
        description: x instanceof ApiError ? x.message : undefined,
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5" data-no-translate>
      <PageHeader
        title={L("Money with couriers", "فلوسك عند شركات الشحن")}
        subtitle={L(
          "Cash on delivery your couriers collected and haven't sent you yet. It counts in your forecast, and late payouts are flagged.",
          "فلوس الدفع عند الاستلام اللي شركات الشحن حصّلتها ولسه ما حوّلتهاش. بتتحسب في توقعاتك، والمتأخر بيظهر لوحده.",
        )}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden /> {L("Add a delivery batch", "ضيف شحنة")}
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-5">
          <p className="eyebrow">{L("Held by couriers", "عند شركات الشحن")}</p>
          <p className="display num mt-1 text-2xl">{fm(s.held)}</p>
        </Card>
        <Card className={clsx("p-5", s.late > 0 && "ring-2 ring-warn")}>
          <p className="eyebrow">{L("Late", "متأخر")}</p>
          <p className={clsx("display num mt-1 text-2xl", s.late > 0 && "text-warn")}>{fm(s.late)}</p>
        </Card>
        <Card className="p-5">
          <p className="eyebrow">{L("Next payout", "أقرب تحويل")}</p>
          <p className="display num mt-1 text-2xl">{s.nextPayout ? fm(s.nextPayout.amount) : "—"}</p>
          {s.nextPayout && (
            <p className="text-[12px] text-ink3">
              {s.nextPayout.courier} · {s.nextPayout.date}
            </p>
          )}
        </Card>
      </div>

      {s.worst && (
        <Card className="flex items-start gap-3 border-warn/40 bg-warn/5 p-5">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
          <div className="text-sm">
            <p className="font-semibold text-ink">
              {L(
                `${s.worst.courier} is late on ${fm(s.worst.late)}`,
                `${s.worst.courier} متأخرة في ${fm(s.worst.late)}`,
              )}
            </p>
            <p className="mt-1 text-ink2">
              {L(
                `The oldest payout is ${s.worst.oldestLateDays} days late. Call them, ask for the collection statement and the transfer date, and check the orders they marked as delivered.`,
                `أقدم تحويل متأخر ${s.worst.oldestLateDays} يوم. كلّمهم واطلب كشف التحصيل وميعاد التحويل، وراجع الأوردرات اللي مكتوب إنها اتسلّمت.`,
              )}
            </p>
          </div>
        </Card>
      )}

      <Card className="p-5 sm:p-6">
        <h2 className="display flex items-center gap-2 text-xl">
          <Truck className="size-5 text-accent" aria-hidden /> {L("By courier", "حسب شركة الشحن")}
        </h2>
        {s.couriers.length === 0 ? (
          <p className="mt-3 text-sm text-ink3">
            {L(
              "Nothing is waiting with couriers. Add a batch when a courier delivers your orders.",
              "مفيش فلوس مستنياك عند حد. ضيف شحنة لما شركة الشحن تسلّم أوردراتك.",
            )}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {s.couriers.map((c) => (
              <li key={c.courier} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="font-medium text-ink">{c.courier}</p>
                  <p className="text-[12px] text-ink3">
                    {L(`${c.orders} orders · fees ${fm(c.fees)}`, `${c.orders} أوردر · رسوم ${fm(c.fees)}`)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {c.late > 0 && <Badge tone="warn">{L(`${fm(c.late)} late`, `${fm(c.late)} متأخر`)}</Badge>}
                  <span className="num font-semibold">{fm(c.held)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {s.open.length > 0 && (
        <Card className="p-5 sm:p-6">
          <h2 className="display text-xl">{L("Payouts to expect", "تحويلات مستنياها")}</h2>
          <ul className="mt-3 divide-y divide-line">
            {s.open.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="text-sm font-medium text-ink">
                    {b.courier} · {L(`${b.orders} orders`, `${b.orders} أوردر`)}
                  </p>
                  <p className={clsx("text-[12px]", b.daysLate > 0 ? "text-warn" : "text-ink3")}>
                    {b.daysLate > 0
                      ? L(
                          `Expected ${b.expectedOn} · ${b.daysLate} days late`,
                          `كان المفروض ${b.expectedOn} · متأخر ${b.daysLate} يوم`,
                        )
                      : L(`Expected ${b.expectedOn}`, `متوقع ${b.expectedOn}`)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="num font-semibold">{fm(b.outstanding)}</span>
                  <Button size="sm" loading={busy === b.id} onClick={() => received(b.id, b.outstanding)}>
                    <Check className="size-4" aria-hidden /> {L("Received", "وصلت")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <AddBatch
        open={adding}
        onOpenChange={setAdding}
        data={data}
        L={L}
        onSaved={async () => {
          await mutate();
          refreshAll();
        }}
      />
    </div>
  );
}

function AddBatch({
  open,
  onOpenChange,
  data,
  L,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  data: Data;
  L: (en: string, ar: string) => string;
  onSaved: () => Promise<void>;
}) {
  const { toast } = useUi();
  const [courier, setCourier] = useState<string>("Bosta");
  const [collected, setCollected] = useState<number | null>(null);
  const [fees, setFees] = useState<number | null>(null);
  const [orders, setOrders] = useState("1");
  const [delivered, setDelivered] = useState(data.today);
  const [expected, setExpected] = useState(addDays(data.today, 7));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post("/api/cod", {
        courier,
        collected,
        fees: fees ?? 0,
        orders: Number(orders),
        delivered_on: delivered,
        expected_on: expected,
      });
      toast({
        title: L("Batch added", "الشحنة اتضافت"),
        description: L("It now counts in your forecast.", "بقت محسوبة في توقعاتك."),
      });
      onOpenChange(false);
      setCollected(null);
      setFees(null);
      setOrders("1");
      await onSaved();
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
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={L("Add a delivery batch", "ضيف شحنة")}
      description={L(
        "What the courier collected from your customers for these orders.",
        "اللي شركة الشحن حصّلته من زباينك في الأوردرات دي.",
      )}
      footer={
        <Button variant="primary" onClick={save} loading={busy} disabled={!collected || !orders}>
          {L("Add", "ضيف")}
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={L("Courier", "شركة الشحن")}>
          <Select value={courier} onChange={(e) => setCourier(e.target.value)}>
            {COURIERS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={L("Orders delivered", "عدد الأوردرات")}>
          <Input inputMode="numeric" value={orders} onChange={(e) => setOrders(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <Field label={L("Collected from customers", "اللي اتحصّل من الزباين")}>
          <MoneyInput value={collected} onChange={setCollected} currency={data.currency} />
        </Field>
        <Field
          label={L("Courier fees", "رسوم الشحن")}
          hint={L("Deducted before they pay you", "بتتخصم قبل ما يحوّلولك")}
        >
          <MoneyInput value={fees} onChange={setFees} currency={data.currency} />
        </Field>
        <Field label={L("Delivered on", "اتسلّمت يوم")}>
          <Input type="date" value={delivered} onChange={(e) => setDelivered(e.target.value)} />
        </Field>
        <Field label={L("Payout expected on", "التحويل متوقع يوم")}>
          <Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
