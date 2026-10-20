import "./globals.css";
import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Providers } from "@/components/providers";
import { AutoTranslate } from "@/components/auto-translate";

export const metadata: Metadata = {
  title: { default: "Socio — know what your business actually keeps", template: "%s · Socio" },
  description:
    "Socio is a business-finance copilot for small businesses and founders: profit, cash, budgets and decisions in plain language.",
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f0e8" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1411" },
  ],
};

// Applies the saved theme before first paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem("margin-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;var l=localStorage.getItem("margin-locale");if(l==="ar"){document.documentElement.lang="ar";document.documentElement.dir="rtl"}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>
          {children}
          <AutoTranslate />
        </Providers>
      </body>
    </html>
  );
}
