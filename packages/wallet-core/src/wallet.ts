import { eq, and, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { Db } from "./db/connection.js";
import {
  wallets,
  ledgerEntries,
  holds,
  spendingRules,
  authorizationLog,
  notifications,
} from "./db/schema.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Balance = {
  balanceCents: number;
  heldCents: number;
  availableCents: number;
};

export type RuleType =
  | "auto_approve_threshold"
  | "notify_over"
  | "category_block"
  | "daily_limit";

export type SpendingRule = {
  id: string;
  walletId: string;
  ruleType: RuleType;
  valueCents: number | null;
  mccCodes: string[] | null;
  isActive: boolean;
  createdAt: string;
};

export type AuthorizationDecision = {
  decision: "approved" | "declined";
  reason: string;
  notifications: Array<{
    ruleId: string;
    message: string;
  }>;
};

export type AuthorizationLogEntry = {
  id: string;
  walletId: string;
  cardId: string | null;
  amountCents: number;
  currency: string;
  merchantName: string;
  merchantCategory: string | null;
  decision: string;
  declineReason: string | null;
  holdId: string | null;
  decidedInMs: number | null;
  createdAt: string;
};

// ─── Wallet Operations ───────────────────────────────────────────────────────

export function createWallet(db: Db, id?: string, currency = "USD") {
  const walletId = id ?? randomUUID();
  db.insert(wallets)
    .values({ id: walletId, balanceCents: 0, heldCents: 0, currency })
    .run();
  return walletId;
}

export function topUp(db: Db, walletId: string, amountCents: number) {
  if (amountCents <= 0) {
    throw new Error("Top-up amount must be positive");
  }

  const wallet = db.select().from(wallets).where(eq(wallets.id, walletId)).get();
  if (!wallet) throw new Error(`Wallet ${walletId} not found`);

  const newBalance = wallet.balanceCents + amountCents;

  db.update(wallets)
    .set({
      balanceCents: newBalance,
      version: wallet.version + 1,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(wallets.id, walletId), eq(wallets.version, wallet.version)))
    .run();

  db.insert(ledgerEntries)
    .values({
      id: randomUUID(),
      walletId,
      entryType: "top_up",
      amountCents,
      runningBalance: newBalance,
      description: `Top-up of ${amountCents} cents`,
    })
    .run();

  return { balanceCents: newBalance };
}

export function checkBalance(db: Db, walletId: string): Balance {
  const wallet = db.select().from(wallets).where(eq(wallets.id, walletId)).get();
  if (!wallet) throw new Error(`Wallet ${walletId} not found`);

  return {
    balanceCents: wallet.balanceCents,
    heldCents: wallet.heldCents,
    availableCents: wallet.balanceCents - wallet.heldCents,
  };
}

// ─── Hold Operations ─────────────────────────────────────────────────────────

export function placeHold(
  db: Db,
  walletId: string,
  amountCents: number,
  metadata?: { merchantName?: string; merchantCategory?: string }
) {
  const wallet = db.select().from(wallets).where(eq(wallets.id, walletId)).get();
  if (!wallet) throw new Error(`Wallet ${walletId} not found`);

  const available = wallet.balanceCents - wallet.heldCents;
  if (amountCents > available) {
    throw new Error("Insufficient available balance");
  }

  const holdId = randomUUID();

  db.update(wallets)
    .set({
      heldCents: wallet.heldCents + amountCents,
      version: wallet.version + 1,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(wallets.id, walletId), eq(wallets.version, wallet.version)))
    .run();

  db.insert(holds)
    .values({
      id: holdId,
      walletId,
      amountCents,
      status: "active",
      merchantName: metadata?.merchantName,
      merchantCategory: metadata?.merchantCategory,
    })
    .run();

  db.insert(ledgerEntries)
    .values({
      id: randomUUID(),
      walletId,
      entryType: "hold",
      amountCents: -amountCents,
      runningBalance: wallet.balanceCents,
      referenceType: "hold",
      referenceId: holdId,
      description: `Hold of ${amountCents} cents`,
    })
    .run();

  return holdId;
}

