"use client";

import { useEffect, useState, useCallback } from "react";
import { Dashboard } from "../components/dashboard";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const WALLET_ID = process.env.NEXT_PUBLIC_WALLET_ID ?? "demo-wallet";

type Balance = {
  balanceCents: number;
  heldCents: number;
  availableCents: number;
};

type Transaction = {
  id: string;
  merchantName: string;
  merchantCategory: string | null;
  amountCents: number;
  decision: string;
  declineReason: string | null;
  decidedInMs: number | null;
  createdAt: string;
};

type Rule = {
  id: string;
  ruleType: string;
  valueCents: number | null;
  mccCodes: string[] | null;
  isActive: boolean;
};

type Notification = {
  id: string;
  message: string;
  read: boolean | number;
  createdAt: string;
};

function formatCents(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function ruleLabel(rule: Rule) {
  switch (rule.ruleType) {
    case "auto_approve_threshold":
      return `Auto-approve under ${formatCents(rule.valueCents ?? 0)}`;
    case "notify_over":
      return `Notify over ${formatCents(rule.valueCents ?? 0)}`;
    case "category_block":
      return `Block MCC ${rule.mccCodes?.join(", ") ?? ""}`;
    case "daily_limit":
      return `Daily limit ${formatCents(rule.valueCents ?? 0)}`;
    default:
      return rule.ruleType;
  }
}

export default function Page() {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [balRes, txRes, rulesRes, notifRes] = await Promise.all([
        fetch(`${API}/api/balance/${WALLET_ID}`),
        fetch(`${API}/api/transactions/${WALLET_ID}`),
        fetch(`${API}/api/rules/${WALLET_ID}`),
        fetch(`${API}/api/notifications/${WALLET_ID}`),
      ]);

      if (balRes.ok) setBalance(await balRes.json());
      else setBalance(null);

      setTransactions(txRes.ok ? await txRes.json() : []);
      setRules(rulesRes.ok ? await rulesRes.json() : []);
      setNotifications(notifRes.ok ? await notifRes.json() : []);
      setError(null);
    } catch (e: any) {
      setError("Cannot reach API at " + API + ". Is auth-service running?");
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 3000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // WebSocket for real-time updates
  useEffect(() => {
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(API.replace("http", "ws") + "/ws");
      ws.onmessage = () => fetchAll();
      ws.onerror = () => {}; // fallback to polling
    } catch {
      // WebSocket not available, polling handles it
    }
    return () => ws?.close();
  }, [fetchAll]);

  const todayApproved = transactions.filter((t) => {
    const today = new Date().toISOString().slice(0, 10);
    return t.decision === "approved" && t.createdAt?.startsWith(today);
  }).length;

  const handleSeed = async () => {
    setSeeding(true);
    try {
      // Trigger seed by calling a simple top-up to create the wallet if needed
      // The actual seeding is done via CLI, but we can at least refresh
      await fetchAll();
    } finally {
      setSeeding(false);
    }
  };

  return (
    <Dashboard.Root>
      <Dashboard.Sidebar>
        <Dashboard.SidebarBrand>
          <Dashboard.Kicker>GentWallet</Dashboard.Kicker>
          <Dashboard.Metric>Agent Wallet</Dashboard.Metric>
          <Dashboard.Note>
            Control spend without blocking useful automation.
          </Dashboard.Note>
        </Dashboard.SidebarBrand>

        <Dashboard.SidebarGroup>
          <Dashboard.SidebarLabel>Workspace</Dashboard.SidebarLabel>
          <Dashboard.SidebarNav>
            <Dashboard.CurrentSidebarItem meta={balance ? "Live" : "Offline"}>
              Overview
            </Dashboard.CurrentSidebarItem>
            <Dashboard.SidebarItem meta={String(transactions.length)}>
              Transactions
            </Dashboard.SidebarItem>
            <Dashboard.SidebarItem meta={String(rules.length)}>
              Spending Rules
            </Dashboard.SidebarItem>
            <Dashboard.SidebarItem meta={String(notifications.length)}>
              Notifications
            </Dashboard.SidebarItem>
            <Dashboard.SidebarItem>Settings</Dashboard.SidebarItem>
          </Dashboard.SidebarNav>
        </Dashboard.SidebarGroup>

        <Dashboard.SidebarGroup>
          <Dashboard.SidebarLabel>Wallets</Dashboard.SidebarLabel>
          <Dashboard.SidebarNav>
            <Dashboard.CurrentSidebarItem
              meta={balance ? formatCents(balance.balanceCents) : "--"}
            >
              {WALLET_ID}
            </Dashboard.CurrentSidebarItem>
          </Dashboard.SidebarNav>
        </Dashboard.SidebarGroup>
      </Dashboard.Sidebar>

      <Dashboard.Content>
        <Dashboard.Header>
          <Dashboard.TitleBlock
            eyebrow={WALLET_ID}
            title="Account overview"
            description={
              error ?? "Live data from auth-service API with 3s polling."
            }
          />
          <Dashboard.HeaderActions>
            <Dashboard.QuietAction onClick={fetchAll}>
              Refresh
            </Dashboard.QuietAction>
          </Dashboard.HeaderActions>
        </Dashboard.Header>

        <Dashboard.Main>
          <Dashboard.Grid>
            <Dashboard.Panel>
              <Dashboard.PanelHeader>
                <Dashboard.PanelTitle>Balance snapshot</Dashboard.PanelTitle>
              </Dashboard.PanelHeader>
              <Dashboard.PanelBody>
                <Dashboard.StatRow
                  label="Available balance"
                  value={
                    balance ? formatCents(balance.availableCents) : "--"
                  }
                  detail="After held funds"
                />
                <Dashboard.StatRow
                  label="Held funds"
                  value={balance ? formatCents(balance.heldCents) : "--"}
                  detail="Pending authorizations"
                />
                <Dashboard.StatRow
                  label="Total balance"
                  value={
                    balance ? formatCents(balance.balanceCents) : "--"
                  }
                  detail="Includes held"
                />
                <Dashboard.StatRow
                  label="Today approved"
                  value={String(todayApproved)}
                  detail="Transactions today"
                />
              </Dashboard.PanelBody>
            </Dashboard.Panel>

            <Dashboard.Panel>
              <Dashboard.PanelHeader>
                <Dashboard.PanelTitle>Spending rules</Dashboard.PanelTitle>
              </Dashboard.PanelHeader>
              <Dashboard.PanelBody>
                {rules.length === 0 ? (
                  <Dashboard.Note>
                    No rules configured. Run `npm run seed` to set up demo data.
                  </Dashboard.Note>
                ) : (
                  <Dashboard.List>
                    {rules.map((rule) => (
                      <Dashboard.ListItem key={rule.id}>
                        <div>
                          <Dashboard.Kicker>
                            {rule.isActive ? "Active" : "Inactive"}
                          </Dashboard.Kicker>
                          <Dashboard.Metric>{ruleLabel(rule)}</Dashboard.Metric>
                        </div>
                      </Dashboard.ListItem>
                    ))}
                  </Dashboard.List>
                )}
              </Dashboard.PanelBody>
            </Dashboard.Panel>

            <Dashboard.Panel className="dashboard-panel-wide">
              <Dashboard.PanelHeader>
                <Dashboard.PanelTitle>Recent authorizations</Dashboard.PanelTitle>
              </Dashboard.PanelHeader>
              <Dashboard.PanelBody>
                {transactions.length === 0 ? (
                  <Dashboard.Note>
                    No transactions yet. Run `npm run seed` or use the MCP
                    server.
                  </Dashboard.Note>
                ) : (
                  <Dashboard.List>
                    {transactions.slice(0, 10).map((tx) => (
                      <Dashboard.ListItem key={tx.id}>
                        <div>
                          <Dashboard.Metric>{tx.merchantName}</Dashboard.Metric>
                          <Dashboard.Note>
                            {tx.decision === "declined"
                              ? `Declined: ${tx.declineReason}`
                              : `Approved${tx.decidedInMs != null ? ` in ${tx.decidedInMs}ms` : ""}`}
                          </Dashboard.Note>
                        </div>
                        <div className="dashboard-transaction-meta">
                          <Dashboard.Kicker>{tx.decision}</Dashboard.Kicker>
                          <Dashboard.Metric>
                            {formatCents(tx.amountCents)}
                          </Dashboard.Metric>
                        </div>
                      </Dashboard.ListItem>
                    ))}
                  </Dashboard.List>
                )}
              </Dashboard.PanelBody>
            </Dashboard.Panel>

            <Dashboard.Panel>
              <Dashboard.PanelHeader>
                <Dashboard.PanelTitle>Notifications</Dashboard.PanelTitle>
              </Dashboard.PanelHeader>
              <Dashboard.PanelBody>
                {notifications.length === 0 ? (
                  <Dashboard.Note>No notifications yet.</Dashboard.Note>
                ) : (
                  <Dashboard.List>
                    {notifications.slice(0, 10).map((notif) => (
                      <Dashboard.ListItem key={notif.id}>
                        <Dashboard.Note>{notif.message}</Dashboard.Note>
                      </Dashboard.ListItem>
                    ))}
                  </Dashboard.List>
                )}
              </Dashboard.PanelBody>
            </Dashboard.Panel>
          </Dashboard.Grid>
        </Dashboard.Main>
      </Dashboard.Content>
    </Dashboard.Root>
  );
}
