"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ModelEntry } from "@/lib/types";
import { FolderOpen, Info } from "lucide-react";

function FieldLabel({
  label,
  hint,
  htmlFor,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {hint && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button type="button" className="text-muted-foreground/60 hover:text-muted-foreground">
                <Info className="size-3" />
              </button>
            }
          />
          <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <FieldLabel label={label} hint={hint} />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn("h-8", mono && "font-mono text-xs")}
      />
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  hint,
  min,
  max,
  step = 1,
  className,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <FieldLabel label={label} hint={hint} />
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = e.target.value === "" ? 0 : Number(e.target.value);
          onChange(Number.isNaN(n) ? 0 : n);
        }}
        className="h-8 tabular-nums"
      />
    </div>
  );
}

export function SwitchField({
  label,
  checked,
  onCheckedChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
      <FieldLabel label={label} hint={hint} />
      <Switch checked={checked} onCheckedChange={(v) => onCheckedChange(Boolean(v))} />
    </div>
  );
}

export function ChoiceField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel label={label} hint={hint} />
      <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
              value === o.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function fmtSize(bytes: number): string {
  if (!bytes) return "";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}

export function ModelPicker({
  label,
  value,
  onChange,
  models,
  hint,
  optional,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  models: ModelEntry[];
  hint?: string;
  optional?: boolean;
}) {
  const basename = value ? value.split("/").pop() : "";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <FieldLabel label={label} hint={hint} />
        {optional && (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
            optional
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={optional ? "(none)" : "/path/to/model.gguf"}
          className="h-8 flex-1 font-mono text-xs"
        />
        <Select value={null} onValueChange={(v) => v && onChange(String(v))}>
          <SelectTrigger
            className="h-8 shrink-0 px-2"
            aria-label="browse discovered models"
          >
            <FolderOpen className="size-4" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {models.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                No .gguf files found
              </div>
            )}
            {models.map((m) => (
              <SelectItem key={m.path} value={m.path}>
                <span className="flex w-full items-center gap-2">
                  <span className="truncate font-mono text-xs">{m.name}</span>
                  {m.sizeBytes > 0 && (
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {fmtSize(m.sizeBytes)}
                    </span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {basename && (
        <span className="truncate text-[10px] text-muted-foreground/70">{basename}</span>
      )}
    </div>
  );
}
