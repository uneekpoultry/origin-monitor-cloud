import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Origin Monitor — Premium IoT monitoring for poultry incubation",
    template: "%s · Origin Monitor",
  },
  description:
    "Factory-calibrated IoT temperature and humidity sensors for serious breeders. Designed in Australia by Uneek Poultry.",
  metadataBase: new URL("https://originmonitor.com"),
  openGraph: {
    title: "Origin Monitor",
    description:
      "Premium IoT temperature and humidity monitoring ecosystem for poultry incubation.",
    url: "https://originmonitor.com",
    siteName: "Origin Monitor",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
