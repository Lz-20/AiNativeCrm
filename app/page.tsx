import { redirect } from "next/navigation";
import { isDemoModeEnabled } from "@/lib/demo/config";

// A raiz não tem conteúdo próprio: manda pro painel. O middleware redireciona
// visitante não autenticado para /login?next=/app automaticamente.
export default function HomePage() {
  if (isDemoModeEnabled()) redirect("/demo/enter?next=/app/kanban");
  redirect("/app");
}
