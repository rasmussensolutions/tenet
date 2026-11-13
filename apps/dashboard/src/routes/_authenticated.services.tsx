import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@tenet/ui/page-header";

export const Route = createFileRoute("/_authenticated/services")({
  head: () => ({ meta: [{ title: "Services — Tenet" }] }),
  component: ServicesPage,
});

function ServicesPage() {
  return <PageHeader title="Services" />;
}
