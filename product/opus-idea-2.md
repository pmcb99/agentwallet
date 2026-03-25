# Agent Wallet — Technical Architecture

## Issuing Provider Decision

Stripe Issuing requires their BaaS tier (Issuing + Treasury + Capital for Platforms) at $10k–$20k/month — not viable for a pre-revenue solo founder. **Lithic** is the primary issuing provider instead. No monthly platform fee, pay-per-card and per-transaction pricing (cents per auth), sandbox available immediately with no approval wait, and the authorization webhook model maps almost identically to what Stripe Issuing would have provided.

Stripe stays in the stack for two things: **Checkout** (user top-ups) and **MPP** (Machine Payment Protocol for Rail 2). Card issuing is Lithic's job.

Fallback providers if Lithic doesn't work out: Marqeta (more enterprise, but has startup programs) or Privacy.com API (less auth control, faster to market).

## Core Insight

The authorization webhook is the critical path. When an agent uses the virtual card anywhere Visa works, Lithic sends an `ASA` (Auth Stream Access) webhook and you have **~5 seconds** to approve or decline. Everything in the architecture radiates outward from making that decision fast and correct.

This means human-in-the-loop approval **cannot happen during authorization**. Your "notify me over X" rule means approve-and-notify, not ask-then-approve. "Pause card" means decline everything. Rules must be pre-set.

---

## Database Schema (PostgreSQL)

### Why Postgres
Money requires ACID. No negotiation. You need serializable transactions on balance checks to prevent double-spending. Postgres gives you this, plus `SELECT ... FOR UPDATE` row-level locking on wallet rows.

### Core Tables

```sql
-- Users / authentication
CREATE TABLE accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    stripe_customer_id VARCHAR(255) UNIQUE,  -- for Checkout top-ups
    lithic_account_token VARCHAR(255) UNIQUE, -- Lithic account holder
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- One wallet per account (for now — multi-wallet is a Phase 2 concern)
CREATE TABLE wallets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID UNIQUE NOT NULL REFERENCES accounts(id),
    balance_cents   BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
    held_cents      BIGINT NOT NULL DEFAULT 0 CHECK (held_cents >= 0),
    currency        VARCHAR(3) NOT NULL DEFAULT 'USD',
    version         INTEGER NOT NULL DEFAULT 0,  -- optimistic locking
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);
-- available_balance = balance_cents - held_cents

-- Double-entry ledger — the source of truth
CREATE TABLE ledger_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    entry_type      VARCHAR(50) NOT NULL,
    -- 'topup', 'auth_hold', 'auth_release', 'capture', 'refund', 'mpp_debit'
    amount_cents    BIGINT NOT NULL,  -- positive = credit to wallet, negative = debit
    running_balance BIGINT NOT NULL,  -- balance after this entry
    reference_type  VARCHAR(50),      -- 'lithic_authorization', 'lithic_transaction', 'stripe_checkout', 'mpp_payment'
    reference_id    VARCHAR(255),     -- Lithic token / Stripe object ID / MPP payment ID
    description     TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_ledger_wallet_created ON ledger_entries(wallet_id, created_at DESC);

-- Virtual cards (Lithic)
CREATE TABLE virtual_cards (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID NOT NULL REFERENCES wallets(id),
    lithic_card_token   VARCHAR(255) UNIQUE NOT NULL,  -- Lithic's card token
    last_four           VARCHAR(4) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'active',
    -- 'active', 'paused', 'cancelled'
    spend_limit_cents   BIGINT,            -- Lithic-side spend limit (defense in depth)
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

-- Spending controls — evaluated during authorization
CREATE TABLE spending_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    rule_type       VARCHAR(50) NOT NULL,
    -- 'auto_approve_under', 'notify_over', 'block_category', 'daily_limit'
    value_cents     BIGINT,            -- threshold amount where applicable
    mcc_codes       VARCHAR(50)[],     -- merchant category codes to match
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Authorization log — every auth request + decision, for audit
CREATE TABLE authorization_log (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id               UUID NOT NULL REFERENCES wallets(id),
    card_id                 UUID NOT NULL REFERENCES virtual_cards(id),
    lithic_auth_token       VARCHAR(255) UNIQUE NOT NULL,  -- Lithic authorization token
    amount_cents            BIGINT NOT NULL,
    currency                VARCHAR(3) NOT NULL,
    merchant_name           VARCHAR(255),
    merchant_category       VARCHAR(10),
    decision                VARCHAR(20) NOT NULL,  -- 'approved', 'declined'
    decline_reason          VARCHAR(100),
    decided_in_ms           INTEGER,  -- track your latency
    agent_session_id        UUID REFERENCES agent_sessions(id),
    created_at              TIMESTAMPTZ DEFAULT now()
);

-- Agent sessions — which agents are authorized to use this wallet
CREATE TABLE agent_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    agent_name      VARCHAR(255),      -- 'claude-desktop', 'cursor', etc.
    api_key_hash    VARCHAR(255) NOT NULL,  -- hashed bearer token
    scopes          VARCHAR(50)[] DEFAULT '{read_balance,use_card}',
    is_active       BOOLEAN DEFAULT true,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now()
);
```

