import { lazy, Suspense } from "react";
import { ClientOnly } from "@tanstack/react-router";

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
