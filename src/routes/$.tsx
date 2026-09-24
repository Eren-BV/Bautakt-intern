import { createFileRoute } from "@tanstack/react-router";
import { BautaktApp } from "@/components/BautaktApp";

export const Route = createFileRoute("/$")({
  head: () => ({
    meta: [
      { title: "BauTakt – Bauzeitenplanung" },
      {
        name: "description",
        content:
          "Projekte, Terminpläne, Gewerke und Berichte in BauTakt verwalten.",
      },
      { property: "og:title", content: "BauTakt – Bauzeitenplanung" },
      {
        property: "og:description",
        content: "Projekte, Terminpläne, Gewerke und Berichte in BauTakt verwalten.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BautaktApp,
});
