import React from "react";

export function Card(props: { title?: string; children: React.ReactNode }) {
  return (
    <div className="bsl-card">
      {props.title && <div className="bsl-card-title">{props.title}</div>}
      {props.children}
    </div>
  );
}

export function Field(props: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="bsl-row">
      <label className="bsl-label">{props.label}</label>
      {props.children}
      {props.help && <div className="bsl-help">{props.help}</div>}
    </div>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input className={`bsl-input ${className ?? ""}`} {...rest} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props;
  return <select className={`bsl-select ${className ?? ""}`} {...rest} />;
}

type ButtonVariant = "primary" | "secondary" | "destructive";

export function Button(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; full?: boolean },
) {
  const { variant = "primary", full, className, ...rest } = props;
  const cls = [
    "bsl-button",
    `bsl-button-${variant}`,
    full ? "bsl-button-full" : "",
    className ?? "",
  ].join(" ");
  return <button className={cls} {...rest} />;
}

export function Badge(props: { children: React.ReactNode }) {
  return <span className="bsl-badge">{props.children}</span>;
}

export function Progress(props: { value: number; max: number }) {
  const pct = props.max > 0 ? Math.min(100, Math.round((props.value / props.max) * 100)) : 0;
  return (
    <div className="bsl-progress-track">
      <div className="bsl-progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Tabs<T extends string>(props: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="bsl-tabs">
      {props.options.map((opt) => (
        <div
          key={opt.value}
          className={`bsl-tab ${props.value === opt.value ? "bsl-tab-active" : ""}`}
          onClick={() => props.onChange(opt.value)}
        >
          {opt.label}
        </div>
      ))}
    </div>
  );
}

export function RadioGroup<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; description?: string }[];
}) {
  return (
    <div className="bsl-radio-group">
      {props.options.map((opt) => (
        <div
          key={opt.value}
          className={`bsl-radio-option ${props.value === opt.value ? "bsl-radio-option-selected" : ""}`}
          onClick={() => props.onChange(opt.value)}
        >
          <input type="radio" checked={props.value === opt.value} onChange={() => props.onChange(opt.value)} />
          <div>
            <div>{opt.label}</div>
            {opt.description && <div className="bsl-help">{opt.description}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
