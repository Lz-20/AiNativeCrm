#!/usr/bin/env bash
# quem-sou.sh — diz se quem está neste clone é o mantenedor do Pi Native CRM ou um
# contribuidor, e POR QUÊ. A skill pi-native-contribuir (e os hooks) usam a
# primeira palavra da saída; o resto é para gente ler.
#
# Sinais (nenhum pede login):
#   1. o `gh` está logado como @luckiest-draw;
#   2. o `origin` é o repositório principal ou um fork (informativo).
#
# Uso: bash quem-sou.sh            → "mantenedor — ..." ou "contribuidor — ..."
#      bash quem-sou.sh --curto    → só a palavra
# Sai sempre com 0: identidade é informação, não veredito.
set -uo pipefail

raiz="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$raiz" ]; then
  [ "${1:-}" = "--curto" ] && echo "contribuidor" || echo "contribuidor — fora de um clone git"
  exit 0
fi

email="$(git -C "$raiz" config user.email 2>/dev/null || true)"
origin="$(git -C "$raiz" remote get-url origin 2>/dev/null || true)"
motivo=""

# 1) gh logado como o dono (só se o gh existe; nunca pede login).
if command -v gh >/dev/null 2>&1; then
  login="$(gh api user --jq .login 2>/dev/null || true)"
  [ "$login" = "luckiest-draw" ] && motivo="o gh está logado como @luckiest-draw"
fi

case "$origin" in
  *github.com[:/]luckiest-draw/AiNativeCrm*) remoto="origin é o repositório principal" ;;
  "")                                       remoto="sem origin configurado" ;;
  *)                                        remoto="origin é um fork ($origin)" ;;
esac

if [ -n "$motivo" ]; then
  [ "${1:-}" = "--curto" ] && echo "mantenedor" || echo "mantenedor — $motivo; $remoto"
else
  [ "${1:-}" = "--curto" ] && echo "contribuidor" || echo "contribuidor — e-mail do git: ${email:-não configurado}; $remoto"
fi
exit 0
