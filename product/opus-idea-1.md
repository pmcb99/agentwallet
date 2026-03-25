# Agent Wallet — Technical Architecture

## Core Insight

The authorization webhook is the critical path. When an agent uses the virtual card anywhere Visa works, Stripe sends an `issuing_authorization.request` and you have **~2 seconds** to approve or decline. Everything in the architecture radiates outward from making that decision fast and correct.

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
    stripe_customer_id VARCHAR(255) UNIQUE,
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
    reference_type  VARCHAR(50),      -- 'stripe_authorization', 'stripe_transaction', 'mpp_payment'
    reference_id    VARCHAR(255),     -- Stripe object ID or MPP payment ID
    description     TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_ledger_wallet_created ON ledger_entries(wallet_id, created_at DESC);

-- Virtual cards (Stripe Issuing)
CREATE TABLE virtual_cards (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID NOT NULL REFERENCES wallets(id),
    stripe_card_id      VARCHAR(255) UNIQUE NOT NULL,
    last_four           VARCHAR(4) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'active',
    -- 'active', 'paused', 'cancelled'
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
    stripe_authorization_id VARCHAR(255) UNIQUE NOT NULL,
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

## Stripe Issuing Authorization Flow

```
Agent calls MCP tool: get_card_details
         │
         ▼
Agent uses card on any website (Visa network)
         │
         ▼
Stripe receives charge attempt
         │
         ▼
Stripe sends POST to your webhook: issuing_authorization.request
         │                                    ⏱️ ~2 second window
         ▼
┌─────────────────────────────────────────┐
│  YOUR AUTHORIZATION SERVICE             │
│                                         │
│  1. Verify webhook signature            │
│  2. Look up card → wallet               │
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
Respond to Stripe: { approved: true/false }
         │
         ▼
Later: issuing_transaction.created webhook
         │
         ▼
Convert hold → settled (move from held_cents to actual debit)
```

### Webhook Endpoints You Need

| Webhook Event | What You Do |
|---|---|
| `issuing_authorization.request` | **Real-time decision.** Check balance, rules, approve/decline. Place hold. |
| `issuing_authorization.updated` | Authorization amount changed (e.g., tip added). Adjust hold. |
| `issuing_transaction.created` | Charge captured. Convert hold to settled debit in ledger. |
| `issuing_transaction.updated` | Refund or dispute. Credit wallet, add ledger entry. |
| `checkout.session.completed` | Top-up payment succeeded. Credit wallet. |

### Latency Budget (2 seconds total)

| Step | Target |
|---|---|
| Webhook receipt + signature verification | 50ms |
| Card → wallet lookup (indexed) | 10ms |
| Balance check + rule evaluation | 20ms |
| Ledger write + balance update | 50ms |
| Response to Stripe | 10ms |
| **Total** | **~140ms** |

You have massive headroom. Don't introduce anything async or external in this path. No network calls to third-party services. No AI inference. Pure DB lookups and business logic.

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
4. **Stripe's built-in controls** — Use Stripe Issuing's spending controls as a second layer (MCC restrictions, per-authorization limits).
5. **Future: ephemeral card numbers** — Stripe supports creating single-use or merchant-locked virtual cards. Phase 2 feature, but architecturally plan for it.

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
│   └── stripe/
│       └── client.ts         # Stripe SDK wrapper
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
            Instant settlement      Stripe auth webhook flow
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
| Hosting | Railway or Fly.io | The webhook server needs to be always-on (not serverless cold starts — you have a 2-second window). Railway is simplest for Postgres + long-running Node. |
| Monitoring | Sentry + Axiom | Errors + structured logging. Non-negotiable for financial operations. |

### Why NOT serverless for the webhook

Vercel Functions / AWS Lambda cold starts can be 500ms–2s. Your authorization webhook has a 2-second budget. A cold start could blow your entire budget before your code runs. Use a long-running server for the webhook endpoint. The dashboard can be serverless.

---

## MVP Scope — Smallest Shippable Thing

### Phase 0: Build Now (No Stripe Issuing Needed)

1. **Wallet ledger + spending rules engine** — Pure business logic. No Stripe dependency. Write exhaustive tests. Money bugs are existential.
2. **MCP server with mock card** — Return fake card details. Test with Claude Desktop. Prove the agent UX works end-to-end.
3. **Authorization decision service** — Takes an auth request, evaluates rules, returns approve/decline. Wire to ledger. Test with mock webhooks.
4. **Landing page + waitlist** — Explain the N+1 problem. Collect emails.
5. **Demo video** — Record Claude using your MCP tool to "buy" something. This is gold for YC and co-founder matching.

### Phase 1: MVP (When Stripe Issuing Approved)

1. Stripe Checkout for top-ups (simplest — hosted payment page)
2. Create one virtual card per user on signup
3. Wire the real authorization webhook
4. MCP server returning real card details
5. Minimal dashboard: balance, transaction list, three controls (auto-approve threshold, notification threshold, pause card)
6. **Ship to 5–10 alpha users**

### Phase 2: Growth

1. MPP rail integration
2. Per-agent budgets (give Claude $5/month, give Cursor $20/month)
3. Ephemeral card numbers (one per merchant or per transaction)
4. Team wallets with shared budgets
5. Usage analytics and spend reports
6. Zapier/webhook integrations for enterprise

### What "done" looks like for MVP

A user signs up, adds $20 via Stripe Checkout, opens Claude Desktop, the agent can see the wallet MCP tools, asks Claude to "buy me a Sora video," Claude calls `get_payment_card`, uses the card on OpenAI, the authorization is approved, user sees the transaction in their dashboard, gets a push notification. That's it. That's the MVP.

---

## What to Build This Week

Prioritized list assuming Stripe Issuing takes 1–4 weeks:

**Week 1:**
- Set up the repo (monorepo with Turborepo: `packages/db`, `packages/mcp-server`, `apps/api`, `apps/dashboard`)
- Postgres schema + Drizzle migrations
- Wallet service: `topUp()`, `checkBalance()`, `placeHold()`, `captureHold()`, `releaseHold()`
- 100% test coverage on wallet operations

**Week 2:**
- Spending rules engine: `evaluateAuthorization(wallet, amount, merchantCategory) → {approved, reason}`
- Authorization webhook handler (with mock Stripe events)
- MCP server skeleton with `check_balance` and `get_payment_card` (mock)

**Week 3:**
- Test MCP server with Claude Desktop locally
- Landing page (can be a simple Next.js page)
- Demo video: screen recording of agent making a purchase
- Start co-founder outreach with the demo

**Week 4:**
- Dashboard UI: sign up, see balance, see transactions, toggle controls
- Stripe Checkout integration for top-ups (this works without Issuing)
- When Issuing access lands: wire real card creation + webhook

---

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| Stripe Issuing rejection | Critical | Have backup plan with Lithic or Marqeta. API is similar. |
| Double-spend bug | Critical | Serializable transactions + optimistic locking + extensive testing + ledger reconciliation job. |
| Agent leaks card details | High | Per-session scoping, spending rules as guardrails, ephemeral cards in Phase 2. |
| 2-second webhook timeout | Medium | Long-running server, no cold starts, keep auth path lean (<200ms). |
| PCI compliance overhead | Medium | Stripe handles PAN storage. You only handle card details in transit via their SDK. Review PCI SAQ-A requirements. |
| Solo founder burnout | High | Ruthless MVP scoping. Don't build Phase 2 features. Ship and learn. |