import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SmartTelemetry - Patient Health Monitor",
  description: "Real-time body temperature, BPM, and SpO2 patient health telemetry simulator and administration console.",
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
