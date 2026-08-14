import type { ReactNode } from "react"

export function Empty({ children }: { readonly children: ReactNode }) {
  return <div className="bg-surface p-12 text-center text-ink-muted">{children}</div>
}

export function Code({ children }: { readonly children: ReactNode }) {
  return (
    <code className="bg-surface-2 px-1.5 py-0.5 font-mono text-[13px] text-ink">{children}</code>
  )
}
