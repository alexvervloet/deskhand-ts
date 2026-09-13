/**
 * Row to wire shape, in one place.
 *
 * Money crosses this boundary as integer cents or micros and never as a float;
 * a formatted string is provided alongside for display, so no client has to
 * reinvent the rounding.
 */

import type { Row } from "../db.ts";
import { formatUsd } from "../pricing.ts";

export function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function ticketSummary(row: Row): Record<string, unknown> {
  return {
    id: String(row["id"]),
    reference: row["reference"],
    subject: row["subject"],
    status: row["status"],
    priority: row["priority"],
    tags: [...(row["tags"] as string[])],
    customer_name: row["customer_name"],
    customer_email: row["customer_email"],
    created_at: row["created_at"],
    open_run_id: row["open_run_id"] ? String(row["open_run_id"]) : null,
  };
}

export function runSummary(row: Row): Record<string, unknown> {
  return {
    id: String(row["id"]),
    ticket_id: String(row["ticket_id"]),
    ticket_reference: row["ticket_reference"] ?? null,
    status: row["status"],
    stop_reason: row["stop_reason"],
    stop_detail: row["stop_detail"],
    provider: row["provider"],
    model: row["model"],
    input_tokens: Number(row["input_tokens"]),
    output_tokens: Number(row["output_tokens"]),
    cost_micros: Number(row["cost_micros"]),
    cost_display: formatUsd(Number(row["cost_micros"])),
    attempt: Number(row["attempt"]),
    created_at: row["created_at"],
    finished_at: row["finished_at"],
  };
}

export function stepView(row: Row): Record<string, unknown> {
  return {
    seq: Number(row["seq"]),
    kind: row["kind"],
    tool_name: row["tool_name"],
    content: row["content"],
    input_tokens: Number(row["input_tokens"]),
    output_tokens: Number(row["output_tokens"]),
    cost_micros: Number(row["cost_micros"]),
    cost_display: formatUsd(Number(row["cost_micros"])),
    latency_ms: Number(row["latency_ms"]),
    created_at: row["created_at"],
  };
}

export function approvalView(row: Row): Record<string, unknown> {
  return {
    id: String(row["id"]),
    run_id: String(row["run_id"]),
    ticket_reference: row["ticket_reference"] ?? null,
    tool_name: row["tool_name"],
    preview: row["preview"],
    args: row["args"],
    status: row["status"],
    reason: row["reason"],
    created_at: row["created_at"],
    expires_at: row["expires_at"],
    decided_at: row["decided_at"],
  };
}

/** A planned item, before a compensation exists. Status is always pending. */
export function planItemView(item: {
  seq: number;
  stepSeq: number;
  toolName: string;
  risk: string;
  disposition: string;
  describe: string;
}): Record<string, unknown> {
  return {
    seq: item.seq,
    step_seq: item.stepSeq,
    tool_name: item.toolName,
    risk: item.risk,
    disposition: item.disposition,
    describe: item.describe,
    status: "pending",
    detail: null,
    applied_at: null,
  };
}
