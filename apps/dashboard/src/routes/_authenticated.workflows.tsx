import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@tenet/ui/page-header";

export const Route = createFileRoute("/_authenticated/workflows")({
  head: () => ({ meta: [{ title: "Workflows — Tenet" }] }),
  component: WorkflowsPage,
});

function WorkflowsPage() {
  return <PageHeader title="Workflows" />;
}
