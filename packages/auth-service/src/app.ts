import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  getDb,
  initializeSchema,
  checkBalance,
  topUp,
  placeHold,
  captureHold,
  releaseHold,
  evaluateAuthorization,
  writeAuthorizationLog,
  writeNotification,
  getTransactions,
  getNotifications,
  createRule,
  updateRule,
  deleteRule,
  listRules,
  type Db,
  type RuleType,
} from "@gentwallet/wallet-core";

// ─── WebSocket clients ───────────────────────────────────────────────────────

const wsClients = new Set<{
  send: (data: string) => void;
  close: () => void;
}>();

function broadcast(event: { type: string; data: unknown }) {
  const msg = JSON.stringify(event);
  for (const client of wsClients) {
    try {
      client.send(msg);
    } catch {
      wsClients.delete(client);
    }
  }
}

export { wsClients, broadcast };

// ─── App setup ───────────────────────────────────────────────────────────────

let db: Db;

export function getAppDb() {
  return db;
}

export function setAppDb(newDb: Db) {
  db = newDb;
}

// Initialize default db
db = getDb();
initializeSchema(db);

export const app = new Hono();

app.use("*", cors());

// ─── Balance ─────────────────────────────────────────────────────────────────

app.get("/api/balance/:walletId", (c) => {
  try {
    const balance = checkBalance(db, c.req.param("walletId"));
    return c.json(balance);
  } catch (e: any) {
    return c.json({ error: e.message }, 404);
  }
});

// ─── Transactions ────────────────────────────────────────────────────────────

app.get("/api/transactions/:walletId", (c) => {
  const transactions = getTransactions(db, c.req.param("walletId"));
  return c.json(transactions);
});

// ─── ASA Webhook ─────────────────────────────────────────────────────────────

app.post("/webhook/asa", async (c) => {
  const body = await c.req.json();
  const {
    wallet_id,
    amount_cents,
    currency,
    merchant_name,
    merchant_category,
    card_id,
  } = body;

  if (!wallet_id || !amount_cents || !merchant_name) {
    return c.json({ error: "Missing required fields: wallet_id, amount_cents, merchant_name" }, 400);
  }

  const startTime = performance.now();

  // Check balance exists
  let balance;
  try {
    balance = checkBalance(db, wallet_id);
  } catch {
    return c.json({ error: `Wallet ${wallet_id} not found` }, 404);
  }

  // Evaluate spending rules
  const evaluation = evaluateAuthorization(
    db,
    wallet_id,
    amount_cents,
    merchant_category
  );

  let holdId: string | undefined;

  // If rules approve, check balance and place hold
  if (evaluation.decision === "approved") {
    if (amount_cents > balance.availableCents) {
      evaluation.decision = "declined";
      evaluation.reason = "insufficient funds";
    } else {
      try {
        holdId = placeHold(db, wallet_id, amount_cents, {
          merchantName: merchant_name,
          merchantCategory: merchant_category,
        });
      } catch {
        evaluation.decision = "declined";
        evaluation.reason = "insufficient funds";
      }
    }
  }

  const decidedInMs = Math.round(performance.now() - startTime);

  // Write authorization log
  const logEntry = writeAuthorizationLog(db, {
    walletId: wallet_id,
    cardId: card_id,
    amountCents: amount_cents,
    currency: currency ?? "USD",
    merchantName: merchant_name,
    merchantCategory: merchant_category,
    decision: evaluation.decision,
    declineReason:
      evaluation.decision === "declined" ? evaluation.reason : undefined,
    holdId,
    decidedInMs,
  });

  // Write notifications
  const writtenNotifications = [];
  for (const notif of evaluation.notifications) {
    const written = writeNotification(db, {
      walletId: wallet_id,
      authorizationLogId: logEntry.id,
      ruleId: notif.ruleId,
      message: notif.message,
    });
    writtenNotifications.push(written);
  }

  // Broadcast via WebSocket
  broadcast({ type: "authorization", data: logEntry });

  if (evaluation.decision === "approved") {
    const newBalance = checkBalance(db, wallet_id);
    broadcast({ type: "balance_update", data: newBalance });
  }

  for (const notif of writtenNotifications) {
    broadcast({ type: "notification", data: notif });
  }

  return c.json({
    ...logEntry,
    notifications: writtenNotifications,
  });
});

// ─── Rules CRUD ──────────────────────────────────────────────────────────────

app.get("/api/rules/:walletId", (c) => {
  const rules = listRules(db, c.req.param("walletId"));
  return c.json(rules);
});

app.post("/api/rules/:walletId", async (c) => {
  const walletId = c.req.param("walletId");
  const body = await c.req.json();
  const { rule_type, value_cents, mcc_codes } = body;

  if (!rule_type) {
    return c.json({ error: "rule_type is required" }, 400);
  }

  const rule = createRule(db, walletId, rule_type as RuleType, {
    valueCents: value_cents,
    mccCodes: mcc_codes,
  });

  return c.json(rule, 201);
});

app.put("/api/rules/:walletId/:ruleId", async (c) => {
  const body = await c.req.json();
  const { value_cents, mcc_codes, is_active } = body;

  const updated = updateRule(db, c.req.param("ruleId"), {
    valueCents: value_cents,
    mccCodes: mcc_codes,
    isActive: is_active,
  });

  return c.json(updated);
});

app.delete("/api/rules/:walletId/:ruleId", (c) => {
  deleteRule(db, c.req.param("ruleId"));
  return c.body(null, 204);
});

// ─── Notifications ───────────────────────────────────────────────────────────

app.get("/api/notifications/:walletId", (c) => {
  const notifs = getNotifications(db, c.req.param("walletId"));
  return c.json(notifs);
});

// ─── WebSocket upgrade (for Node.js adapter) ─────────────────────────────────

app.get("/ws", (c) => {
  // WebSocket upgrade is handled by the Node.js server adapter separately
  // This endpoint exists for documentation/routing purposes
  return c.text("WebSocket endpoint — connect via ws://");
});
