import { createFileRoute } from "@tanstack/react-router";
import { BautaktApp } from "@/components/BautaktApp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "BauTakt – Terminplanung und Projektsteuerung" },
      {
        name: "description",
        content:
          "BauTakt plant Vorhaben jeder Art: Terminplan, Beteiligte, Ressourcen, Soll-Ist-Vergleich und Berichte in einer Oberfläche – für Bauprojekte ebenso wie interne Vorhaben, Coaching oder Software.",
      },
      { property: "og:title", content: "BauTakt – Terminplanung und Projektsteuerung" },
      {
        property: "og:description",
        content:
          "Terminplan, Beteiligte, Ressourcen und Berichte für jedes Vorhaben – übersichtlich an einem Ort.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BautaktApp,
});
