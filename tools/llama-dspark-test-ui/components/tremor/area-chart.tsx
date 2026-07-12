"use client";

// A compact Tremor-styled area chart built on Recharts (the same engine Tremor
// uses), matching Tremor's visual language: soft gradient fills, hairline
// strokes, muted grid, and a floating tooltip card. Theme-aware via CSS vars.

import {
  Area,
  AreaChart as RcAreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type TremorColor =
  | "blue"
  | "emerald"
  | "violet"
  | "amber"
  | "rose"
  | "cyan"
  | "fuchsia"
  | "slate";

export const CHART_HEX: Record<TremorColor, string> = {
  blue: "#3b82f6",
  emerald: "#10b981",
  violet: "#8b5cf6",
  amber: "#f59e0b",
  rose: "#f43f5e",
  cyan: "#06b6d4",
  fuchsia: "#d946ef",
  slate: "#64748b",
};

export type ChartRow = Record<string, string | number>;

interface AreaChartProps {
  data: ChartRow[];
  index: string;
  categories: string[];
  colors?: TremorColor[];
  valueFormatter?: (v: number) => string;
  className?: string;
  yDomain?: [number | "auto" | "dataMin" | "dataMax", number | "auto" | "dataMin" | "dataMax"];
  showGrid?: boolean;
  showXAxis?: boolean;
  showYAxis?: boolean;
}

function ChartTooltip({
  active,
  payload,
  label,
  valueFormatter,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
  valueFormatter: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border/70 bg-popover/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      {label != null && (
        <div className="mb-1 font-medium text-muted-foreground">{label}</div>
      )}
      <div className="flex flex-col gap-1">
        {payload.map((p) => (
          <div key={p.name} className="flex items-center gap-2">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: p.color }}
            />
            <span className="text-muted-foreground">{p.name}</span>
            <span className="ml-auto font-semibold tabular-nums text-foreground">
              {valueFormatter(p.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AreaChart({
  data,
  index,
  categories,
  colors = ["blue", "emerald", "violet", "amber"],
  valueFormatter = (v) => String(v),
  className,
  yDomain = ["auto", "auto"],
  showGrid = true,
  showXAxis = false,
  showYAxis = false,
}: AreaChartProps) {
  return (
    <div className={className} style={{ width: "100%", height: "100%" }}>
      <ResponsiveContainer width="100%" height="100%">
        <RcAreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
          <defs>
            {categories.map((cat, i) => {
              const hex = CHART_HEX[colors[i % colors.length]];
              return (
                <linearGradient
                  key={cat}
                  id={`grad-${cat}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="5%" stopColor={hex} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={hex} stopOpacity={0} />
                </linearGradient>
              );
            })}
          </defs>
          {showGrid && (
            <CartesianGrid
              strokeDasharray="2 4"
              stroke="currentColor"
              className="text-border/50"
              vertical={false}
            />
          )}
          <XAxis
            dataKey={index}
            hide={!showXAxis}
            tick={{ fontSize: 11 }}
            stroke="currentColor"
            className="text-muted-foreground"
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis
            hide={!showYAxis}
            domain={yDomain}
            tick={{ fontSize: 11 }}
            stroke="currentColor"
            className="text-muted-foreground"
            tickLine={false}
            axisLine={false}
            width={40}
            tickFormatter={(v) => valueFormatter(v as number)}
          />
          <Tooltip
            content={<ChartTooltip valueFormatter={valueFormatter} />}
            cursor={{ stroke: "currentColor", strokeOpacity: 0.15 }}
          />
          {categories.map((cat, i) => {
            const hex = CHART_HEX[colors[i % colors.length]];
            return (
              <Area
                key={cat}
                type="monotone"
                dataKey={cat}
                stroke={hex}
                strokeWidth={2}
                fill={`url(#grad-${cat})`}
                isAnimationActive={false}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
              />
            );
          })}
        </RcAreaChart>
      </ResponsiveContainer>
    </div>
  );
}
