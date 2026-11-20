/** Headers alone are not a completed mutation: consume its receipt before navigation. */
export async function endSupportRequest(fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher("/api/v1/admin/impersonate/end", { method: "POST" });
  if (!response.ok) throw new Error("Não foi possível encerrar o acompanhamento. Tente novamente.");
  const receipt: unknown = await response.json();
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !("data" in receipt) ||
    !receipt.data ||
    typeof receipt.data !== "object" ||
    !("ended" in receipt.data) ||
    typeof receipt.data.ended !== "boolean" ||
    !("redirect_url" in receipt.data) ||
    receipt.data.redirect_url !== "/app/inbox"
  )
    throw new Error(
      "Não foi possível confirmar o encerramento. Atualize a página antes de tentar novamente.",
    );
}
