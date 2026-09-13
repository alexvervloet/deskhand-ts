/**
 * Signing in and out.
 *
 * The login endpoint is the one place in this API where an unauthenticated
 * caller can make the server do expensive work, so it is throttled and it is
 * deliberately constant-ish time: a missing account and a wrong password take
 * the same path.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { newSessionToken, sessionExpiry, verifyPassword } from "../../auth.ts";
import { settings } from "../../config.ts";
import { execute, fetchOne, pool } from "../../db.ts";
import { authLimiter } from "../../ratelimit.ts";
import { APPROVER_ROLES, HttpError, requireCaller } from "../deps.ts";
import { LoginRequest, LoginResponse, MeResponse } from "../schemas.ts";

/**
 * Who to count login attempts against.
 *
 * Behind a proxy the socket peer is the proxy, so without this every visitor
 * shares one bucket and the first person to fat-finger a password locks out
 * everyone else. Only a header the proxy *overwrites* is trustworthy here — an
 * `X-Forwarded-For` a client can append to would let an attacker mint a fresh
 * bucket per attempt and defeat the throttle entirely.
 */
export function throttleKey(request: FastifyRequest): string {
  if (settings.clientIpHeader) {
    const forwarded = request.headers[settings.clientIpHeader.toLowerCase()];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (value) return value.split(",")[0]!.trim();
  }
  return request.ip || "unknown";
}

// A valid-shaped bcrypt hash that nothing hashes to. Compared against when the
// account does not exist, so a missing account costs the same ~250ms of CPU as
// a wrong password and cannot be told apart by timing it.
const DECOY_HASH = "$2b$10$" + "x".repeat(53);

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/auth/login",
    { schema: { body: LoginRequest, response: { 200: LoginResponse } } },
    async (request) => {
      if (!authLimiter.allow(throttleKey(request))) {
        throw new HttpError(429, "too many login attempts; wait a minute");
      }

      const body = request.body as { email: string; password: string };
      const row = await fetchOne(
        pool(),
        `select u.id, u.email, u.role::text as role, u.password_hash,
                o.id as org_id, o.slug, o.name
           from users u join orgs o on o.id = u.org_id
          where lower(u.email) = lower($1)`,
        [body.email],
      );
      // The password is verified even when the user does not exist, against a
      // throwaway hash, so a missing account and a wrong password take the same
      // time to answer.
      const stored = row ? (row["password_hash"] as string) : DECOY_HASH;
      const ok = await verifyPassword(body.password, stored);
      if (!ok || row === null) throw new HttpError(401, "invalid email or password");

      const [token, digest] = newSessionToken();
      const expires = sessionExpiry();
      await execute(
        pool(),
        "insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)",
        [digest, row["id"], expires],
      );

      return {
        token,
        expires_at: expires,
        user: {
          id: String(row["id"]),
          email: row["email"],
          role: row["role"],
          org_id: String(row["org_id"]),
          org_slug: row["slug"],
          org_name: row["name"],
          can_approve: APPROVER_ROLES.has(row["role"] as string),
        },
      };
    },
  );

  app.post("/auth/logout", { preHandler: requireCaller }, async (request, reply) => {
    await execute(pool(), "delete from sessions where user_id = $1", [request.caller.userId]);
    return reply.code(204).send();
  });

  app.get(
    "/me",
    { preHandler: requireCaller, schema: { response: { 200: MeResponse } } },
    async (request) => {
      const caller = request.caller;
      return {
        id: caller.userId,
        email: caller.email,
        role: caller.role,
        org_id: caller.orgId,
        org_slug: caller.orgSlug,
        org_name: caller.orgName,
        can_approve: caller.canApprove,
      };
    },
  );
}