### Critical: The Balance Update Pattern

Never do `UPDATE wallets SET balance_cents = balance_cents - $amount`. Use optimistic locking:

```sql
-- In a transaction:
BEGIN;

SELECT balance_cents, held_cents, version
FROM wallets WHERE id = $wallet_id FOR UPDATE;

-- Application checks: available = balance_cents - held_cents >= auth_amount
-- Application checks: spending rules pass

UPDATE wallets
SET held_cents = held_cents + $amount,
    version = version + 1,
    updated_at = now()
WHERE id = $wallet_id AND version = $current_version;
-- If 0 rows updated, retry (concurrent modification)

INSERT INTO ledger_entries (...) VALUES (...);

COMMIT;
```

---

## Lithic Authorization Flow (Auth Stream Access)

Lithic's equivalent of Stripe's `issuing_authorization.request` is called **ASA (Auth Stream Access)**. You register a webhook URL and Lithic POSTs every authorization attempt to it. You respond with `APPROVE` or `DECLINE`. You get **~5 seconds** (more generous than Stripe's ~2s window, but same principle: keep it fast and don't introduce external calls).

```
Agent calls MCP tool: get_card_details
         │
         ▼
Agent uses card on any website (Visa/Mastercard network)
         │
         ▼
Lithic receives charge attempt via card network
         │
         ▼
Lithic sends POST to your ASA webhook URL
         │                                    ⏱️ ~5 second window
         ▼
┌─────────────────────────────────────────┐
│  YOUR AUTHORIZATION SERVICE             │
│                                         │
│  1. Verify HMAC webhook signature       │
│  2. Look up card_token → wallet         │
│  3. Check card status (active/paused)   │
│  4. Check available balance ≥ amount    │
│  5. Evaluate spending rules             │
│     - auto_approve_under threshold      │
│     - daily limit not exceeded          │
│     - MCC not blocked                   │
│  6. If all pass → approve + hold funds  │
│  7. If any fail → decline + log reason  │
│  8. If amount > notify_over → push notif│
└─────────────────────────────────────────┘
         │
         ▼
Respond to Lithic: { result: "APPROVE" } or { result: "DECLINE" }
         │
         ▼
Later: transaction.settled webhook event
         │
         ▼
Convert hold → settled (move from held_cents to actual debit)
```

### Lithic ASA Response Format

```json
// Approve
{ "result": "APPROVE" }

// Decline
{ "result": "DECLINE", "reason": "INSUFFICIENT_FUNDS" }
```

### Webhook Events You Need

| Lithic Event | What You Do |
|---|---|
| ASA webhook (POST to your URL) | **Real-time decision.** Check balance, rules, approve/decline. Place hold. |
| `authorization.updated` | Authorization amount changed. Adjust hold. |
| `transaction.settled` | Charge captured/settled. Convert hold to settled debit in ledger. |
| `transaction.voided` | Merchant voided the charge. Release hold, credit wallet. |
| `dispute.created` | Chargeback initiated. Flag in dashboard, potentially credit wallet. |
| Stripe: `checkout.session.completed` | Top-up payment via Stripe Checkout succeeded. Credit wallet. |

