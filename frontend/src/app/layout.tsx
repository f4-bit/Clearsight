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
      <body className="h-full bg-cockpit-bg text-cockpit-text antialiased">
        {children}
      </body>
    </html>
  );
}
