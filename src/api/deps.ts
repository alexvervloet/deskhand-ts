/**
 * Authentication and the tenant scope.
 *
 * Two rules, enforced here rather than remembered at each call site:
 *
 * 1. A request is authenticated by a bearer token whose SHA-256 digest matches
 *    a live session row. The token itself is never stored, so this table is not
 *    a credential store.
 * 2. Every authenticated request carries an org, and every query in the API
 *    filters on it. The scope is a value handlers receive, not a value they
 *    look up — a handler cannot forget to ask which merchant it is serving.
 *
 * Approving an irreversible action is gated separately. `viewer` can watch a
 * run spend money and cannot authorise a penny of it.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { hashToken } from "../auth.ts";
import { fetchOne, pool } from "../db.ts";

export const APPROVER_ROLES = new Set(["owner", "agent"]);

export interface Caller {
  userId: string;
  email: string;
  role: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  canApprove: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    caller: Caller;
  }
}

/** An error carrying the status the client should see. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function resolveCaller(request: FastifyRequest): Promise<Caller> {
  const authorization = request.headers.authorization;
  if (!authorization || !authorization.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, "missing bearer token");
  }

  const token = authorization.slice(7).trim();
  const row = await fetchOne(
    pool(),
    `select u.id, u.email, u.role::text as role, o.id as org_id, o.slug, o.name
       from sessions s
       join users u on u.id = s.user_id
       join orgs o on o.id = u.org_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [hashToken(token)],
  );
  if (row === null) {
    // One message for "no such token" and "expired token" alike: telling the
    // difference apart is useful to an attacker and to nobody else.
    throw new HttpError(401, "invalid or expired session");
  }

  return {
    userId: String(row["id"]),
    email: row["email"] as string,
    role: row["role"] as string,
    orgId: String(row["org_id"]),
    orgSlug: row["slug"] as string,
    orgName: row["name"] as string,
    canApprove: APPROVER_ROLES.has(row["role"] as string),
  };
}

/** Fastify preHandler: attach the caller, or reject. */
export async function requireCaller(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  request.caller = await resolveCaller(request);
}

/** Gate for the actions that commit the merchant to something. */
export async function requireApprover(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireCaller(request, reply);
  if (!request.caller.canApprove) {
    throw new HttpError(
      403,
      `role '${request.caller.role}' may watch runs but not approve irreversible actions`,
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * Fetch a run this caller is allowed to see, or 404.
 *
 * Postgres throws on a malformed uuid, which would surface as a 500 for what is
 * only ever a bad request. A string that cannot be an id is not an id, so it
 * gets the same answer as an id that does not exist.
 */
export async function requireRun(runId: string, orgId: string) {
  if (!isUuid(runId)) throw new HttpError(404, "no such run");

  const row = await fetchOne(
    pool(),
    `select r.*, t.reference as ticket_reference from runs r
       join tickets t on t.id = r.ticket_id
      where r.id = $1 and r.org_id = $2`,
    [runId, orgId],
  );
  if (row === null) {
    // 404 rather than 403 for a run belonging to another merchant: whether a
    // given id exists elsewhere is not this caller's business.
    throw new HttpError(404, "no such run");
  }
  return row;
}
