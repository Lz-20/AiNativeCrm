import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const names = [
  "20261027010000_0409_credenciais_e_auditoria_server_only",
  "20261027010100_0410_lgpd_comandas_na_cascata",
];

describe("instalação e atualização recebem exatamente o mesmo conserto", () => {
  for (const name of names) {
    it(name, () => {
      const migration = readFileSync(`supabase/migrations/${name}.sql`, "utf8").trim();
      const baseline = readFileSync("supabase/baseline.sql", "utf8");
      const manifest = readFileSync("supabase/migrations/MANIFEST.md", "utf8");
      expect(baseline).toContain(migration);
      expect(manifest).toContain(`\`${name.slice(15)}\``);
      expect(manifest).toContain(`\`${name.slice(0, 14)}\``);
      // A varredura final deve alcançar também funções do novo apêndice.
      // Ela preserva service_role e não readiciona authenticated já revogado.
      const scan = baseline.lastIndexOf("-- ---- VARREDURA anon: fecha os apêndices posteriores à migration 0116 ----");
      expect(scan).toBeGreaterThan(0);
      expect(baseline.indexOf(migration) + migration.length).toBeLessThan(scan);
      if (name.includes("0410")) {
        const definition = 'CREATE OR REPLACE FUNCTION "public"."fn_lgpd_cascade_redact_contact"';
        expect(baseline.lastIndexOf(definition)).toBe(baseline.indexOf(migration) + migration.indexOf(definition));
      }
    });
  }
});
