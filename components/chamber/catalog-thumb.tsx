"use client"

// Extracted verbatim from components/fusion-chamber.tsx (refactor #33 imported it but never committed the file).

import { useState } from "react"
import { IpfsDisplayImg } from "@/components/ipfs-display-img"

export function ChamberCatalogThumb({ collectionId, uri }: { collectionId: number; uri: string }) {
  const [broken, setBroken] = useState(false)
  if (!uri.trim() || broken) {
    return (
      <span className="px-1 text-center text-[7px] font-bold uppercase leading-tight text-cyan-500/80">
        #{collectionId}
      </span>
    )
  }
  return (
    <IpfsDisplayImg
      uri={uri}
      className="h-full w-full object-cover"
      loading="lazy"
      onExhausted={() => setBroken(true)}
    />
  )
}
