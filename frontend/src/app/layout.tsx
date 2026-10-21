import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClearSight — Estación de Diagnóstico Clínico de Glaucoma",
  description:
    "Plataforma clínica de triaje multimodal y explicabilidad visual (Grad-CAM y segmentación copa/disco) para oftalmología.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className="dark h-full">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
        />
      </head>
      <body className="h-full bg-cockpit-bg text-cockpit-text antialiased">{children}</body>
    </html>
  );
}
