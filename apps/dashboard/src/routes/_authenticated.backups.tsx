import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@tenet/ui/page-header";

export const Route = createFileRoute("/_authenticated/backups")({
  head: () => ({ meta: [{ title: "Backups — Tenet" }] }),
  component: BackupsPage,
});

function BackupsPage() {
  return <PageHeader title="Backups" />;
}
