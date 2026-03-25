# PRD: Agent Wallet — Weekend MVP

## Problem Statement

AI agents (e.g., Claude Desktop, Cursor) cannot make purchases on behalf of users. There is no product that gives a human a wallet with spending controls and gives their AI agent a virtual card to spend from it. The user has no way to say "here's $50, buy what you need, but don't spend more than $20 at a time and don't touch gambling sites" and have that enforced programmatically.

This weekend MVP needs to prove three things:
1. An Agent can use an MCP Tool to retrieve card details and trigger a purchase flow
2. A human can configure Spending Rules that constrain what the Agent can spend, and those rules are enforced in real time
3. The concept is compelling enough to validate market demand (by showing the demo to potential co-founders, investors, and early users)

## Solution

A working demo system consisting of:

- An **MCP Server** that exposes wallet tools to AI agents (Claude Desktop)
- A **Wallet** with a balance, holds, and a spending rules engine backed by SQLite
- A simulated **ASA Webhook** endpoint that evaluates Authorizations against Spending Rules and approves or declines in real time
- A **Next.js Dashboard** where the Account owner can see their balance, transactions, Spending Rules, and live Notifications — updated in real time via WebSocket
- A **parameterized demo seeder** that pre-loads a scripted demo flow, configurable for future variations

Card details are mocked. No real Card Issuer integration. No user authentication. No real payments. The product proves the control loop, not the payment rail.

## User Stories

### Account Owner (Human)

1. As an Account owner, I want to see my Wallet balance and available balance on the dashboard, so that I know how much my Agent can spend
2. As an Account owner, I want to see a list of all Authorizations (approved and declined) with merchant name, amount, and Decision reason, so that I have full visibility into what my Agent is doing with my money
3. As an Account owner, I want to create an Auto-approve Threshold rule (e.g., "approve anything under $20"), so that low-value purchases go through without friction
4. As an Account owner, I want to create a Notify-over Threshold rule (e.g., "notify me for anything over $10"), so that I'm alerted to significant spend even when it's approved
5. As an Account owner, I want to create a Category Block rule for specific MCCs (e.g., "block gambling"), so that my Agent cannot spend in categories I don't trust
6. As an Account owner, I want to create a Daily Limit rule (e.g., "$30/day max"), so that runaway Agent spending is capped
7. As an Account owner, I want to edit any existing Spending Rule, so that I can adjust thresholds as I learn what my Agent needs
8. As an Account owner, I want to delete a Spending Rule, so that I can remove constraints that are no longer needed
9. As an Account owner, I want to see Notifications in a panel on the dashboard when a Notify-over Threshold fires, so that I'm aware of significant purchases in real time
10. As an Account owner, I want the transaction list and balance to update in real time (without page refresh) when an Authorization is processed, so that I have a live view of Agent activity
11. As an Account owner, I want to see why an Authorization was declined (e.g., "daily limit exceeded", "blocked category: gambling"), so that I can adjust rules if the decline was unintended
12. As an Account owner, I want to see the timestamp and merchant name on each Notification, so that I have context on what triggered the alert

### Agent (AI)

13. As an Agent, I want to call `check_balance` via MCP to see the Wallet's available balance, so that I can decide whether a purchase is feasible before attempting it
14. As an Agent, I want to call `get_payment_card` via MCP to retrieve card details (PAN, expiry, CVC), so that I can use them to make a purchase on a merchant's website
15. As an Agent, I want `get_payment_card` to accept a `purpose` parameter, so that the Authorization log records why the card was requested

### Demo Operator

16. As a demo operator, I want to run a seed script that pre-loads a Wallet with a configurable balance and set of Spending Rules, so that I can start a demo without manual setup
17. As a demo operator, I want the seed script to support a default demo flow ($50 balance, 4 rules, 3 scripted Authorization attempts), so that I have a repeatable demo out of the box
18. As a demo operator, I want to override seed parameters (balance, rules, scenarios) via CLI arguments, so that I can tailor the demo for different audiences
19. As a demo operator, I want to simulate an ASA Webhook call (as if an Agent had used the card at a merchant) via a CLI command or API call, so that I can trigger Authorizations without needing the Agent to actually complete a checkout

