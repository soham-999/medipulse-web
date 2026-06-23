import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MediPulse - Clinical Health Portal",
  description: "Secure, zero-knowledge clinical report viewer",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
