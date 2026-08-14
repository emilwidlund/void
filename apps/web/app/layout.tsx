import type { Metadata } from "next"
import localFont from "next/font/local"
import type { ReactNode } from "react"
import "./globals.css"

const neueMontreal = localFont({
  src: "./fonts/PPNeueMontreal-VariableUpright.woff2",
  weight: "100 800",
  variable: "--font-pp",
  display: "swap"
})

export const metadata: Metadata = {
  title: "void — billing",
  description: "Usage, customer spend and deployed billing configuration"
}

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={neueMontreal.variable}>
      <body>{children}</body>
    </html>
  )
}
