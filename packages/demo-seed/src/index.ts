import {
  getDb,
  initializeSchema,
  createWallet,
  topUp,
  createRule,
  evaluateAuthorization,
  placeHold,
  writeAuthorizationLog,
  writeNotification,
  checkBalance,
  type RuleType,
} from "@gentwallet/wallet-core";

// ─── Configuration ──────────────────────────────────────────────────────────

const WALLET_ID = process.env.WALLET_ID ?? "demo-wallet";
const TOP_UP_CENTS = Number(process.env.TOP_UP_CENTS ?? 10000); // $100.00
const SKIP_TRANSACTIONS = process.env.SKIP_TRANSACTIONS === "true";

// ─── Default spending rules ─────────────────────────────────────────────────

const DEFAULT_RULES: Array<{
  type: RuleType;
  valueCents?: number;
  mccCodes?: string[];
}> = [
  { type: "auto_approve_threshold", valueCents: 2000 }, // $20
  { type: "notify_over", valueCents: 1000 }, // $10
  { type: "category_block", mccCodes: ["7995"] }, // Gambling
  { type: "daily_limit", valueCents: 5000 }, // $50/day
];

// ─── Demo transactions (exercising all rule paths) ──────────────────────────

const DEMO_PURCHASES = [
  {
    amountCents: 1800,
    merchantName: "OpenAI API",
    merchantCategory: "5734",
    description: "Approved, triggers notify-over ($18 > $10 threshold)",
  },
  {
    amountCents: 500,
    merchantName: "Browserbase",
    merchantCategory: "5734",
    description: "Approved, under all thresholds",
  },
  {
    amountCents: 2500,
    merchantName: "Cloud Compute Inc",
    merchantCategory: "7372",
    description: "Declined by auto-approve threshold ($25 > $20)",
  },
  {
    amountCents: 1200,
    merchantName: "Lucky Casino Online",
    merchantCategory: "7995",
    description: "Declined by category block (gambling MCC 7995)",
  },
  {
    amountCents: 800,
    merchantName: "Acme SaaS",
    merchantCategory: "5734",
    description: "Approved, small purchase",
  },
];

// ─── Seed ───────────────────────────────────────────────────────────────────

function seed() {
  const db = getDb();
  initializeSchema(db);

  console.log(`\n--- GentWallet Demo Seed ---\n`);

  // Create wallet
  try {
    createWallet(db, WALLET_ID);
    console.log(`Created wallet: ${WALLET_ID}`);
  } catch {
    console.log(`Wallet ${WALLET_ID} already exists, continuing...`);
  }

  // Top up
  const result = topUp(db, WALLET_ID, TOP_UP_CENTS);
  console.log(
    `Topped up $${(TOP_UP_CENTS / 100).toFixed(2)} → balance: $${(result.balanceCents / 100).toFixed(2)}`
  );

  // Create rules
  console.log(`\nSpending rules:`);
  for (const rule of DEFAULT_RULES) {
    const created = createRule(db, WALLET_ID, rule.type, {
      valueCents: rule.valueCents,
      mccCodes: rule.mccCodes,
    });
    const display = rule.valueCents
      ? `$${(rule.valueCents / 100).toFixed(2)}`
      : rule.mccCodes?.join(", ");
    console.log(`  ${rule.type}: ${display}`);
  }

  // Run demo transactions
  if (!SKIP_TRANSACTIONS) {
    console.log(`\nDemo transactions:`);
    for (const purchase of DEMO_PURCHASES) {
      const startTime = performance.now();
      const evaluation = evaluateAuthorization(
        db,
        WALLET_ID,
        purchase.amountCents,
        purchase.merchantCategory
      );

      let holdId: string | undefined;
      if (evaluation.decision === "approved") {
        const balance = checkBalance(db, WALLET_ID);
        if (purchase.amountCents > balance.availableCents) {
          evaluation.decision = "declined";
          evaluation.reason = "insufficient funds";
        } else {
          holdId = placeHold(db, WALLET_ID, purchase.amountCents, {
            merchantName: purchase.merchantName,
            merchantCategory: purchase.merchantCategory,
          });
        }
      }

      const decidedInMs = Math.round(performance.now() - startTime);

      const logEntry = writeAuthorizationLog(db, {
        walletId: WALLET_ID,
        amountCents: purchase.amountCents,
        merchantName: purchase.merchantName,
        merchantCategory: purchase.merchantCategory,
        decision: evaluation.decision,
        declineReason:
          evaluation.decision === "declined" ? evaluation.reason : undefined,
        holdId,
        decidedInMs,
      });

      for (const notif of evaluation.notifications) {
        writeNotification(db, {
          walletId: WALLET_ID,
          authorizationLogId: logEntry.id,
          ruleId: notif.ruleId,
          message: notif.message,
        });
      }

      const icon = evaluation.decision === "approved" ? "✓" : "✗";
      console.log(
        `  ${icon} ${purchase.merchantName} $${(purchase.amountCents / 100).toFixed(2)} → ${evaluation.decision}`
      );
      if (evaluation.decision === "declined") {
        console.log(`    Reason: ${evaluation.reason}`);
      }
      if (evaluation.notifications.length > 0) {
        for (const n of evaluation.notifications) {
          console.log(`    Notification: ${n.message}`);
        }
      }
    }
  }

  // Final balance
  const balance = checkBalance(db, WALLET_ID);
  console.log(`\nFinal balance:`);
  console.log(`  Balance:   $${(balance.balanceCents / 100).toFixed(2)}`);
  console.log(`  Held:      $${(balance.heldCents / 100).toFixed(2)}`);
  console.log(`  Available: $${(balance.availableCents / 100).toFixed(2)}`);
  console.log(`\nDone. Dashboard: http://localhost:3000`);
  console.log(`API: http://localhost:3001/api/balance/${WALLET_ID}\n`);
}

seed();
