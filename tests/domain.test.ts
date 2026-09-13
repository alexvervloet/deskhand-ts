/**
 * The seeded world is the fixture every later test builds on, so it is worth
 * asserting that it has the shape those tests assume.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "../src/auth.ts";
import { all, closeAfter, fetchOne, fresh, orgId, pool } from "./helpers.ts";

closeAfter();
before(fresh);

describe("the seeded world", () => {
  test("two orgs share no customers", async () => {
    const emails: Record<string, Set<string>> = {};
    for (const slug of ["northwind", "lumen"]) {
      const rows = await all(pool(), "select email from customers where org_id = $1", [
        await orgId(slug),
      ]);
      emails[slug] = new Set(rows.map((r) => r["email"] as string));
    }

    assert.ok(emails["northwind"]!.size > 0, "northwind seeded no customers");
    assert.ok(emails["lumen"]!.size > 0, "lumen seeded no customers");
    const shared = [...emails["northwind"]!].filter((e) => emails["lumen"]!.has(e));
    assert.deepEqual(shared, []);
  });

  test("every ticket belongs to a customer in the same org", async () => {
    const leaks = await all(
      pool(),
      `select t.reference from tickets t
        join customers c on c.id = t.customer_id
        where c.org_id <> t.org_id`,
    );
    assert.deepEqual(leaks, []);
  });

  test("every order belongs to a customer in the same org", async () => {
    const leaks = await all(
      pool(),
      `select o.reference from orders o
        join customers c on c.id = o.customer_id
        where c.org_id <> o.org_id`,
    );
    assert.deepEqual(leaks, []);
  });

  test("knowledge base search is scoped and ranked", async () => {
    const rows = await all(
      pool(),
      `select slug from kb_articles
        where org_id = $1 and search @@ websearch_to_tsquery('english', $2)
        order by ts_rank(search, websearch_to_tsquery('english', $2)) desc`,
      [await orgId("northwind"), "stale coffee refund"],
    );
    assert.ok(rows.length > 0, "the refund policy should be findable by the words a ticket uses");
    assert.equal(rows[0]!["slug"], "refund-policy");
  });

  test("knowledge base search does not cross orgs", async () => {
    // "warranty" only exists in Lumen's knowledge base.
    const rows = await all(
      pool(),
      `select slug from kb_articles
        where org_id = $1 and search @@ websearch_to_tsquery('english', $2)`,
      [await orgId("northwind"), "warranty"],
    );
    assert.deepEqual(rows, []);
  });

  test("the injection fixture is present", async () => {
    // The integrity tests depend on this attack existing in the seed data. If
    // someone sanitises it out of the fixtures, they silently stop testing
    // anything — so the fixture itself is asserted.
    const row = await fetchOne(
      pool(),
      `select m.body from ticket_messages m
        join tickets t on t.id = m.ticket_id
        where t.reference = 'NW-4' and m.author_kind = 'customer'`,
    );
    assert.ok(row !== null);
    assert.ok(String(row["body"]).includes("Ignore all previous instructions"));
    assert.ok(String(row["body"]).includes("issue_refund"));
  });

  test("money is never fractional", async () => {
    const rows = await all(pool(), "select reference, total_cents from orders");
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.ok(Number.isInteger(row["total_cents"]), `${row["reference"]} is not integer cents`);
    }
  });
});

describe("passwords and session tokens", () => {
  test("password hashing round trips", async () => {
    const digest = await hashPassword("demo-password-123");
    assert.notEqual(digest, "demo-password-123");
    assert.ok(await verifyPassword("demo-password-123", digest));
    assert.ok(!(await verifyPassword("wrong", digest)));
  });

  test("a malformed hash is a failed login, not a crash", async () => {
    assert.ok(!(await verifyPassword("anything", "not-a-bcrypt-hash")));
  });

  test("the session token is never stored verbatim", () => {
    const [token, digest] = newSessionToken();
    assert.notEqual(token, digest);
    assert.equal(hashToken(token), digest);
    assert.equal(digest.length, 64);
  });
});