## Implementation Decisions

### Architecture

- **Monorepo with three packages:** `wallet-core` (business logic), `auth-service` (Hono API + WebSocket), `mcp-server` (MCP tool server), plus `dashboard` (Next.js app) and `demo-seed` (CLI script)
- **SQLite** via Drizzle ORM for persistence. Single database file. No Postgres for the weekend build.
- **Hono** for the API server — handles the ASA Webhook endpoint, REST endpoints for dashboard CRUD, and WebSocket upgrade for real-time updates
- **Next.js** for the dashboard — server components where possible, client components for WebSocket-driven live updates
- **WebSocket** from auth-service to dashboard for real-time transaction and Notification delivery

### Module: `wallet-core`

- Pure business logic with a clean interface — no HTTP, no framework dependencies
- Functions: `topUp(walletId, amountCents)`, `checkBalance(walletId)`, `placeHold(walletId, amountCents, metadata)`, `captureHold(holdId)`, `releaseHold(holdId)`
- Spending Rules engine: `evaluateAuthorization(walletId, amountCents, mcc) → { decision: 'approved' | 'declined', reason: string, notifications: Notification[] }`
- Rule evaluation order: Category Block, Daily Limit, Auto-approve Threshold — first decline wins. Notify-over Threshold is collected separately and never blocks.
- CRUD operations for Spending Rules: `createRule()`, `updateRule()`, `deleteRule()`, `listRules(walletId)`
- Drizzle + SQLite for storage, but the module interface does not expose database details

### Module: `auth-service`

- Hono HTTP server
- `POST /webhook/asa` — simulated ASA Webhook endpoint. Accepts an Authorization request (amount, currency, merchant name, MCC, card token). Calls `wallet-core.evaluateAuthorization()`, places Hold or declines, writes Authorization log, emits WebSocket event
- `GET /api/balance/:walletId` — returns current balance and available balance
- `GET /api/transactions/:walletId` — returns Authorization log entries
- `GET/POST/PUT/DELETE /api/rules/:walletId` — CRUD for Spending Rules (delegates to `wallet-core`)
- `GET /api/notifications/:walletId` — returns Notification history
- WebSocket endpoint — broadcasts Authorization decisions and Notifications to connected dashboard clients

### Module: `mcp-server`

- MCP SDK, JSON-RPC 2.0 over stdio
- `get_payment_card` tool — accepts `purpose` (required) and `estimated_amount_cents` (optional), returns mock card details (hardcoded PAN, expiry, CVC). Logs the purpose.
- `check_balance` tool — calls `wallet-core.checkBalance()`, returns available balance

### Module: `dashboard`

- Next.js app
- Pages/sections: Balance display, Transaction list (with Decision and reason), Spending Rules management (create/edit/delete for all 4 types), Notification panel
- WebSocket client connects to auth-service on load — updates transaction list, balance, and Notification panel in real time
- No authentication — single Account, single Wallet for the weekend build

### Module: `demo-seed`

- CLI script (can be run via `npx tsx` or similar)
- Default parameters: $50 balance, 4 rules (auto-approve under $20, notify over $10, block gambling MCC 7995, daily limit $30)
- Default demo scenario: 3 simulated Authorizations — $15 approved + notification, $25 declined (exceeds auto-approve), $5 at MCC 7995 declined (blocked category)
- All parameters overridable via CLI flags
- Calls `wallet-core` directly for seeding, calls `POST /webhook/asa` for simulated Authorizations

### Schema (SQLite via Drizzle)

- `wallets` — id, balance_cents, held_cents, currency, version, created_at, updated_at
- `ledger_entries` — id, wallet_id, entry_type, amount_cents, running_balance, reference_type, reference_id, description, metadata (JSON), created_at
- `virtual_cards` — id, wallet_id, last_four, status, created_at, updated_at
- `spending_rules` — id, wallet_id, rule_type, value_cents, mcc_codes (JSON array), is_active, created_at
- `authorization_log` — id, wallet_id, card_id, amount_cents, currency, merchant_name, merchant_category, decision, decline_reason, decided_in_ms, created_at
- `notifications` — id, wallet_id, authorization_log_id, rule_id, message, read (boolean), created_at

