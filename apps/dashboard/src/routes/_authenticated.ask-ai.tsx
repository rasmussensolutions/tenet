import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@tenet/ui/page-header";

export const Route = createFileRoute("/_authenticated/ask-ai")({
  head: () => ({ meta: [{ title: "Ask AI — Tenet" }] }),
  component: AskAiPage,
});

function AskAiPage() {
  return <PageHeader title="Ask AI" />;
}
