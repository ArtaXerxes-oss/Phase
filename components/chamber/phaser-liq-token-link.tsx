"use client"

// Extracted verbatim from components/fusion-chamber.tsx (refactor #33 imported it but never committed the file).

import { TokenIcon } from "@/components/token-icon"
import { playTacticalUiClick } from "@/lib/tactical-ui-click"
import { cn } from "@/lib/utils"

/** Enlace al asset PHASELQ en Stellar Expert (icono + símbolo). */
export function PhaserLiqTokenLink({
  href,
  symbol,
  iconClassName,
  className,
  variant = "default",
}: {
  href: string
  symbol: string
  iconClassName?: string
  className?: string
  variant?: "default" | "violet"
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      onClick={(e) => {
        e.stopPropagation()
        playTacticalUiClick()
      }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border border-transparent font-mono tracking-normal underline-offset-[3px] transition-colors hover:underline focus:outline-none",
        variant === "violet"
          ? "text-violet-200/95 hover:border-violet-500/45 hover:bg-violet-950/35 hover:text-violet-50 focus-visible:ring-2 focus-visible:ring-violet-400/55"
          : "text-cyan-400/95 hover:border-cyan-500/45 hover:bg-cyan-950/35 hover:text-cyan-50 focus-visible:ring-2 focus-visible:ring-cyan-400/60",
        className,
      )}
    >
      <TokenIcon className={cn("shrink-0", iconClassName ?? "h-4 w-4")} />
      {symbol}
    </a>
  )
}
