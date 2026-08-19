import type { PaymentRequirements, RequestContext } from "./types.js";

export interface PolicyRule {
  match: string; // glob against the request's hostname, e.g. "*.trusted-scraper.io", "api.example.com", "*"
  action: "allow" | "deny";
  maxPerCall?: string; // base-unit integer string override for calls matching this rule
  requireApprovalAbove?: string;
}

export interface EscalationContext {
  reason: "require_approval_above" | "on_first_seen";
  url: string;
  taskId?: string;
  agentId?: string;
  amount: string;
  asset: string;
  network: string;
  recipient: string;
}

export interface PolicyConfig {
  rules?: PolicyRule[]; // evaluated in order, first match wins; no rules = allow everything
  maxPerCall?: string; // global default cap, overridden per-rule
  perTaskBudget?: string;
  dailyBudget?: string;
  maxCallsPerTaskPerEndpoint?: number;
  onFirstSeenEscalate?: boolean; // default false — every fresh ledger's first payment would otherwise escalate
  onEscalate?: (ctx: EscalationContext) => Promise<boolean>; // true = proceed, false = deny. Absent = fail-fast deny.
}

export type PolicyDenyCode = "policy_denied_domain" | "policy_denied_max_per_call" | "policy_denied_budget" | "policy_denied_max_calls";

export type PolicyDecision =
  | { type: "allow" }
  | { type: "deny"; code: PolicyDenyCode; reason: string }
  | { type: "escalate"; reason: EscalationContext["reason"] };

/** Narrow query surface evaluateMoneyPolicy needs from the ledger — lets
 * unit tests stub it without spinning up SQLite. Ledger implements this
 * structurally, no explicit `implements` needed. */
export interface PolicyLedgerQueries {
  sumPaid(filter: { asset: string; network: string; taskId?: string; sinceTs?: number }): bigint;
  countPaid(filter: { taskId?: string; endpoint: string }): number;
  hasEverPaid(recipient: string): boolean;
}

/** Single `*` wildcard per pattern — covers every example in the doc's
 * config (`*`, `*.trusted-scraper.io`, exact hostnames). No new dependency. */
export function matchesGlob(hostname: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(hostname);
}

/**
 * Runs before any network call (see interceptor.ts) — domain rules need no
 * payment data, so a full round trip to a host you were going to deny
 * anyway is wasted. First match wins; no match or no rules = allow (the
 * doc's "default-deny is the sane posture" is something a caller opts into
 * via an explicit trailing `{match: "*", action: "deny"}` rule, not
 * something this engine forces silently).
 */
export function evaluateDomainPolicy(config: PolicyConfig | undefined, url: string): PolicyDecision {
  const rules = config?.rules;
  if (!rules || rules.length === 0) return { type: "allow" };

  const hostname = new URL(url).hostname;
  for (const rule of rules) {
    if (matchesGlob(hostname, rule.match)) {
      return rule.action === "allow"
        ? { type: "allow" }
        : { type: "deny", code: "policy_denied_domain", reason: `domain denied by rule "${rule.match}"` };
    }
  }
  return { type: "allow" };
}

function matchingRule(config: PolicyConfig, hostname: string): PolicyRule | undefined {
  return config.rules?.find((rule) => matchesGlob(hostname, rule.match));
}

/**
 * Hard caps first, escalation checks second — an approved escalation can
 * never bypass a budget, because the budget check already ran and denied
 * first if it was going to. See the plan's scope decision on this ordering.
 */
export function evaluateMoneyPolicy(
  config: PolicyConfig | undefined,
  ledger: PolicyLedgerQueries,
  input: { url: string; requirements: PaymentRequirements; ctx: RequestContext; now: () => number },
): PolicyDecision {
  if (!config) return { type: "allow" };

  const { url, requirements, ctx, now } = input;
  const { maxAmountRequired: amount, asset, network, payTo: recipient } = requirements;
  const hostname = new URL(url).hostname;
  const rule = matchingRule(config, hostname);

  const maxPerCall = rule?.maxPerCall ?? config.maxPerCall;
  if (maxPerCall !== undefined && BigInt(amount) > BigInt(maxPerCall)) {
    return { type: "deny", code: "policy_denied_max_per_call", reason: `amount ${amount} exceeds maxPerCall ${maxPerCall}` };
  }

  if (config.perTaskBudget !== undefined && ctx.taskId) {
    const spent = ledger.sumPaid({ asset, network, taskId: ctx.taskId });
    if (spent + BigInt(amount) > BigInt(config.perTaskBudget)) {
      return { type: "deny", code: "policy_denied_budget", reason: `would exceed perTaskBudget ${config.perTaskBudget} for task ${ctx.taskId}` };
    }
  }

  if (config.dailyBudget !== undefined) {
    const dayMs = 24 * 60 * 60 * 1000;
    const sinceTs = Math.floor(now() / dayMs) * dayMs; // start of current UTC day
    const spent = ledger.sumPaid({ asset, network, sinceTs });
    if (spent + BigInt(amount) > BigInt(config.dailyBudget)) {
      return { type: "deny", code: "policy_denied_budget", reason: `would exceed dailyBudget ${config.dailyBudget}` };
    }
  }

  if (config.maxCallsPerTaskPerEndpoint !== undefined && ctx.taskId) {
    const count = ledger.countPaid({ taskId: ctx.taskId, endpoint: url });
    if (count >= config.maxCallsPerTaskPerEndpoint) {
      return {
        type: "deny",
        code: "policy_denied_max_calls",
        reason: `reached maxCallsPerTaskPerEndpoint (${config.maxCallsPerTaskPerEndpoint}) for task ${ctx.taskId} at ${url}`,
      };
    }
  }

  const requireApprovalAbove = rule?.requireApprovalAbove;
  if (requireApprovalAbove !== undefined && BigInt(amount) > BigInt(requireApprovalAbove)) {
    return { type: "escalate", reason: "require_approval_above" };
  }

  if (config.onFirstSeenEscalate && !ledger.hasEverPaid(recipient)) {
    return { type: "escalate", reason: "on_first_seen" };
  }

  return { type: "allow" };
}
