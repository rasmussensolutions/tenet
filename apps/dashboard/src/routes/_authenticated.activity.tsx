import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@tenet/ui/page-header";

export const Route = createFileRoute("/_authenticated/activity")({
  head: () => ({ meta: [{ title: "Activity — Tenet" }] }),
  component: ActivityPage,
});

function ActivityPage() {
  return <PageHeader title="Activity" />;
}
