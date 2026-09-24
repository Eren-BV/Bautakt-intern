import { createFileRoute } from "@tanstack/react-router";
import { BautaktApp } from "@/components/BautaktApp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "BauTakt – Bauzeitenplanung für Bauleitung und Projektsteuerung" },
      {
        name: "description",
        content:
          "BauTakt plant Bauabläufe: Terminplan, Gewerke, Ressourcen, Soll-Ist-Vergleich und Berichte in einer Oberfläche.",
      },
      { property: "og:title", content: "BauTakt – Bauzeitenplanung" },
      {
        property: "og:description",
        content:
          "Terminplan, Gewerke, Ressourcen und Berichte für Bauprojekte – übersichtlich an einem Ort.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BautaktApp,
});
