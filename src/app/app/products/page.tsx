"use client";
import { Package, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { useUi } from "@/components/providers";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  Input,
  Modal,
  MoneyInput,
  PageHeader,
  Skeleton,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useMe } from "@/lib/client/hooks";
import { currencyDigits, formatMoney, toMinor } from "@/lib/finance/money";

interface P {
  id: string;
  name: string;
  sku: string | null;
  price: number | null;
  unit_cost: number | null;
  stock: number | null;
  source: string;
}

export default function ProductsPage() {
  const { biz } = useMe();
  const cur = biz?.currency.trim() ?? "EGP";
  const digits = currencyDigits(cur);
  const { toast } = useUi();
  const { data, error, isLoading, mutate } = useSWR<{ items: P[] }>("/api/products");
  const [modal, setModal] = useState(false);
  const [del, setDel] = useState<P | null>(null);
  const canWrite = biz && biz.role !== "viewer";
  const items = data?.items ?? [];
  const missing = items.filter((p) => p.unit_cost === null).length;

  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Products & costs"
        subtitle="Profit is only as good as your costs. Add what each product costs you and Socio can estimate margin on every sale it knows about."
        actions={
          <Button variant="primary" disabled={!canWrite} onClick={() => setModal(true)}>
            <Plus className="size-4" aria-hidden /> Add product
          </Button>
        }
      />
      {missing > 0 && items.length > 0 && (
        <p className="rounded-2xl border border-warn/30 bg-warnsoft px-4 py-3 text-sm text-ink">
          {missing} of {items.length} products have no unit cost. Their margin cannot be estimated, and imported orders
          containing them are flagged.
        </p>
      )}
      {isLoading && !data ? (
        <Skeleton className="h-64" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Package className="size-6" />}
          title="No products yet"
          body="Add products manually, or connect Shopify to import your catalogue and unit costs."
          action={
            <>
              <Button variant="primary" onClick={() => setModal(true)}>
                Add a product
              </Button>
              <Button href="/app/settings/integrations">Connect Shopify</Button>
            </>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[38rem] text-sm">
              <thead>
                <tr>
                  <th className="eyebrow px-5 py-3 text-start font-normal">Product</th>
                  <th className="eyebrow px-3 py-3 text-end font-normal">Price</th>
                  <th className="eyebrow px-3 py-3 text-end font-normal">Unit cost</th>
                  <th className="eyebrow px-3 py-3 text-end font-normal">Margin</th>
                  <th className="eyebrow px-3 py-3 text-end font-normal">Stock</th>
                  <th className="w-12" />
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <ProductRow
                    key={p.id}
                    p={p}
                    cur={cur}
                    digits={digits}
                    canWrite={!!canWrite}
                    onDelete={() => setDel(p)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <ProductModal open={modal} onClose={() => setModal(false)} cur={cur} digits={digits} />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title="Delete this product?"
        body="Past transactions are not changed."
        onConfirm={async () => {
          await api.del(`/api/products/${del!.id}`);
          await refreshAll();
          toast({ title: "Product deleted" });
        }}
      />
    </div>
  );
}

function ProductRow({
  p,
  cur,
  digits,
  canWrite,
  onDelete,
}: {
  p: P;
  cur: string;
  digits: number;
  canWrite: boolean;
  onDelete: () => void;
}) {
  const [cost, setCost] = useState(p.unit_cost === null ? "" : String(p.unit_cost / 10 ** digits));
  useEffect(() => setCost(p.unit_cost === null ? "" : String(p.unit_cost / 10 ** digits)), [p.unit_cost, digits]);
  const margin = p.price && p.unit_cost !== null && p.price > 0 ? (p.price - p.unit_cost) / p.price : null;
  const save = async () => {
    const v = cost.trim() === "" ? null : toMinor(cost, cur);
    if (v === p.unit_cost || (cost.trim() !== "" && v === null)) return;
    await api.patch(`/api/products/${p.id}`, { unit_cost: v });
    await refreshAll();
  };
  return (
    <tr className="border-t border-line">
      <td className="px-5 py-3">
        <span className="font-medium text-ink">{p.name}</span>
        <span className="ms-2 text-xs text-ink3">{p.sku}</span>
        {p.source !== "manual" && (
          <Badge tone="info" className="ms-2">
            {p.source}
          </Badge>
        )}
      </td>
      <td className="num px-3 py-3 text-end">{p.price !== null ? formatMoney(p.price, cur) : "—"}</td>
      <td className="px-3 py-3 text-end">
        <input
          aria-label={`Unit cost for ${p.name}`}
          inputMode="decimal"
          disabled={!canWrite}
          value={cost}
          placeholder="Add cost"
          onChange={(e) => setCost(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="num h-9 w-28 rounded-lg border border-line bg-raised px-2.5 text-end text-sm placeholder:text-warn focus:border-accent focus:outline-none"
        />
      </td>
      <td className="num px-3 py-3 text-end">
        {margin !== null ? (
          <span className={margin < 0.2 ? "text-warn" : "text-ink"}>{Math.round(margin * 100)}%</span>
        ) : (
          <span className="text-ink3">—</span>
        )}
      </td>
      <td className="num px-3 py-3 text-end text-ink2">{p.stock ?? "—"}</td>
      <td className="px-2 py-3">
        {canWrite && (
          <IconButton label={`Delete ${p.name}`} onClick={onDelete}>
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </td>
    </tr>
  );
}

function ProductModal({
  open,
  onClose,
  cur,
  digits,
}: {
  open: boolean;
  onClose: () => void;
  cur: string;
  digits: number;
}) {
  const { toast } = useUi();
  const [f, setF] = useState({
    name: "",
    sku: "",
    price: null as number | null,
    cost: null as number | null,
    stock: "",
  });
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setF({ name: "", sku: "", price: null, cost: null, stock: "" });
      setErr({});
    }
  }, [open]);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add a product"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("/api/products", {
                  name: f.name,
                  sku: f.sku || undefined,
                  price: f.price,
                  unit_cost: f.cost,
                  stock: f.stock === "" ? null : Number(f.stock),
                });
                await refreshAll();
                toast({ title: "Product added" });
                onClose();
              } catch (x) {
                setErr(x instanceof ApiError ? { ...(x.fields ?? {}), _: x.message } : { _: "Could not save." });
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {err._ && !err.name && (
          <p role="alert" className="rounded-xl bg-negsoft px-3 py-2 text-sm text-neg">
            {err._}
          </p>
        )}
        <Field label="Name" error={err.name} htmlFor="pr-n">
          <Input id="pr-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} invalid={!!err.name} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="SKU (optional)" htmlFor="pr-s">
            <Input id="pr-s" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} />
          </Field>
          <Field label="Stock (optional)" htmlFor="pr-st">
            <Input
              id="pr-st"
              type="number"
              min={0}
              value={f.stock}
              onChange={(e) => setF({ ...f, stock: e.target.value })}
            />
          </Field>
          <Field label="Selling price" htmlFor="pr-p">
            <MoneyInput
              id="pr-p"
              value={f.price}
              onChange={(v) => setF({ ...f, price: v })}
              currency={cur}
              digits={digits}
            />
          </Field>
          <Field label="Unit cost" htmlFor="pr-c" hint="What one unit costs you to make or buy.">
            <MoneyInput
              id="pr-c"
              value={f.cost}
              onChange={(v) => setF({ ...f, cost: v })}
              currency={cur}
              digits={digits}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
