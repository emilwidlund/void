import type { ReactNode } from "react"
import "./globals.css"

export const metadata = {
  title: "helpdesk — void billing demo",
  description: "A support ticketing app billed end-to-end through void",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
