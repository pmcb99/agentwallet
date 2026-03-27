import type { Metadata } from "next";
import type { PropsWithChildren } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "GentWallet Dashboard",
  description: "Dashboard scaffold with compound composition components.",
};

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
