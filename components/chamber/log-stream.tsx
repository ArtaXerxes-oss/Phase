"use client"

// Extracted verbatim from components/fusion-chamber.tsx (refactor #33 imported it but never committed the file).

import type { RefObject } from "react"
import { cn } from "@/lib/utils"

export function ChamberLogStream({
  lines,
  endRef,
}: {
  lines: { id: number; text: string }[]
  endRef: RefObject<HTMLDivElement | null>
}) {
  return (
    <>
      {lines.map((l, i) => {
        const fault = /FAIL|Failed|ERROR|FAULT|ABORT|REJECT|denied|timeout|sequence|desync/i.test(l.text)
        return (
          <div
            key={l.id}
            className={cn(
              !fault &&
                "tactical-log-line mb-2 border-l-2 border-[#39ff14]/35 pl-2.5 font-mono text-[11px] leading-relaxed tracking-wide text-[#7df5d8] sm:text-xs sm:leading-relaxed",
              fault && "tactical-log-emergency mb-2 font-mono text-[11px] leading-relaxed sm:text-xs",
            )}
            style={!fault ? { animationDelay: `${Math.min(i, 8) * 65}ms` } : undefined}
          >
            <span className="break-words whitespace-pre-wrap">{l.text}</span>
          </div>
        )
      })}
      <div ref={endRef} />
    </>
  )
}
