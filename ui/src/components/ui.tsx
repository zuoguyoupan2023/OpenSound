import type { ReactNode } from "react";
import { Icon } from "@iconify/react";

export function Panel({
  title,
  subtitle,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">{title}</h2>
          {subtitle && <p className="panel-sub">{subtitle}</p>}
        </div>
        {actions && <div className="panel-actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function EngineBadge({
  label,
  ready,
  starting,
  availableOff,
}: {
  label: string;
  ready: boolean;
  /** 已按模式/用户选择启动、但服务仍在加载（如 cosyvoice 9GB 模型冷启动 1-2 分钟） */
  starting?: boolean;
  /** 可用但节能模式未启用（黄勾，可切换使用） */
  availableOff?: boolean;
}) {
  if (starting) {
    return (
      <span className="engine-badge starting" title="服务已拉起，模型加载中…">
        <Spinner /> {label} 启动中…
      </span>
    );
  }
  if (availableOff) {
    return (
      <span className="engine-badge available" title="本机可用，但节能模式未启用；可在「设置 → 服务资源模式」切换">
        {label} <Icon icon="lucide:check" width={13} height={13} /> 未启用·可切换
      </span>
    );
  }
  return (
    <span className={`engine-badge ${ready ? "ok" : "off"}`}>
      {label}{" "}
      <Icon icon={ready ? "lucide:check" : "lucide:x"} width={13} height={13} />
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <select
      className="select"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  type = "button",
  title,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost" | "danger";
  type?: "button" | "submit";
  title?: string;
  className?: string;
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant}${className ? ` ${className}` : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
