import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@tenet/ui/page-header";

export const Route = createFileRoute("/_authenticated/updates")({
  head: () => ({ meta: [{ title: "Updates — Tenet" }] }),
  component: UpdatesPage,
});

function UpdatesPage() {
  return <PageHeader title="Updates" />;
}