### Latency Budget (5 seconds total, target <200ms)

| Step | Target |
|---|---|
| Webhook receipt + HMAC verification | 50ms |
| Card token → wallet lookup (indexed) | 10ms |
| Balance check + rule evaluation | 20ms |
| Ledger write + balance update | 50ms |
| Response to Lithic | 10ms |
| **Total** | **~140ms** |

You have even more headroom than with Stripe. Same rule applies: don't introduce anything async or external in this path. No network calls to third-party services. No AI inference. Pure DB lookups and business logic.

### Lithic Card Creation (on user signup)

```typescript
import Lithic from "lithic";

const lithic = new Lithic({ apiKey: process.env.LITHIC_API_KEY });

// 1. Create an account holder (KYC — Lithic handles this)
const accountHolder = await lithic.accountHolders.create({
  workflow: "KYC_BASIC",  // or KYC_BYO if you handle KYC yourself
  individual: {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane@example.com",
    phone_number: "+353...",
    address: { ... },
    dob: "1990-01-15",
  },
});

// 2. Create a virtual card
const card = await lithic.cards.create({
  type: "VIRTUAL",
  account_token: accountHolder.account_token,
  spend_limit: 50000,      // $500.00 Lithic-side limit (defense in depth)
  spend_limit_duration: "MONTHLY",
  state: "OPEN",
});

// card.token → store as lithic_card_token
// card.pan, card.cvv, card.exp_month, card.exp_year → return to agent via MCP
```

---

## MCP Server Design

### Protocol

MCP uses JSON-RPC 2.0 over stdio (for local agents like Claude Desktop) or SSE/HTTP (for remote agents). Your server exposes tools that agents can discover and call.

### Tools to Expose

```typescript
// Tool 1: Get card details for making a purchase
{
  name: "get_payment_card",
  description: "Get virtual card details to make a purchase. Returns card number, expiry, CVC.",
  inputSchema: {
    type: "object",
    properties: {
      purpose: {
        type: "string",
        description: "Brief description of what the purchase is for"
      },
      estimated_amount_cents: {
        type: "number",
        description: "Estimated purchase amount in cents"
      }
    },
    required: ["purpose"]
  }
}

// Tool 2: Check balance
{
  name: "check_balance",
  description: "Check available wallet balance before attempting a purchase.",
  inputSchema: { type: "object", properties: {} }
}

// Tool 3: List recent transactions
{
  name: "list_transactions",
  description: "View recent transactions and their status.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", default: 10 }
    }
  }
}

// Tool 4: MPP payment (Rail 2)
{
  name: "pay_via_mpp",
  description: "Pay a merchant directly via Machine Payment Protocol. Use this when the merchant supports MPP for lower fees and instant settlement.",
  inputSchema: {
    type: "object",
    properties: {
      merchant_mpp_address: { type: "string" },
      amount_cents: { type: "number" },
      currency: { type: "string", default: "USD" },
      description: { type: "string" }
    },
    required: ["merchant_mpp_address", "amount_cents"]
  }
}
```

### Security Model

Exposing full card details (PAN, CVC) to an AI agent is your biggest security surface. Mitigations:

1. **Per-session API keys** — Each agent session gets a unique bearer token. Scoped to specific capabilities.
2. **Spending rules as guardrails** — Even if a rogue agent gets the card, it can only spend within the user's pre-set rules.
3. **Card detail caching** — Don't let the MCP tool return card details more than needed. Consider returning them once per session and having the agent cache in context.
4. **Lithic's built-in controls** — Use Lithic's `spend_limit` and `spend_limit_duration` on the card itself as a second layer. Also supports MCC restrictions via auth rules.
5. **Future: ephemeral card numbers** — Lithic supports creating `SINGLE_USE` virtual cards or merchant-locked cards. Phase 2 feature, but architecturally plan for it.

### MCP Server Structure

