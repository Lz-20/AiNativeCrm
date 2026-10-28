import { describe, expect, it, vi } from "vitest";
import { preservarIdiomaDoUsuario } from "../e2e/helpers/preservar-idioma";

describe("a jornada de idioma devolve a preferência que encontrou", () => {
  it.each(["pt-BR", "es", "zh-CN", null, undefined])("restaura %s depois de uma troca e preserva os outros metadados", async (locale) => {
    const state: Record<string, unknown> = { locale, full_name: "Fixture" };
    const api = {
      getUserById: vi.fn(async () => ({ data: { user: { user_metadata: { ...state } } }, error: null })),
      updateUserById: vi.fn(async (_id: string, value: { user_metadata: Record<string, unknown> }) => {
        // Contrato do Auth: merge; null remove a chave da preferência.
        for (const [key, valuePart] of Object.entries(value.user_metadata)) {
          if (valuePart === null) delete state[key]; else state[key] = valuePart;
        }
        return { error: null };
      }),
    };
    const restore = await preservarIdiomaDoUsuario(api as unknown as Parameters<typeof preservarIdiomaDoUsuario>[0], "fixture-admin");
    expect(api.updateUserById).not.toHaveBeenCalled();
    state.locale = "es";
    state.full_name = "Nome alterado durante a jornada";
    await restore();
    expect(state.locale ?? null).toBe(locale ?? null);
    expect(state.full_name).toBe("Nome alterado durante a jornada");
    expect(api.getUserById).toHaveBeenCalledWith("fixture-admin");
    expect(api.updateUserById).toHaveBeenCalledWith("fixture-admin", { user_metadata: { locale: locale ?? null } });
  });

  it("para antes da jornada se a leitura da preferência falhar", async () => {
    const api = { getUserById: vi.fn(async () => ({ data: { user: null }, error: { message: "fixture error" } })), updateUserById: vi.fn() };
    await expect(preservarIdiomaDoUsuario(api as unknown as Parameters<typeof preservarIdiomaDoUsuario>[0], "fixture-admin")).rejects.toThrow("capturar");
    expect(api.updateUserById).not.toHaveBeenCalled();
  });

  it("sinaliza uma falha de restauração em vez de deixar estado compartilhado em silêncio", async () => {
    const api = {
      getUserById: vi.fn(async () => ({ data: { user: { user_metadata: { locale: "pt-BR" } } }, error: null })),
      updateUserById: vi.fn(async () => ({ error: { message: "fixture error" } })),
    };
    const restore = await preservarIdiomaDoUsuario(api as unknown as Parameters<typeof preservarIdiomaDoUsuario>[0], "fixture-admin");
    await expect(restore()).rejects.toThrow("restaurar");
  });
});
