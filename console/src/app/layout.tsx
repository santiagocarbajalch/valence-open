import type { Metadata } from "next";
import "./globals.css";

// Fonts are self-hosted (IBM Plex Sans/Mono, @font-face in globals.css +
// /public/fonts) — no build-time font download, no network dependency.

export const metadata: Metadata = {
  title: "Valence Console",
  description: "Agent workspace — VenusOS V2",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="h-full antialiased">
      <head>
        {/* mode before first paint: day (bench, lights on) is the default;
            night (dark lab) only when the operator toggled it on. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{if(localStorage.getItem('valence-mode')==='night'){document.documentElement.classList.add('night');}}catch(e){}})();",
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <div className="atmosphere" aria-hidden />
        {children}
      </body>
    </html>
  );
}
