import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, initializeSchema, type Db } from "./db/connection.js";
import {
  createWallet,
  topUp,
  checkBalance,
  placeHold,
  captureHold,
  releaseHold,
  createRule,
  updateRule,
  deleteRule,
  listRules,
  evaluateAuthorization,
  writeAuthorizationLog,
  writeNotification,
  getNotifications,
} from "./wallet.js";

let db: Db;
let walletId: string;

beforeEach(() => {
  db = createTestDb();
  initializeSchema(db);
  walletId = createWallet(db, "test-wallet");
});

// ─── Balance Operations ──────────────────────────────────────────────────────

describe("topUp", () => {
  it("increases balance", () => {
    topUp(db, walletId, 5000);
    const balance = checkBalance(db, walletId);
    expect(balance.balanceCents).toBe(5000);
    expect(balance.availableCents).toBe(5000);
  });

  it("rejects zero amount", () => {
    expect(() => topUp(db, walletId, 0)).toThrow("Top-up amount must be positive");
  });

  it("rejects negative amount", () => {
    expect(() => topUp(db, walletId, -100)).toThrow("Top-up amount must be positive");
  });
});

describe("checkBalance", () => {
  it("returns correct balance with holds", () => {
    topUp(db, walletId, 5000);
    placeHold(db, walletId, 1500);
    const balance = checkBalance(db, walletId);
    expect(balance.balanceCents).toBe(5000);
    expect(balance.heldCents).toBe(1500);
    expect(balance.availableCents).toBe(3500);
  });

  it("throws for unknown wallet", () => {
    expect(() => checkBalance(db, "unknown")).toThrow("not found");
  });
});

// ─── Hold Lifecycle ──────────────────────────────────────────────────────────

describe("hold lifecycle", () => {
  beforeEach(() => {
    topUp(db, walletId, 5000);
  });

  it("placeHold reduces available balance", () => {
    placeHold(db, walletId, 2000);
    const balance = checkBalance(db, walletId);
    expect(balance.availableCents).toBe(3000);
    expect(balance.heldCents).toBe(2000);
  });

  it("captureHold converts hold to debit", () => {
    const holdId = placeHold(db, walletId, 2000);
    captureHold(db, holdId);
    const balance = checkBalance(db, walletId);
    expect(balance.balanceCents).toBe(3000);
    expect(balance.heldCents).toBe(0);
    expect(balance.availableCents).toBe(3000);
  });

  it("releaseHold restores available balance", () => {
    const holdId = placeHold(db, walletId, 2000);
    releaseHold(db, holdId);
    const balance = checkBalance(db, walletId);
    expect(balance.balanceCents).toBe(5000);
    expect(balance.heldCents).toBe(0);
    expect(balance.availableCents).toBe(5000);
  });

  it("rejects hold on insufficient balance", () => {
    expect(() => placeHold(db, walletId, 6000)).toThrow(
      "Insufficient available balance"
    );
  });
});

// ─── Spending Rules: Auto-approve Threshold ──────────────────────────────────

describe("auto-approve threshold", () => {
  beforeEach(() => {
    topUp(db, walletId, 5000);
    createRule(db, walletId, "auto_approve_threshold", { valueCents: 2000 });
  });

  it("approves amount under threshold", () => {
    const result = evaluateAuthorization(db, walletId, 1500);
    expect(result.decision).toBe("approved");
  });

  it("approves amount at threshold", () => {
    const result = evaluateAuthorization(db, walletId, 2000);
    expect(result.decision).toBe("approved");
  });

  it("declines amount over threshold", () => {
    const result = evaluateAuthorization(db, walletId, 2500);
    expect(result.decision).toBe("declined");
    expect(result.reason).toBe("exceeds auto-approve threshold");
  });
});

// ─── Spending Rules: Category Block ──────────────────────────────────────────

describe("category block", () => {
  beforeEach(() => {
    topUp(db, walletId, 5000);
    createRule(db, walletId, "category_block", {
      mccCodes: ["7995", "7994"],
    });
  });

  it("declines blocked MCC", () => {
    const result = evaluateAuthorization(db, walletId, 500, "7995");
    expect(result.decision).toBe("declined");
    expect(result.reason).toContain("blocked category");
  });

  it("approves non-blocked MCC", () => {
    const result = evaluateAuthorization(db, walletId, 500, "5411");
    expect(result.decision).toBe("approved");
  });

  it("declines second blocked MCC", () => {
    const result = evaluateAuthorization(db, walletId, 500, "7994");
    expect(result.decision).toBe("declined");
  });
});

// ─── Spending Rules: Daily Limit ─────────────────────────────────────────────

