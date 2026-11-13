import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@tenet/ui/page-header";

export const Route = createFileRoute("/_authenticated/logs")({
  head: () => ({ meta: [{ title: "Logs — Tenet" }] }),
  component: LogsPage,
});

function LogsPage() {
  return <PageHeader title="Logs" />;
}