export function captureHold(db: Db, holdId: string) {
  const hold = db.select().from(holds).where(eq(holds.id, holdId)).get();
  if (!hold) throw new Error(`Hold ${holdId} not found`);
  if (hold.status !== "active") throw new Error(`Hold ${holdId} is not active`);

  const wallet = db
    .select()
    .from(wallets)
    .where(eq(wallets.id, hold.walletId))
    .get();
  if (!wallet) throw new Error(`Wallet not found`);

  // Capture: reduce balance and held by the hold amount
  db.update(wallets)
    .set({
      balanceCents: wallet.balanceCents - hold.amountCents,
      heldCents: wallet.heldCents - hold.amountCents,
      version: wallet.version + 1,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(eq(wallets.id, hold.walletId), eq(wallets.version, wallet.version))
    )
    .run();

  db.update(holds)
    .set({ status: "captured", updatedAt: new Date().toISOString() })
    .where(eq(holds.id, holdId))
    .run();

  db.insert(ledgerEntries)
    .values({
      id: randomUUID(),
      walletId: hold.walletId,
      entryType: "capture",
      amountCents: -hold.amountCents,
      runningBalance: wallet.balanceCents - hold.amountCents,
      referenceType: "hold",
      referenceId: holdId,
      description: `Capture hold of ${hold.amountCents} cents`,
    })
    .run();
}

export function releaseHold(db: Db, holdId: string) {
  const hold = db.select().from(holds).where(eq(holds.id, holdId)).get();
  if (!hold) throw new Error(`Hold ${holdId} not found`);
  if (hold.status !== "active") throw new Error(`Hold ${holdId} is not active`);

  const wallet = db
    .select()
    .from(wallets)
    .where(eq(wallets.id, hold.walletId))
    .get();
  if (!wallet) throw new Error(`Wallet not found`);

  db.update(wallets)
    .set({
      heldCents: wallet.heldCents - hold.amountCents,
      version: wallet.version + 1,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(eq(wallets.id, hold.walletId), eq(wallets.version, wallet.version))
    )
    .run();

  db.update(holds)
    .set({ status: "released", updatedAt: new Date().toISOString() })
    .where(eq(holds.id, holdId))
    .run();

  db.insert(ledgerEntries)
    .values({
      id: randomUUID(),
      walletId: hold.walletId,
      entryType: "release",
      amountCents: hold.amountCents,
      runningBalance: wallet.balanceCents,
      referenceType: "hold",
      referenceId: holdId,
      description: `Release hold of ${hold.amountCents} cents`,
    })
    .run();
}

// ─── Spending Rules ──────────────────────────────────────────────────────────

export function createRule(
  db: Db,
  walletId: string,
  ruleType: RuleType,
  opts: { valueCents?: number; mccCodes?: string[] }
): SpendingRule {
  const id = randomUUID();
  db.insert(spendingRules)
    .values({
      id,
      walletId,
      ruleType,
      valueCents: opts.valueCents ?? null,
      mccCodes: opts.mccCodes ? JSON.stringify(opts.mccCodes) : null,
      isActive: true,
    })
    .run();

  return {
    id,
    walletId,
    ruleType,
    valueCents: opts.valueCents ?? null,
    mccCodes: opts.mccCodes ?? null,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
}

export function updateRule(
  db: Db,
  ruleId: string,
  updates: { valueCents?: number; mccCodes?: string[]; isActive?: boolean }
) {
  const values: Record<string, unknown> = {};
  if (updates.valueCents !== undefined) values.valueCents = updates.valueCents;
  if (updates.mccCodes !== undefined)
    values.mccCodes = JSON.stringify(updates.mccCodes);
  if (updates.isActive !== undefined) values.isActive = updates.isActive;

  db.update(spendingRules)
    .set(values)
    .where(eq(spendingRules.id, ruleId))
    .run();

  return db.select().from(spendingRules).where(eq(spendingRules.id, ruleId)).get();
}

export function deleteRule(db: Db, ruleId: string) {
  db.delete(spendingRules).where(eq(spendingRules.id, ruleId)).run();
}

export function listRules(db: Db, walletId: string): SpendingRule[] {
  const rows = db
    .select()
    .from(spendingRules)
    .where(
      and(eq(spendingRules.walletId, walletId), eq(spendingRules.isActive, true))
    )
    .all();

  return rows.map((r) => ({
    ...r,
    ruleType: r.ruleType as RuleType,
    mccCodes: r.mccCodes ? JSON.parse(r.mccCodes) : null,
    isActive: !!r.isActive,
  }));
}

// ─── Authorization Evaluation ────────────────────────────────────────────────

export function evaluateAuthorization(
  db: Db,
  walletId: string,
  amountCents: number,
  mcc?: string
): AuthorizationDecision {
  const rules = listRules(db, walletId);
  const pendingNotifications: Array<{ ruleId: string; message: string }> = [];

  // Evaluation order per PRD: Category Block, Daily Limit, Auto-approve Threshold
  // First decline wins. Notify-over is collected separately.

  // 1. Category Block
  for (const rule of rules.filter((r) => r.ruleType === "category_block")) {
    if (mcc && rule.mccCodes?.includes(mcc)) {
      return {
        decision: "declined",
        reason: `blocked category: ${mcc}`,
        notifications: [],
      };
    }
  }

  // 2. Daily Limit
  for (const rule of rules.filter((r) => r.ruleType === "daily_limit")) {
    if (rule.valueCents != null) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayEntries = db
        .select()
        .from(authorizationLog)
        .where(
          and(
            eq(authorizationLog.walletId, walletId),
            eq(authorizationLog.decision, "approved"),
            sql`${authorizationLog.createdAt} >= ${todayStart.toISOString()}`
          )
        )
        .all();

      const todayTotal = todayEntries.reduce(
        (sum, e) => sum + e.amountCents,
        0
      );

      if (todayTotal + amountCents > rule.valueCents) {
        return {
          decision: "declined",
          reason: "daily limit exceeded",
          notifications: [],
        };
      }
    }
  }

  // 3. Auto-approve Threshold
  for (const rule of rules.filter(
    (r) => r.ruleType === "auto_approve_threshold"
  )) {
    if (rule.valueCents != null && amountCents > rule.valueCents) {
      return {
        decision: "declined",
        reason: "exceeds auto-approve threshold",
        notifications: [],
      };
    }
  }

  // 4. Notify-over (never declines)
  for (const rule of rules.filter((r) => r.ruleType === "notify_over")) {
    if (rule.valueCents != null && amountCents > rule.valueCents) {
      pendingNotifications.push({
        ruleId: rule.id,
        message: `Amount ${amountCents} cents exceeds notify-over threshold of ${rule.valueCents} cents`,
      });
    }
  }

  return {
    decision: "approved",
    reason: "approved",
    notifications: pendingNotifications,
  };
}

// ─── Authorization Log ───────────────────────────────────────────────────────

export function writeAuthorizationLog(
  db: Db,
  entry: {
    walletId: string;
    cardId?: string;
    amountCents: number;
    currency?: string;
    merchantName: string;
    merchantCategory?: string;
    decision: "approved" | "declined";
    declineReason?: string;
    holdId?: string;
    decidedInMs?: number;
  }
): AuthorizationLogEntry {
  const id = randomUUID();
  db.insert(authorizationLog)
    .values({
      id,
      walletId: entry.walletId,
      cardId: entry.cardId ?? null,
      amountCents: entry.amountCents,
      currency: entry.currency ?? "USD",
      merchantName: entry.merchantName,
      merchantCategory: entry.merchantCategory ?? null,
      decision: entry.decision,
      declineReason: entry.declineReason ?? null,
      holdId: entry.holdId ?? null,
      decidedInMs: entry.decidedInMs ?? null,
    })
    .run();

  return db
    .select()
    .from(authorizationLog)
    .where(eq(authorizationLog.id, id))
    .get()!;
}

export function getTransactions(
  db: Db,
  walletId: string
): AuthorizationLogEntry[] {
  return db
    .select()
    .from(authorizationLog)
    .where(eq(authorizationLog.walletId, walletId))
    .orderBy(sql`${authorizationLog.createdAt} DESC`)
    .all();
}

// ─── Notifications ───────────────────────────────────────────────────────────

export function writeNotification(
  db: Db,
  entry: {
    walletId: string;
    authorizationLogId: string;
    ruleId: string;
    message: string;
  }
) {
  const id = randomUUID();
  db.insert(notifications)
    .values({
      id,
      walletId: entry.walletId,
      authorizationLogId: entry.authorizationLogId,
      ruleId: entry.ruleId,
      message: entry.message,
    })
    .run();
  return db.select().from(notifications).where(eq(notifications.id, id)).get()!;
}

export function getNotifications(db: Db, walletId: string) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.walletId, walletId))
    .orderBy(sql`${notifications.createdAt} DESC`)
    .all();
}