```
agent-wallet-mcp/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── tools/
│   │   ├── get-payment-card.ts
│   │   ├── check-balance.ts
│   │   ├── list-transactions.ts
│   │   └── pay-via-mpp.ts
│   ├── auth/
│   │   └── session.ts        # API key validation, session management
│   ├── db/
│   │   ├── client.ts         # Postgres connection
│   │   ├── schema.ts         # Drizzle schema definitions
│   │   └── queries.ts        # Wallet/card/ledger queries
│   ├── lithic/
│   │   └── client.ts         # Lithic SDK wrapper (card creation, card details)
│   └── stripe/
│       └── client.ts         # Stripe SDK wrapper (Checkout top-ups, MPP)
├── package.json
└── tsconfig.json
```

---

## How MPP Sits Alongside the Card Rail

```
                    Agent needs to pay for something
                              │
                              ▼
                    Does merchant support MPP?
                     ╱                    ╲
                   YES                     NO
                    │                       │
                    ▼                       ▼
            pay_via_mpp tool        get_payment_card tool
                    │                       │
                    ▼                       ▼
            Direct MPP payment      Agent uses card on website
                    │                       │
                    ▼                       ▼
            Instant settlement      Lithic ASA webhook flow
            Lower fees (~0.1%)      Card network fees (~2-3%)
                    │                       │
                    ▼                       ▼
            Debit wallet             Hold → Capture → Debit
            immediately              wallet
                    │                       │
                    └───────┬───────────────┘
                            ▼
                    Same ledger, same rules,
                    same balance, same dashboard
```

The key architectural decision: **both rails share the same wallet, ledger, and spending rules engine.** The rail is an implementation detail. The user sees one balance and one transaction history.

For MPP specifically:
- The MCP tool makes a direct API call to Stripe's MPP endpoint
- No 2-second webhook window — you control the flow
- Debit the wallet synchronously before confirming payment
- Same spending rules apply
- Same ledger entry format, just different `reference_type`

---

## Recommended Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | Stripe SDK, MCP SDK, and your whole stack in one language. Solo founder — minimize context switching. |
| Runtime | Node.js (Bun if adventurous) | MCP SDK is built for Node. Bun gives faster startup. |
| API framework | Hono | Lightweight, fast, great TypeScript. Not over-engineered like Express, not opinionated like Next API routes. |
| Database | PostgreSQL (Neon or Supabase) | ACID for money. Neon has branching for dev/staging. Both have generous free tiers. |
| ORM | Drizzle | Type-safe, SQL-like, no magic. You want to see the SQL when dealing with money. |
| Cache | Upstash Redis | Rate limiting, session caching. Serverless-friendly. |
| Dashboard | Next.js | Server components for the user dashboard. Same TS stack. |
| Auth | Clerk or Auth.js | Don't build auth. Solo founder. Ship faster. |
| Hosting | Railway or Fly.io | The webhook server needs to be always-on (not serverless cold starts — you have a 5-second window but cold starts still waste time). Railway is simplest for Postgres + long-running Node. |
| Monitoring | Sentry + Axiom | Errors + structured logging. Non-negotiable for financial operations. |

### Why NOT serverless for the webhook

Vercel Functions / AWS Lambda cold starts can be 500ms–2s. Your Lithic ASA authorization webhook has a 5-second budget, but a cold start still wastes valuable time and adds unreliability. Use a long-running server for the webhook endpoint. The dashboard can be serverless.

---

## MVP Scope — Smallest Shippable Thing

### Phase 0: Build Now (Lithic Sandbox Available Immediately)

1. **Sign up for Lithic sandbox** — API keys available today, no approval wait. Start integrating immediately.
2. **Wallet ledger + spending rules engine** — Pure business logic. Write exhaustive tests. Money bugs are existential.
3. **MCP server with sandbox card** — Use Lithic sandbox to create test virtual cards. Test with Claude Desktop. Prove the agent UX works end-to-end.
4. **Authorization decision service** — Takes an ASA webhook, evaluates rules, returns approve/decline. Wire to ledger. Lithic sandbox sends test auth events.
5. **Landing page + waitlist** — Explain the N+1 problem. Collect emails.
6. **Demo video** — Record Claude using your MCP tool to "buy" something. This is gold for YC and co-founder matching.

