import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PIT//CALL",
  description: "Gemma-powered F1 race strategy co-pilot.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
