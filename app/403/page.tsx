import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { loadAuthUser } from "@/lib/auth/server";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";

export default async function ForbiddenPage() {
  // Rota fora da árvore de `app/app/layout.tsx` — sem `IdiomaProvider`, então
  // Keep the authenticated app's saved/organization language. Without a
  // session, use the same browser-language fallback as the login page.
  const user = await loadAuthUser();
  const idioma = user?.idioma ?? await idiomaDoVisitante(null);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-md p-8 text-center">
        <h1 className="text-2xl font-semibold">{traduzir("403 — Sem permissão", idioma)}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {traduzir("Você não tem acesso a essa área.", idioma)}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button asChild variant="outline">
            <Link href="/">{traduzir("Voltar", idioma)}</Link>
          </Button>
          <Button asChild>
            <Link href="/app/inbox">{traduzir("Voltar pra Inbox", idioma)}</Link>
          </Button>
        </div>
      </Card>
    </main>
  );
}