describe("daily limit", () => {
  beforeEach(() => {
    topUp(db, walletId, 10000);
    createRule(db, walletId, "daily_limit", { valueCents: 3000 });
  });

  it("approves within limit", () => {
    const result = evaluateAuthorization(db, walletId, 2000);
    expect(result.decision).toBe("approved");
  });

  it("declines when exceeding limit", () => {
    // Write a prior approved authorization for today
    writeAuthorizationLog(db, {
      walletId,
      amountCents: 2500,
      merchantName: "Prior Purchase",
      decision: "approved",
    });

    const result = evaluateAuthorization(db, walletId, 1000);
    expect(result.decision).toBe("declined");
    expect(result.reason).toBe("daily limit exceeded");
  });

  it("accumulates multiple authorizations toward limit", () => {
    writeAuthorizationLog(db, {
      walletId,
      amountCents: 1000,
      merchantName: "Purchase 1",
      decision: "approved",
    });
    writeAuthorizationLog(db, {
      walletId,
      amountCents: 1000,
      merchantName: "Purchase 2",
      decision: "approved",
    });

    // 2000 spent, 1000 remaining in daily limit
    const result1 = evaluateAuthorization(db, walletId, 1000);
    expect(result1.decision).toBe("approved");

    // This would push to 3001, over the limit
    writeAuthorizationLog(db, {
      walletId,
      amountCents: 1000,
      merchantName: "Purchase 3",
      decision: "approved",
    });
    const result2 = evaluateAuthorization(db, walletId, 1);
    expect(result2.decision).toBe("declined");
  });
});

// ─── Spending Rules: Notify-over Threshold ───────────────────────────────────

describe("notify-over threshold", () => {
  beforeEach(() => {
    topUp(db, walletId, 5000);
    createRule(db, walletId, "notify_over", { valueCents: 1000 });
  });

  it("approves and returns notification when over threshold", () => {
    const result = evaluateAuthorization(db, walletId, 1500);
    expect(result.decision).toBe("approved");
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].message).toContain("1500");
  });

  it("approves with no notification when under threshold", () => {
    const result = evaluateAuthorization(db, walletId, 800);
    expect(result.decision).toBe("approved");
    expect(result.notifications).toHaveLength(0);
  });

  it("never declines", () => {
    const result = evaluateAuthorization(db, walletId, 99999);
    expect(result.decision).toBe("approved");
    expect(result.notifications).toHaveLength(1);
  });
});

// ─── Combined Rules ──────────────────────────────────────────────────────────

describe("combined rules", () => {
  it("first decline wins, notifications still collected on approval", () => {
    topUp(db, walletId, 5000);
    createRule(db, walletId, "auto_approve_threshold", { valueCents: 2000 });
    createRule(db, walletId, "notify_over", { valueCents: 500 });

    // Under threshold, triggers notify
    const result = evaluateAuthorization(db, walletId, 1500);
    expect(result.decision).toBe("approved");
    expect(result.notifications).toHaveLength(1);

    // Over threshold, declined, no notifications
    const result2 = evaluateAuthorization(db, walletId, 2500);
    expect(result2.decision).toBe("declined");
    expect(result2.notifications).toHaveLength(0);
  });
});

// ─── Rule CRUD ───────────────────────────────────────────────────────────────

describe("rule CRUD", () => {
  it("creates and lists rules", () => {
    createRule(db, walletId, "auto_approve_threshold", { valueCents: 2000 });
    createRule(db, walletId, "category_block", { mccCodes: ["7995"] });
    const rules = listRules(db, walletId);
    expect(rules).toHaveLength(2);
  });

  it("updates rule threshold", () => {
    const rule = createRule(db, walletId, "auto_approve_threshold", {
      valueCents: 2000,
    });
    updateRule(db, rule.id, { valueCents: 3000 });
    const rules = listRules(db, walletId);
    expect(rules[0].valueCents).toBe(3000);
  });

  it("deleted rule is no longer evaluated", () => {
    topUp(db, walletId, 5000);
    const rule = createRule(db, walletId, "auto_approve_threshold", {
      valueCents: 1000,
    });

    const result1 = evaluateAuthorization(db, walletId, 1500);
    expect(result1.decision).toBe("declined");

    deleteRule(db, rule.id);
    const result2 = evaluateAuthorization(db, walletId, 1500);
    expect(result2.decision).toBe("approved");
  });
});

// ─── Notifications ───────────────────────────────────────────────────────────

describe("notifications", () => {
  it("writes and retrieves notifications", () => {
    const logEntry = writeAuthorizationLog(db, {
      walletId,
      amountCents: 1500,
      merchantName: "Test Merchant",
      decision: "approved",
    });
    const rule = createRule(db, walletId, "notify_over", { valueCents: 1000 });
    writeNotification(db, {
      walletId,
      authorizationLogId: logEntry.id,
      ruleId: rule.id,
      message: "Amount exceeds notify-over threshold",
    });

    const notifs = getNotifications(db, walletId);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].message).toContain("notify-over");
  });
});
