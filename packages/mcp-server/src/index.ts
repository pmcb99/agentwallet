#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getDb,
  initializeSchema,
  checkBalance,
  topUp,
  evaluateAuthorization,
  placeHold,
  writeAuthorizationLog,
  writeNotification,
  listRules,
  createRule,
  getTransactions,
  getNotifications,
  type RuleType,
} from "@gentwallet/wallet-core";

const db = getDb();
initializeSchema(db);

const server = new McpServer({
  name: "gentwallet",
  version: "0.0.1",
});

// ─── check_balance ──────────────────────────────────────────────────────────

server.tool(
  "check_balance",
  "Check the current balance, held funds, and available balance for a wallet",
  { wallet_id: z.string().describe("The wallet ID to check") },
  async ({ wallet_id }) => {
    try {
      const balance = checkBalance(db, wallet_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                balance_cents: balance.balanceCents,
                held_cents: balance.heldCents,
                available_cents: balance.availableCents,
                available_dollars: `$${(balance.availableCents / 100).toFixed(2)}`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ─── request_purchase ───────────────────────────────────────────────────────

server.tool(
  "request_purchase",
  "Request a purchase authorization. Evaluates spending rules, checks balance, and places a hold if approved.",
  {
    wallet_id: z.string().describe("The wallet ID to charge"),
    amount_cents: z.number().positive().describe("Amount in cents"),
    merchant_name: z.string().describe("Name of the merchant"),
    merchant_category: z
      .string()
      .optional()
      .describe("Merchant category code (MCC)"),
  },
  async ({ wallet_id, amount_cents, merchant_name, merchant_category }) => {
    try {
      const startTime = performance.now();

      const balance = checkBalance(db, wallet_id);
      const evaluation = evaluateAuthorization(
        db,
        wallet_id,
        amount_cents,
        merchant_category
      );

      let holdId: string | undefined;

      if (evaluation.decision === "approved") {
        if (amount_cents > balance.availableCents) {
          evaluation.decision = "declined";
          evaluation.reason = "insufficient funds";
        } else {
          holdId = placeHold(db, wallet_id, amount_cents, {
            merchantName: merchant_name,
            merchantCategory: merchant_category,
          });
        }
      }

      const decidedInMs = Math.round(performance.now() - startTime);

      const logEntry = writeAuthorizationLog(db, {
        walletId: wallet_id,
        amountCents: amount_cents,
        merchantName: merchant_name,
        merchantCategory: merchant_category,
        decision: evaluation.decision,
        declineReason:
          evaluation.decision === "declined" ? evaluation.reason : undefined,
        holdId,
        decidedInMs,
      });

      for (const notif of evaluation.notifications) {
        writeNotification(db, {
          walletId: wallet_id,
          authorizationLogId: logEntry.id,
          ruleId: notif.ruleId,
          message: notif.message,
        });
      }

      const newBalance = checkBalance(db, wallet_id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                decision: evaluation.decision,
                reason: evaluation.reason,
                amount_cents,
                merchant_name,
                merchant_category: merchant_category ?? null,
                hold_id: holdId ?? null,
                authorization_id: logEntry.id,
                decided_in_ms: decidedInMs,
                notifications: evaluation.notifications,
                updated_balance: {
                  available_cents: newBalance.availableCents,
                  available_dollars: `$${(newBalance.availableCents / 100).toFixed(2)}`,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ─── list_rules ─────────────────────────────────────────────────────────────

server.tool(
  "list_rules",
  "List all active spending rules for a wallet",
  { wallet_id: z.string().describe("The wallet ID") },
  async ({ wallet_id }) => {
    const rules = listRules(db, wallet_id);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(rules, null, 2),
        },
      ],
    };
  }
);

// ─── create_rule ────────────────────────────────────────────────────────────

server.tool(
  "create_rule",
  "Create a new spending rule for a wallet. Rule types: auto_approve_threshold, notify_over, category_block, daily_limit",
  {
    wallet_id: z.string().describe("The wallet ID"),
    rule_type: z
      .enum([
        "auto_approve_threshold",
        "notify_over",
        "category_block",
        "daily_limit",
      ])
      .describe("The type of spending rule"),
    value_cents: z
      .number()
      .optional()
      .describe("Threshold value in cents (for threshold/limit rules)"),
    mcc_codes: z
      .array(z.string())
      .optional()
      .describe("Merchant category codes to block (for category_block rules)"),
  },
  async ({ wallet_id, rule_type, value_cents, mcc_codes }) => {
    try {
      const rule = createRule(db, wallet_id, rule_type as RuleType, {
        valueCents: value_cents,
        mccCodes: mcc_codes,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(rule, null, 2),
          },
        ],
      };
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ─── get_transactions ───────────────────────────────────────────────────────

server.tool(
  "get_transactions",
  "Get recent authorization history for a wallet",
  { wallet_id: z.string().describe("The wallet ID") },
  async ({ wallet_id }) => {
    const transactions = getTransactions(db, wallet_id);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(transactions, null, 2),
        },
      ],
    };
  }
);

// ─── get_notifications ──────────────────────────────────────────────────────

server.tool(
  "get_notifications",
  "Get notifications for a wallet (e.g., notify-over threshold alerts)",
  { wallet_id: z.string().describe("The wallet ID") },
  async ({ wallet_id }) => {
    const notifications = getNotifications(db, wallet_id);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(notifications, null, 2),
        },
      ],
    };
  }
);

// ─── Start server ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
