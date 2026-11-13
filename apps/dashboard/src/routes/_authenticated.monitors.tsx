import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@tenet/ui/page-header";

export const Route = createFileRoute("/_authenticated/monitors")({
  head: () => ({ meta: [{ title: "Monitors — Tenet" }] }),
  component: MonitorsPage,
});

function MonitorsPage() {
  return <PageHeader title="Monitors" />;
}
