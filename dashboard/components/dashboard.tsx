import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  PropsWithChildren,
  ReactNode,
} from "react";

type ContainerProps = PropsWithChildren<HTMLAttributes<HTMLElement>>;
type DivProps = PropsWithChildren<HTMLAttributes<HTMLDivElement>>;

type SidebarLinkProps = {
  href?: string;
  children: ReactNode;
  meta?: ReactNode;
};

function cx(...parts: Array<string | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function Root({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-shell", className)} {...props}>
      {children}
    </div>
  );
}

function Sidebar({ children, className, ...props }: ContainerProps) {
  return (
    <aside className={cx("dashboard-sidebar", className)} {...props}>
      {children}
    </aside>
  );
}

function SidebarBrand({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-sidebar-brand", className)} {...props}>
      {children}
    </div>
  );
}

function SidebarGroup({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-sidebar-group", className)} {...props}>
      {children}
    </div>
  );
}

function SidebarLabel({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-sidebar-label", className)} {...props}>
      {children}
    </div>
  );
}

function SidebarNav({ children, className, ...props }: ContainerProps) {
  return (
    <nav className={cx("dashboard-sidebar-nav", className)} {...props}>
      {children}
    </nav>
  );
}

function SidebarItem({ href = "#", children, meta }: SidebarLinkProps) {
  return (
    <a className="dashboard-sidebar-item" href={href}>
      <span>{children}</span>
      {meta ? <span className="dashboard-sidebar-item-meta">{meta}</span> : null}
    </a>
  );
}

function CurrentSidebarItem({ href = "#", children, meta }: SidebarLinkProps) {
  return (
    <a className="dashboard-sidebar-item dashboard-sidebar-item-current" href={href}>
      <span>{children}</span>
      {meta ? <span className="dashboard-sidebar-item-meta">{meta}</span> : null}
    </a>
  );
}

function Content({ children, className, ...props }: ContainerProps) {
  return (
    <section className={cx("dashboard-content", className)} {...props}>
      {children}
    </section>
  );
}

function Header({ children, className, ...props }: ContainerProps) {
  return (
    <header className={cx("dashboard-header", className)} {...props}>
      {children}
    </header>
  );
}

function TitleBlock({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="dashboard-title-block">
      {eyebrow ? <div className="dashboard-eyebrow">{eyebrow}</div> : null}
      <h1 className="dashboard-title">{title}</h1>
      {description ? <p className="dashboard-description">{description}</p> : null}
    </div>
  );
}

function HeaderActions({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-header-actions", className)} {...props}>
      {children}
    </div>
  );
}

function Main({ children, className, ...props }: ContainerProps) {
  return (
    <main className={cx("dashboard-main", className)} {...props}>
      {children}
    </main>
  );
}

function Grid({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-grid", className)} {...props}>
      {children}
    </div>
  );
}

function Panel({ children, className, ...props }: ContainerProps) {
  return (
    <section className={cx("dashboard-panel", className)} {...props}>
      {children}
    </section>
  );
}

function PanelHeader({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-panel-header", className)} {...props}>
      {children}
    </div>
  );
}

function PanelTitle({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-panel-title", className)} {...props}>
      {children}
    </div>
  );
}

function PanelBody({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-panel-body", className)} {...props}>
      {children}
    </div>
  );
}

function StatRow({
  label,
  value,
  detail,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="dashboard-stat-row">
      <div>
        <div className="dashboard-stat-label">{label}</div>
        {detail ? <div className="dashboard-stat-detail">{detail}</div> : null}
      </div>
      <div className="dashboard-stat-value">{value}</div>
    </div>
  );
}

function List({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-list", className)} {...props}>
      {children}
    </div>
  );
}

function ListItem({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-list-item", className)} {...props}>
      {children}
    </div>
  );
}

function Kicker({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-kicker", className)} {...props}>
      {children}
    </div>
  );
}

function Metric({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-metric", className)} {...props}>
      {children}
    </div>
  );
}

function Note({ children, className, ...props }: DivProps) {
  return (
    <div className={cx("dashboard-note", className)} {...props}>
      {children}
    </div>
  );
}

function Action({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={cx("dashboard-action", className)} type="button" {...props}>
      {children}
    </button>
  );
}

function QuietAction({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cx("dashboard-action", "dashboard-action-quiet", className)}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

export const Dashboard = {
  Root,
  Sidebar,
  SidebarBrand,
  SidebarGroup,
  SidebarLabel,
  SidebarNav,
  SidebarItem,
  CurrentSidebarItem,
  Content,
  Header,
  TitleBlock,
  HeaderActions,
  Main,
  Grid,
  Panel,
  PanelHeader,
  PanelTitle,
  PanelBody,
  StatRow,
  List,
  ListItem,
  Kicker,
  Metric,
  Note,
  Action,
  QuietAction,
};
