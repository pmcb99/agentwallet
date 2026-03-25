# Ubiquitous Language

## Wallet & Balance

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Wallet** | A single-currency store of value owned by one Account, tracking available and held funds | Purse, balance, fund |
| **Balance** | The total amount credited to a Wallet, before subtracting Holds | Funds, credits |
| **Available Balance** | Balance minus all active Holds — the amount actually spendable | Free balance, remaining |
| **Hold** | A temporary reservation of funds against a Wallet, placed when an Authorization is approved | Pending charge, reserved funds, auth hold |
| **Top-up** | A user-initiated deposit into their Wallet via Stripe Checkout | Deposit, fund, load, add funds |

## Authorization & Rules

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Authorization** | A real-time request from the card issuer to approve or decline a purchase attempt | Auth, charge attempt, transaction request |
| **ASA Webhook** | The HTTP POST from the card issuer delivering an Authorization for a real-time approve/decline decision | Auth Stream Access, authorization webhook, issuing_authorization.request |
| **Spending Rule** | A user-configured constraint evaluated during Authorization to produce an approve or decline decision | Policy, limit, control, guard |
| **Auto-approve Threshold** | A Spending Rule that approves any Authorization under a specified amount | Auto-approve under |
| **Notify-over Threshold** | A Spending Rule that approves the Authorization but fires a Notification when the amount exceeds a specified value | Notification threshold |
| **Category Block** | A Spending Rule that declines any Authorization matching a blocked Merchant Category Code | MCC block, block category |
| **Daily Limit** | A Spending Rule that declines Authorizations once total approved spend in a calendar day exceeds a specified amount | Daily cap, daily spend limit |
| **Decision** | The outcome of evaluating all Spending Rules against an Authorization — either "approved" or "declined" with a reason | Verdict, result |

## Cards & Issuing

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Virtual Card** | A card number (PAN, expiry, CVC) issued by the card issuer and associated with a Wallet | Card, payment card, card details |
| **Card Issuer** | The third-party provider that issues Virtual Cards and routes Authorizations (e.g., Lithic, Enfuce) | Issuing provider, BIN sponsor, issuer |
| **Mock Card** | A fake Virtual Card returned by the MCP Server in the demo/sandbox build | Test card, dummy card, fake card |

## Transactions & Ledger

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Transaction** | A settled charge — the final capture of a previously authorized Hold | Charge, payment, settled transaction |
| **Ledger Entry** | An immutable record of a financial event against a Wallet (top-up, hold, capture, refund, etc.) | Log entry, record, journal entry |
| **Notification** | An in-dashboard alert triggered by a Notify-over Threshold rule firing | Alert, push notification, toast |

## Agents & MCP

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Agent** | An AI system (e.g., Claude Desktop) that uses MCP Tools to interact with a Wallet | Bot, AI, assistant |
| **MCP Server** | The JSON-RPC 2.0 server exposing Wallet Tools to Agents | Tool server, plugin |
| **MCP Tool** | A single capability exposed by the MCP Server that an Agent can invoke (e.g., `get_payment_card`, `check_balance`) | Function, action, endpoint |
| **Agent Session** | A scoped, authenticated connection between an Agent and a Wallet, identified by a bearer token | API key, connection, session |

## Actors

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Account** | A human user's identity in the system, owning one Wallet | User, customer, profile |
| **Merchant** | The external business where the Agent attempts a purchase | Vendor, seller, store |
| **Merchant Category Code (MCC)** | A four-digit code classifying a Merchant's business type, used by Category Block rules | Category, merchant type |

## Payment Rails

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Card Rail** | The payment path where an Agent uses a Virtual Card on the Visa/Mastercard network, routed through the Card Issuer's ASA Webhook | Card network, traditional rail |
| **MPP Rail** | The Machine Payment Protocol path where an Agent pays a merchant directly via Stripe MPP, bypassing the card network | Direct payment, Rail 2 |

## Relationships

- An **Account** owns exactly one **Wallet**
- A **Wallet** has one or more **Virtual Cards**
- A **Wallet** has zero or more **Spending Rules**
- An **Authorization** is evaluated against all active **Spending Rules** to produce a **Decision**
- An approved **Authorization** creates a **Hold** and a **Ledger Entry**
- A **Hold** converts to a **Transaction** when the charge settles
- A **Transaction** creates a **Ledger Entry**
- An **Agent Session** is scoped to one **Wallet**
- A **Notification** is triggered by a **Notify-over Threshold** rule during an approved **Authorization**

## Example dialogue

> **Dev:** "When an **Agent** calls `get_payment_card`, does that create an **Authorization**?"
> **Domain expert:** "No. The **MCP Tool** just returns the **Virtual Card** details. The **Authorization** only happens later, when the **Agent** actually uses those details on a **Merchant**'s checkout — the card network routes it to our **ASA Webhook**."
> **Dev:** "And if the **Account** has a **Daily Limit** of $30 and the **Agent** has already spent $25 today, a $10 **Authorization** gets declined?"
> **Domain expert:** "Exactly. The **Decision** is 'declined' with reason 'daily limit exceeded'. The **Ledger Entry** still gets written for audit, but no **Hold** is placed."
> **Dev:** "What about **Notify-over Threshold** — does that ever block a purchase?"
> **Domain expert:** "Never. It approves the **Authorization**, places the **Hold**, and fires a **Notification** to the dashboard. The **Account** owner sees it in real time via WebSocket. It's informational, not a gate."

## Flagged ambiguities

- **"Transaction"** was used loosely in conversation to mean both an Authorization attempt and a settled charge. In this glossary, **Authorization** is the real-time request, **Transaction** is the settled result. The dashboard "transaction list" shows both, but they are distinct lifecycle stages.
- **"Card"** was used to mean both the Virtual Card object and the card details (PAN/CVC/expiry). Prefer **Virtual Card** for the entity and "card details" when referring to the sensitive data returned by the MCP Tool.
- **"Webhook"** was used generically. Prefer **ASA Webhook** for the real-time authorization decision endpoint, and name other webhook events explicitly (e.g., `transaction.settled`, `checkout.session.completed`).
- **"Rules"** was used interchangeably with "controls" in the dashboard context. Prefer **Spending Rules** everywhere.