### WebSocket Event Format

- `{ type: "authorization", data: { ...authorizationLogEntry } }` — fired on every Authorization Decision
- `{ type: "notification", data: { ...notification } }` — fired when a Notify-over Threshold triggers
- `{ type: "balance_update", data: { balance_cents, held_cents, available_cents } }` — fired after any balance change

## Testing Decisions

### What makes a good test

Tests should verify external behavior through the module's public interface. They should not depend on internal implementation details like specific SQL queries, internal function signatures, or private state. A test should break only when the module's behavior changes, not when its internals are refactored.

### `wallet-core` tests

- **Balance operations:** top-up increases balance, check balance returns correct available (balance minus holds), top-up with zero/negative amount is rejected
- **Hold lifecycle:** place hold reduces available balance, capture hold converts to debit, release hold restores available balance, hold on insufficient available balance is rejected
- **Optimistic locking:** concurrent hold attempts on the same wallet — one succeeds, one retries or fails cleanly
- **Spending Rule evaluation — Auto-approve Threshold:** amount under threshold approved, amount equal to threshold approved, amount over threshold declined
- **Spending Rule evaluation — Daily Limit:** authorization within daily limit approved, authorization that would exceed daily limit declined, daily limit resets (or is calculated from today's entries)
- **Spending Rule evaluation — Category Block:** authorization with blocked MCC declined, authorization with non-blocked MCC approved, multiple blocked MCCs
- **Spending Rule evaluation — Notify-over Threshold:** authorization over threshold approved AND returns a Notification, authorization under threshold approved with no Notification
- **Combined rules:** multiple rules active simultaneously — first decline wins, notifications still collected on approved authorizations
- **Rule CRUD:** create rule, update threshold, delete rule, deleted rule no longer evaluated

### `auth-service` tests

- **ASA Webhook endpoint:** POST with valid Authorization payload returns approved/declined, response includes decision reason, authorization log entry is written, WebSocket event is emitted
- **Balance endpoint:** returns correct balance after top-up, reflects held amounts
- **Rules CRUD endpoints:** create returns 201, update returns 200, delete returns 204, list returns all active rules
- **Notification endpoint:** returns notifications triggered by Notify-over, empty when no notifications
- **WebSocket:** client receives authorization event after webhook POST, client receives notification event when Notify-over fires, client receives balance_update after any balance change
- **Error cases:** webhook with missing fields returns 400, authorization for unknown card returns 404

## Out of Scope

- Real Card Issuer integration (Lithic, Enfuce, or any other provider)
- Real payment processing — no actual money moves
- Stripe Checkout top-ups — balance is seeded, not funded
- MPP Rail / Rail 2
- User authentication or multi-account support
- Postgres or production-grade database
- Double-entry ledger with full ACID guarantees (optimistic locking is implemented but not battle-tested)
- PCI compliance
- Ephemeral or single-use cards
- Per-agent budgets or multi-wallet
- Email/push notifications (in-dashboard only)
- Mobile responsiveness (desktop-first for demo)
- CI/CD, deployment, or hosting

## Further Notes

- The demo uses a pre-existing booking demo app (owned by the developer) as the fake merchant — no fake merchant app needs to be built
- The Card Issuer decision (Lithic for US, EU provider for EU) is deferred. This weekend build is issuer-agnostic by design — the ASA Webhook interface is generic enough to map to any provider later
- The developer is based in Ireland. The long-term plan leans EU for the user base, but this is not a weekend concern
- Terminology follows `UBIQUITOUS_LANGUAGE.md` in the repo root. Key distinction: **Authorization** is the real-time request, **Transaction** is the settled result. **Spending Rule** is the canonical term (not "control" or "policy").
- The parameterized demo seeder is important for longevity — the default flow proves the concept today, but the developer wants to reconfigure for different audiences without code changes
