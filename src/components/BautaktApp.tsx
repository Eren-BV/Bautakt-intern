import { lazy, Suspense } from "react";
import { ClientOnly } from "@tanstack/react-router";

// Nach einem Neustart/Update der Vorschau können Module kurz nicht ladbar sein:
// dann einmalig die Seite neu laden statt eines leeren Bildschirms.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", () => window.location.reload());
  window.addEventListener("unhandledrejection", (e) => {
    const msg = String((e as PromiseRejectionEvent).reason?.message ?? "");
    if (!/dynamically imported module|Importing a module script failed/i.test(msg)) return;
    const key = "bautakt-module-reload";
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    setTimeout(() => sessionStorage.removeItem(key), 10000);
    window.location.reload();
  });
}

const Shell = lazy(() =>
  import("@/bautakt/client/AppRoot").then((m) => ({ default: m.AppRoot })),
);

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-ink-faint">
      BauTakt wird geladen …
    </div>
  );
}

/** Die gesamte BauTakt-Oberfläche läuft im Browser (eigener History-Router, localStorage). */
export function BautaktApp() {
  return (
    <ClientOnly fallback={<Loading />}>
      <Suspense fallback={<Loading />}>
        <Shell />
      </Suspense>
    </ClientOnly>
  );
}
