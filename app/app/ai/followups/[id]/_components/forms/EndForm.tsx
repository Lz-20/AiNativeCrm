"use client";

import { useState } from "react";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { endConfigSchema } from "@/lib/followup/graph-schema";
import { RESULTADOS_DO_FIM, opcoes, type ResultadoDoFim } from "@/lib/followup/vocabulario";
import { useT } from "@/hooks/i18n/useT";

import type { ConfigOf } from "./shared";

export function EndForm({
  config,
  onChange,
}: {
  config: ConfigOf<"end">;
  onChange: (c: ConfigOf<"end">) => void;
}) {
  const t = useT();
  const [outcome, setOutcome] = useState(config.outcome);
  const [note, setNote] = useState(config.note ?? "");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: { outcome: ResultadoDoFim; note: string }) => {
    const candidate = { outcome: next.outcome, ...(next.note.trim() ? { note: next.note } : {}) };
    const parsed = endConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="end-outcome">{t("Resultado")}</Label>
        <Select
          value={outcome}
          onValueChange={(v) => {
            const next = v as ResultadoDoFim;
            setOutcome(next);
            commit({ outcome: next, note });
          }}
        >
          <SelectTrigger id="end-outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {opcoes(RESULTADOS_DO_FIM).map(({ valor, rotulo }) => (
              <SelectItem key={valor} value={valor}>
                {t(rotulo)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="end-note">{t("Nota (opcional)")}</Label>
        <Textarea
          id="end-note"
          maxLength={200}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            commit({ outcome, note: e.target.value });
          }}
        />
      </div>
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}
