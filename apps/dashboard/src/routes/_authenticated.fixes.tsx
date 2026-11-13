import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@tenet/ui/page-header";

export const Route = createFileRoute("/_authenticated/fixes")({
  head: () => ({ meta: [{ title: "Fixes — Tenet" }] }),
  component: FixesPage,
});

function FixesPage() {
  return <PageHeader title="Fixes" />;
}
