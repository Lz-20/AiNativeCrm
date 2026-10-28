import { describe, expect, it } from "vitest";
import { publicStorageUrl, supabaseServerUrl, validSupabaseInternalUrl } from "./urls";

const config = {
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:8000",
  SUPABASE_INTERNAL_URL: "http://api-gw:8000",
};

describe("endereços internos e públicos do Supabase", () => {
  it("usa o interno no servidor e preserva instalações com URL única", () => {
    expect(supabaseServerUrl(config)).toBe("http://api-gw:8000");
    expect(supabaseServerUrl({ ...config, SUPABASE_INTERNAL_URL: "" })).toBe(
      "http://localhost:8000",
    );
    expect(supabaseServerUrl({ NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co" })).toBe(
      "https://project.supabase.co",
    );
  });

  it("publica a assinatura sem alterar path ou bytes do token", () => {
    const path =
      "/storage/v1/object/sign/whatsapp-media/org/file%20one.png?token=a%2Bb.c&download=";
    expect(publicStorageUrl("http://api-gw:8000" + path, config)).toBe(
      "http://localhost:8000" + path,
    );
  });

  it("respeita prefixos distintos de reverse proxy", () => {
    expect(
      publicStorageUrl("http://api-gw:8000/internal/storage/v1/object/sign/a?token=x", {
        NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid/supabase/",
        SUPABASE_INTERNAL_URL: "http://api-gw:8000/internal/",
      }),
    ).toBe("https://example.invalid/supabase/storage/v1/object/sign/a?token=x");
  });

  it("não reescreve outras origens, caminhos ou configurações públicas", () => {
    for (const url of [
      "https://external.invalid/storage/v1/object/sign/a?token=x",
      "http://api-gw:8000/auth/v1/user",
      "https://api-gw:8000/storage/v1/object/a",
    ]) {
      expect(publicStorageUrl(url, config)).toBe(url);
    }
    const url = "https://example.invalid/storage/v1/object/a";
    expect(publicStorageUrl(url, { NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid" })).toBe(
      url,
    );
  });

  it("URL interna aceita HTTP(S), sem credenciais ou parâmetros", () => {
    expect(validSupabaseInternalUrl("http://api-gw:8000")).toBe(true);
    expect(validSupabaseInternalUrl("https://internal.invalid/supabase")).toBe(true);
    for (const value of [
      "ftp://internal.invalid",
      "http://u:p@internal.invalid",
      "http://internal.invalid?secret=fixture",
      "http://internal.invalid#fragment",
      "invalid",
    ]) {
      expect(validSupabaseInternalUrl(value)).toBe(false);
    }
  });
});