### Phase 1: MVP (Lithic Production Access)

Lithic production approval is simpler than Stripe Issuing — no BaaS tier, but you still need KYB (Know Your Business) approval. Apply while building in sandbox.

1. Stripe Checkout for top-ups (simplest — hosted payment page)
2. Create one Lithic virtual card per user on signup (with KYC handled by Lithic)
3. Wire the real ASA authorization webhook
4. MCP server returning real card details from Lithic
5. Minimal dashboard: balance, transaction list, three controls (auto-approve threshold, notification threshold, pause card)
6. **Ship to 5–10 alpha users**

### Phase 2: Growth

1. MPP rail integration (Stripe MPP)
2. Per-agent budgets (give Claude $5/month, give Cursor $20/month)
3. Ephemeral card numbers via Lithic `SINGLE_USE` cards (one per merchant or per transaction)
4. Team wallets with shared budgets
5. Usage analytics and spend reports
6. Zapier/webhook integrations for enterprise

### What "done" looks like for MVP

A user signs up, adds $20 via Stripe Checkout, opens Claude Desktop, the agent can see the wallet MCP tools, asks Claude to "buy me a Sora video," Claude calls `get_payment_card`, uses the card on OpenAI, the authorization is approved, user sees the transaction in their dashboard, gets a push notification. That's it. That's the MVP.

---

## What to Build This Week

Prioritized list — the key difference from before is that **Lithic sandbox is available today**. No waiting. You can integrate against real APIs from day one.

**Week 1:**
- Sign up for Lithic sandbox, get API keys
- Set up the repo (monorepo with Turborepo: `packages/db`, `packages/mcp-server`, `apps/api`, `apps/dashboard`)
- Postgres schema + Drizzle migrations
- Wallet service: `topUp()`, `checkBalance()`, `placeHold()`, `captureHold()`, `releaseHold()`
- 100% test coverage on wallet operations

**Week 2:**
- Spending rules engine: `evaluateAuthorization(wallet, amount, merchantCategory) → {approved, reason}`
- Lithic ASA webhook handler (using sandbox test events — real Lithic integration, not mocks)
- MCP server skeleton with `check_balance` and `get_payment_card` (using Lithic sandbox cards)
- Create test virtual cards via Lithic sandbox API

**Week 3:**
- Test MCP server with Claude Desktop locally (sandbox card details)
- Landing page (can be a simple Next.js page)
- Demo video: screen recording of agent making a purchase via sandbox
- Start co-founder outreach with the demo
- Apply for Lithic production access (KYB process)

**Week 4:**
- Dashboard UI: sign up, see balance, see transactions, toggle controls
- Stripe Checkout integration for top-ups (this is independent of Lithic)
- When Lithic production access lands: swap sandbox keys for production

---

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| ~~Stripe Issuing rejection~~ | ~~Critical~~ | **Resolved.** Moved to Lithic. No $10-20k/month platform fee. Pay-per-transaction pricing. |
| Lithic production KYB rejection | Medium | Lithic is more startup-friendly than Stripe BaaS. Fallback: Marqeta startup program or Privacy.com API. |
| Double-spend bug | Critical | Serializable transactions + optimistic locking + extensive testing + ledger reconciliation job. |
| Agent leaks card details | High | Per-session scoping, spending rules as guardrails, Lithic `SINGLE_USE` cards in Phase 2. |
| 5-second ASA webhook timeout | Low | Long-running server, no cold starts, keep auth path lean (<200ms). More headroom than Stripe's 2s. |
| PCI compliance overhead | Medium | Lithic handles PAN storage and issuance. You only handle card details in transit via their SDK. Review PCI SAQ-A requirements. |
| Two-vendor complexity (Lithic + Stripe) | Low | Clean separation: Lithic = card issuing, Stripe = top-ups + MPP. Different domains, minimal overlap. |
| Solo founder burnout | High | Ruthless MVP scoping. Don't build Phase 2 features. Ship and learn. |