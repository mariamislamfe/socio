import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "margin-rls-")) + "/db";
delete process.env.SUPABASE_DB_URL;

const { asService, asUser } = await import("@/lib/server/db");

let bizA = "",
  bizB = "",
  userA = "",
  userB = "",
  catB = "",
  accA = "",
  accB = "";

describe("tenant isolation (Postgres RLS)", () => {
  beforeAll(async () => {
    await asService(async (q) => {
      userA = (await q.query<{ id: string }>("insert into auth.users(email) values ('a@x.test') returning id"))[0].id;
      userB = (await q.query<{ id: string }>("insert into auth.users(email) values ('b@x.test') returning id"))[0].id;
      bizA = (
        await q.query<{ id: string }>("insert into businesses(name,created_by) values ('A',$1) returning id", [userA])
      )[0].id;
      bizB = (
        await q.query<{ id: string }>("insert into businesses(name,created_by) values ('B',$1) returning id", [userB])
      )[0].id;
      await q.query("insert into memberships(business_id,user_id,role) values ($1,$2,'owner'),($3,$4,'owner')", [
        bizA,
        userA,
        bizB,
        userB,
      ]);
      accA = (
        await q.query<{ id: string }>(
          "insert into accounts(business_id,name,currency) values ($1,'Main','EGP') returning id",
          [bizA],
        )
      )[0].id;
      accB = (
        await q.query<{ id: string }>(
          "insert into accounts(business_id,name,currency) values ($1,'Main','EGP') returning id",
          [bizB],
        )
      )[0].id;
      catB = (
        await q.query<{ id: string }>(
          "insert into categories(business_id,name,kind) values ($1,'Sales','income') returning id",
          [bizB],
        )
      )[0].id;
      await q.query(
        "insert into transactions(business_id,type,date,amount,currency,account_id) values ($1,'income','2026-01-01',5000,'EGP',$2)",
        [bizB, accB],
      );
      await q.query(
        "insert into transactions(business_id,type,date,amount,currency,account_id) values ($1,'income','2026-01-02',700,'EGP',$2)",
        [bizA, accA],
      );
      const integ = (
        await q.query<{ id: string }>(
          "insert into integrations(business_id,provider) values ($1,'shopify') returning id",
          [bizB],
        )
      )[0].id;
      await q.query("insert into integration_secrets(integration_id,business_id,access_token_enc) values ($1,$2,'x')", [
        integ,
        bizB,
      ]);
    });
  });

  it("members can read and write their own rows (positive control)", async () => {
    const biz = await asUser(userA, (q) => q.query("select id from businesses"));
    expect(biz.map((r: any) => r.id)).toEqual([bizA]);
    const mine = await asUser(userA, (q) => q.query("select amount from transactions"));
    expect(mine).toEqual([{ amount: 700 }]);
    const ins = await asUser(userA, (q) =>
      q.query(
        "insert into transactions(business_id,type,date,amount,currency,account_id) values ($1,'expense','2026-01-03',50,'EGP',$2) returning id",
        [bizA, accA],
      ),
    );
    expect(ins).toHaveLength(1);
  });

  it("user A cannot read user B's rows even though they exist", async () => {
    const seen = await asService((q) =>
      q.query("select count(*)::int as n from transactions where business_id = $1", [bizB]),
    );
    expect(seen[0].n).toBe(1);
    expect(
      await asUser(userA, (q) => q.query("select * from transactions where business_id = $1", [bizB])),
    ).toHaveLength(0);
    expect(await asUser(userA, (q) => q.query("select * from categories where business_id = $1", [bizB]))).toHaveLength(
      0,
    );
    expect(
      await asUser(userA, (q) => q.query("select * from integrations where business_id = $1", [bizB])),
    ).toHaveLength(0);
  });

  it("user A cannot insert into user B's business", async () => {
    await expect(
      asUser(userA, (q) =>
        q.query(
          "insert into transactions(business_id,type,date,amount,currency,account_id) values ($1,'income','2026-01-01',100,'EGP',$2)",
          [bizB, accB],
        ),
      ),
    ).rejects.toThrow();
  });

  it("user A cannot update or delete user B's rows", async () => {
    const upd = await asUser(userA, (q) =>
      q.query("update transactions set amount = 1 where business_id = $1 returning id", [bizB]),
    );
    const del = await asUser(userA, (q) => q.query("delete from accounts where business_id = $1 returning id", [bizB]));
    expect(upd).toHaveLength(0);
    expect(del).toHaveLength(0);
    const still = await asService((q) => q.query("select amount from transactions where business_id = $1", [bizB]));
    expect(still).toEqual([{ amount: 5000 }]);
  });

  it("cross-tenant references are rejected by composite foreign keys", async () => {
    await expect(
      asService((q) =>
        q.query(
          "insert into transactions(business_id,type,date,amount,currency,account_id,category_id) values ($1,'income','2026-01-01',100,'EGP',$2,$3)",
          [bizA, accA, catB],
        ),
      ),
    ).rejects.toThrow();
  });

  it("clients cannot read integration secrets or create businesses/memberships", async () => {
    await expect(asUser(userB, (q) => q.query("select * from integration_secrets"))).rejects.toThrow();
    await expect(
      asUser(userA, (q) => q.query("insert into businesses(name,created_by) values ('evil',$1)", [userA])),
    ).rejects.toThrow();
    await expect(
      asUser(userA, (q) => q.query("insert into memberships(business_id,user_id) values ($1,$2)", [bizB, userA])),
    ).rejects.toThrow();
  });

  it("enforces transfer shape and positive amounts", async () => {
    await expect(
      asService((q) =>
        q.query(
          "insert into transactions(business_id,type,date,amount,currency,account_id) values ($1,'transfer','2026-01-01',100,'EGP',$2)",
          [bizA, accA],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      asService((q) =>
        q.query(
          "insert into transactions(business_id,type,date,amount,currency,account_id) values ($1,'income','2026-01-01',0,'EGP',$2)",
          [bizA, accA],
        ),
      ),
    ).rejects.toThrow();
  });
});
