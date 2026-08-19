import { describe, it, expect } from "vitest";
import { matchesGlob, evaluateDomainPolicy, evaluateMoneyPolicy, type PolicyConfig, type PolicyLedgerQueries } from "../src/policy.js";
import { validPaymentRequirements } from "./fixtures.js";

describe("matchesGlob", () => {
  it("matches a bare wildcard against anything", () => {
    expect(matchesGlob("api.example.com", "*")).toBe(true);
  });

  it("matches a suffix wildcard", () => {
    expect(matchesGlob("sub.trusted-scraper.io", "*.trusted-scraper.io")).toBe(true);
    expect(matchesGlob("trusted-scraper.io", "*.trusted-scraper.io")).toBe(false);
  });

  it("matches an exact hostname", () => {
    expect(matchesGlob("api.example.com", "api.example.com")).toBe(true);
    expect(matchesGlob("other.example.com", "api.example.com")).toBe(false);
  });

  it("does not match an unrelated hostname", () => {
    expect(matchesGlob("evil.com", "*.trusted-scraper.io")).toBe(false);
  });
});

describe("evaluateDomainPolicy", () => {
  it("allows everything when no rules are configured", () => {
    expect(evaluateDomainPolicy(undefined, "https://anything.com/x")).toEqual({ type: "allow" });
    expect(evaluateDomainPolicy({}, "https://anything.com/x")).toEqual({ type: "allow" });
  });

  it("applies the first matching rule, not the most specific one", () => {
    const config: PolicyConfig = {
      rules: [
        { match: "*", action: "deny" },
        { match: "api.example.com", action: "allow" },
      ],
    };
    // "*" matches first and wins, even though a more specific allow rule exists later
    expect(evaluateDomainPolicy(config, "https://api.example.com/x")).toMatchObject({ type: "deny" });
  });

  it("allows when a later rule allows and an earlier rule doesn't match", () => {
    const config: PolicyConfig = {
      rules: [
        { match: "evil.com", action: "deny" },
        { match: "api.example.com", action: "allow" },
      ],
    };
    expect(evaluateDomainPolicy(config, "https://api.example.com/x")).toEqual({ type: "allow" });
  });

  it("allows when no rule matches", () => {
    const config: PolicyConfig = { rules: [{ match: "evil.com", action: "deny" }] };
    expect(evaluateDomainPolicy(config, "https://api.example.com/x")).toEqual({ type: "allow" });
  });
});

function fakeLedger(overrides: Partial<PolicyLedgerQueries> = {}): PolicyLedgerQueries {
  return {
    sumPaid: () => 0n,
    countPaid: () => 0,
    hasEverPaid: () => true, // default: already seen, so onFirstSeenEscalate tests opt in explicitly
    ...overrides,
  };
}

const requirements = validPaymentRequirements();
const baseInput = { url: "https://api.example.com/data", requirements, ctx: {}, now: () => 0 };

describe("evaluateMoneyPolicy", () => {
  it("allows everything when no policy config is given at all", () => {
    expect(evaluateMoneyPolicy(undefined, fakeLedger(), baseInput)).toEqual({ type: "allow" });
  });

  it("denies when the amount exceeds the global maxPerCall", () => {
    const config: PolicyConfig = { maxPerCall: "10" };
    expect(evaluateMoneyPolicy(config, fakeLedger(), baseInput)).toMatchObject({ type: "deny", code: "policy_denied_max_per_call" });
  });

  it("denies when the amount exceeds a per-rule maxPerCall override", () => {
    const config: PolicyConfig = { maxPerCall: "999999999", rules: [{ match: "api.example.com", action: "allow", maxPerCall: "10" }] };
    expect(evaluateMoneyPolicy(config, fakeLedger(), baseInput)).toMatchObject({ type: "deny", code: "policy_denied_max_per_call" });
  });

  it("denies when perTaskBudget would be exceeded", () => {
    const config: PolicyConfig = { perTaskBudget: "10000" };
    const ledger = fakeLedger({ sumPaid: () => 5000n }); // + this call's 50000 > 10000
    const input = { ...baseInput, ctx: { taskId: "task-1" } };
    expect(evaluateMoneyPolicy(config, ledger, input)).toMatchObject({ type: "deny", code: "policy_denied_budget" });
  });

  it("does not enforce perTaskBudget when no taskId is present on the request", () => {
    const config: PolicyConfig = { perTaskBudget: "1" }; // would deny any real amount, if enforced
    expect(evaluateMoneyPolicy(config, fakeLedger(), baseInput)).toEqual({ type: "allow" });
  });

  it("denies when dailyBudget would be exceeded", () => {
    const config: PolicyConfig = { dailyBudget: "10000" };
    const ledger = fakeLedger({ sumPaid: () => 5000n });
    expect(evaluateMoneyPolicy(config, ledger, baseInput)).toMatchObject({ type: "deny", code: "policy_denied_budget" });
  });

  it("denies when maxCallsPerTaskPerEndpoint is reached", () => {
    const config: PolicyConfig = { maxCallsPerTaskPerEndpoint: 2 };
    const ledger = fakeLedger({ countPaid: () => 2 });
    const input = { ...baseInput, ctx: { taskId: "task-1" } };
    expect(evaluateMoneyPolicy(config, ledger, input)).toMatchObject({ type: "deny", code: "policy_denied_max_calls" });
  });

  it("escalates when the amount exceeds requireApprovalAbove", () => {
    const config: PolicyConfig = { rules: [{ match: "api.example.com", action: "allow", requireApprovalAbove: "10" }] };
    expect(evaluateMoneyPolicy(config, fakeLedger(), baseInput)).toEqual({ type: "escalate", reason: "require_approval_above" });
  });

  it("escalates on a first-seen recipient when onFirstSeenEscalate is on", () => {
    const config: PolicyConfig = { onFirstSeenEscalate: true };
    const ledger = fakeLedger({ hasEverPaid: () => false });
    expect(evaluateMoneyPolicy(config, ledger, baseInput)).toEqual({ type: "escalate", reason: "on_first_seen" });
  });

  it("does not escalate on first-seen when onFirstSeenEscalate is off (the default)", () => {
    const config: PolicyConfig = {};
    const ledger = fakeLedger({ hasEverPaid: () => false });
    expect(evaluateMoneyPolicy(config, ledger, baseInput)).toEqual({ type: "allow" });
  });

  it("regression: hard caps are checked before escalation — a budget-exceeding call denies even if it would also require approval", () => {
    const config: PolicyConfig = {
      perTaskBudget: "1",
      rules: [{ match: "api.example.com", action: "allow", requireApprovalAbove: "1" }],
    };
    const input = { ...baseInput, ctx: { taskId: "task-1" } };
    const decision = evaluateMoneyPolicy(config, fakeLedger(), input);
    expect(decision).toMatchObject({ type: "deny", code: "policy_denied_budget" });
  });
});
