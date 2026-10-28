import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listUsers: vi.fn(), updateUserById: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ auth: { admin: api } })) }));
import { createClient } from "@supabase/supabase-js";
import { criarFixtureIdiomaDoDonoLocal } from "../e2e/helpers/idioma-do-dono-local";

const email = "e2e-dono@pi-native.test";
const local = { url: "http://127.0.0.1:54321", dbUrl: "postgresql://localhost:54322/postgres", serviceRole: "unit-only" };

beforeEach(() => {
  vi.clearAllMocks();
  api.listUsers.mockResolvedValue({ data: { users: [{ id: "fixture-owner", email, user_metadata: { full_name: "Fixture", locale: "es" } }] }, error: null });
  api.updateUserById.mockResolvedValue({ error: null });
});

describe("idioma explícito e reversível do dono sintético", () => {
  it.each([
    { ...local, url: "https://project.supabase.co" },
    { ...local, url: "http://127.evil.example.test" },
    { ...local, url: "" },
    { ...local, dbUrl: "postgresql://remote.example.test/postgres" },
  ])("rejeita destino não local antes de criar um cliente", async (destination) => {
    await expect(criarFixtureIdiomaDoDonoLocal(destination, email)).rejects.toThrow("local");
    expect(createClient).not.toHaveBeenCalled();
    expect(api.updateUserById).not.toHaveBeenCalled();
  });

  it("rejeita qualquer identidade fora da fixture dedicada antes de conectar", async () => {
    await expect(criarFixtureIdiomaDoDonoLocal(local, "person@example.test")).rejects.toThrow("fixture");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("procura o email exato e nunca substitui outro usuário", async () => {
    api.listUsers.mockResolvedValue({ data: { users: [{ id: "someone-else", email: "person@example.test", user_metadata: {} }] }, error: null });
    await expect(criarFixtureIdiomaDoDonoLocal(local, email)).rejects.toThrow("ausente");
    expect(api.updateUserById).not.toHaveBeenCalled();
  });

  it("fixa português e restaura só a preferência anterior, preservando os outros metadados", async () => {
    const fixture = await criarFixtureIdiomaDoDonoLocal(local, email);
    expect(api.updateUserById).not.toHaveBeenCalled();
    await fixture.aplicar();
    await fixture.restaurar();
    expect(api.updateUserById.mock.calls).toEqual([
      ["fixture-owner", { user_metadata: { locale: "pt-BR" } }],
      ["fixture-owner", { user_metadata: { locale: "es" } }],
    ]);
  });

  it("restaura ausência de preferência pela remoção do campo, como o teardown de i18n", async () => {
    api.listUsers.mockResolvedValue({ data: { users: [{ id: "fixture-owner", email, user_metadata: { full_name: "Fixture" } }] }, error: null });
    const fixture = await criarFixtureIdiomaDoDonoLocal(local, email);
    await fixture.aplicar();
    await fixture.restaurar();
    expect(api.updateUserById).toHaveBeenLastCalledWith("fixture-owner", { user_metadata: { locale: null } });
  });

  it("a restauração segue disponível mesmo quando a tentativa de configuração falha", async () => {
    const fixture = await criarFixtureIdiomaDoDonoLocal(local, email);
    api.updateUserById.mockResolvedValueOnce({ error: { message: "synthetic failure" } });
    await expect(fixture.aplicar()).rejects.toThrow("idioma");
    await fixture.restaurar();
    expect(api.updateUserById).toHaveBeenLastCalledWith("fixture-owner", { user_metadata: { locale: "es" } });
  });

  it("permite medir a tela chinesa e voltar ao idioma português da suíte", async () => {
    const fixture = await criarFixtureIdiomaDoDonoLocal(local, email);
    await fixture.aplicar("zh-CN");
    await fixture.aplicar();
    await fixture.restaurar();
    expect(api.updateUserById.mock.calls).toEqual([
      ["fixture-owner", { user_metadata: { locale: "zh-CN" } }],
      ["fixture-owner", { user_metadata: { locale: "pt-BR" } }],
      ["fixture-owner", { user_metadata: { locale: "es" } }],
    ]);
  });

  it("falha explicitamente se a restauração falhar", async () => {
    const fixture = await criarFixtureIdiomaDoDonoLocal(local, email);
    await fixture.aplicar();
    api.updateUserById.mockResolvedValueOnce({ error: { message: "synthetic failure" } });
    await expect(fixture.restaurar()).rejects.toThrow("restaurar");
  });
});
