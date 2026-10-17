import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extrairRegua, medirPares, razaoDeContraste } from "@/lib/branding/contraste";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const css = read("app/globals.css");
function tokens(selector: string) {
  const start = css.indexOf(`\n${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return Object.fromEntries(
    [...css.slice(start, css.indexOf("\n}", start)).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(
      (m) => [m[1], m[2]],
    ),
  );
}

describe("neutral CRM visual system", () => {
  it("provides the bright neutral surface contract and rounded hierarchy", () => {
    const light = tokens(":root");
    expect(light).toMatchObject({
      "--color-bg": "#f7f8fa",
      "--color-surface": "#ffffff",
      "--color-sidebar": "#f9fafb",
      "--color-text": "#1d1d1f",
      "--color-border": "#e5e7eb",
      "--radius-md": "12px",
      "--radius-lg": "16px",
      "--radius-xl": "20px",
    });
  });

  it.each([":root", '[data-theme="dark"]'])(
    "keeps small labels readable on every %s surface",
    (selector) => {
      const theme = tokens(selector);
      for (const foreground of ["--color-text", "--color-text-muted", "--color-text-subtle"]) {
        for (const surface of [
          "--color-bg",
          "--color-surface",
          "--color-surface-elevated",
          "--color-sidebar",
        ]) {
          expect(
            razaoDeContraste(theme[foreground]!, theme[surface]!),
            `${selector} ${foreground} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );

  it("keeps brand roles including focus visible in both themes", () => {
    const ruler = extrairRegua(css);
    for (const theme of [ruler.claro, ruler.escuro]) {
      const pairs = medirPares(theme, ruler.rampaDoProduto, 0);
      expect(pairs.some((pair) => pair.papel.includes("focus-visible"))).toBe(true);
      expect(pairs.filter((pair) => !pair.passa)).toEqual([]);
    }
    expect(css).toContain("--color-ring: var(--ring)");
    expect(read("components/ui/button.tsx")).toContain("focus-visible:ring-ring");
  });

  it("does not force a dark navigation scope or download fonts", () => {
    const scope = css.match(/\[data-app-sidebar\] \{([^}]+)\}/)?.[1];
    expect(scope).toContain("background-color: var(--color-sidebar)");
    expect(scope).not.toMatch(/--color-[\w-]+:/);
    expect(read("components/shell/Sidebar.tsx")).not.toContain(" superficieEscura");
    expect(read("app/layout.tsx")).not.toContain("next/font/google");
    expect(read("app/design/lib/fonts.ts")).not.toContain("next/font/google");
    expect(tokens(":root")["--font-system-sans"]).toContain('"PingFang SC"');
  });

  it("uses semantic selection, overlays, and visible keyboard focus", () => {
    const inbox = read("components/inbox/ConversationListItem.tsx");
    expect(inbox).toContain("bg-accent-soft hover:bg-accent-soft");
    expect(inbox).toContain("focus-visible:ring-ring");
    expect(inbox).not.toContain("bg-accent-50");
    for (const component of ["dialog", "alert-dialog", "sheet"]) {
      const source = read(`components/ui/${component}.tsx`);
      expect(source).toContain("bg-overlay");
      expect(source).not.toContain("bg-black/80");
    }
    expect(css).toContain("outline: 2px solid Highlight !important");
  });
});
