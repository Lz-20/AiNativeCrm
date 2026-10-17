#!/usr/bin/env bash
# Contrato do instalador de guias Pi Native CRM em HOME e repositórios descartáveis.
set -uo pipefail

unset $(git rev-parse --local-env-vars)
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$RAIZ/scripts/instalar-guias.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
falhas=0; casos=0
ok(){ casos=$((casos+1)); printf '  ✓ %s\n' "$1"; }
falha(){ casos=$((casos+1)); falhas=$((falhas+1)); printf '  ✗ %s\n     %s\n' "$1" "${2:-}"; }
checa(){ if eval "$1"; then ok "$2"; else falha "$2" "condição: $1"; fi; }

montar_repo(){
  local r="$1" n
  mkdir -p "$r"; git -C "$r" init -q -b main
  for n in pi-native-instalar pi-native-prompt sistema-vivo; do
    mkdir -p "$r/.agents/skills/$n"
    printf -- "---\nname: %s\ndescription: 'guia %s'\n---\n\nversão 1\n" "$n" "$n" > "$r/.agents/skills/$n/SKILL.md"
  done
  mkdir -p "$r/app"; echo x > "$r/app/fora-do-sparse.ts"
  git -C "$r" add -A && git -C "$r" commit -q -m base
}

cenario(){
  export HOME="$TMP/$1/home"; mkdir -p "$HOME"
  repo="$TMP/$1/repo"; montar_repo "$repo"
  export PI_NATIVE_REPO_URL="file://$repo"
}

echo "1. instalação, atualização, fonte local e remoção"
repo="$TMP/base-repo"; montar_repo "$repo"; export PI_NATIVE_REPO_URL="file://$repo"
export HOME="$TMP/base/home"; mkdir -p "$HOME"
saida="$(bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code = 0 ]" "instala com sucesso"
for dest in .claude/skills .agents/skills .gemini/config/skills; do
  checa "[ -L \"\$HOME/$dest/pi-native-instalar\" ] && [ -f \"\$HOME/$dest/pi-native-instalar/SKILL.md\" ]" "pi-native-instalar ligado em ~/$dest"
  checa "[ -L \"\$HOME/$dest/pi-native-prompt\" ] && [ ! -e \"\$HOME/$dest/sistema-vivo\" ]" "só guias pi-native são instalados em ~/$dest"
done
checa "[ -d \"\$HOME/.pi-native/guias/.agents/skills\" ] && [ ! -e \"\$HOME/.pi-native/guias/app\" ]" "a cópia é esparsa"
checa "grep -qF '\$pi-native-instalar no Codex' <<<\"\$saida\"" "a saída ensina o nome do guia no Codex"
checa "grep -q 'NÃO se atualizam sozinhos' <<<\"\$saida\"" "a saída explica a atualização explícita"

rm -f "$HOME/.claude/skills/pi-native-prompt"; mkdir -p "$HOME/.claude/skills/pi-native-prompt"
echo "minha versão" > "$HOME/.claude/skills/pi-native-prompt/SKILL.md"
saida="$(bash "$SCRIPT" 2>&1)"
checa "grep -q 'pulei .*pi-native-prompt' <<<\"\$saida\" && grep -q 'minha versão' \"\$HOME/.claude/skills/pi-native-prompt/SKILL.md\"" "não sobrescreve skill da pessoa"

sed -i.bak 's/versão 1/versão 2/' "$repo/.agents/skills/pi-native-instalar/SKILL.md"; rm -f "$repo/.agents/skills/pi-native-instalar/SKILL.md.bak"
git -C "$repo" commit -qam v2; bash "$SCRIPT" >/dev/null 2>&1
checa "grep -q 'versão 2' \"\$HOME/.agents/skills/pi-native-instalar/SKILL.md\"" "a atualização chega pelo link"

clone="$TMP/base/clone"; git clone -q "$repo" "$clone"
sed -i.bak 's/versão 2/versão local/' "$clone/.agents/skills/pi-native-instalar/SKILL.md"; rm -f "$clone/.agents/skills/pi-native-instalar/SKILL.md.bak"
bash "$SCRIPT" --fonte "$clone" >/dev/null 2>&1
checa "grep -q 'versão local' \"\$HOME/.claude/skills/pi-native-instalar/SKILL.md\"" "--fonte aponta para o clone local"
saida="$(bash "$SCRIPT" --remover 2>&1)"; code=$?
checa "[ $code = 0 ] && grep -q 'ok: 5 ligação' <<<\"\$saida\"" "--remover desfaz as ligações que criou"
checa "[ -f \"\$HOME/.claude/skills/pi-native-prompt/SKILL.md\" ]" "--remover preserva a skill da pessoa"

echo "2. renomeação e cópia sem links"
cenario renomeado; bash "$SCRIPT" >/dev/null 2>&1
git -C "$repo" mv .agents/skills/pi-native-prompt .agents/skills/pi-native-prompt-agente; git -C "$repo" commit -qm renomeia
bash "$SCRIPT" >/dev/null 2>&1
checa "[ ! -e \"\$HOME/.claude/skills/pi-native-prompt\" ] && [ -f \"\$HOME/.claude/skills/pi-native-prompt-agente/SKILL.md\" ]" "guia renomeado remove o link antigo"

mkdir -p "$TMP/no-ln"; printf '#!/bin/sh\nexit 1\n' > "$TMP/no-ln/ln"; chmod +x "$TMP/no-ln/ln"
cenario copia; saida="$(PATH="$TMP/no-ln:$PATH" bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code = 0 ] && grep -q '0 ligados, 6 copiados' <<<\"\$saida\"" "faz cópias quando ln não está disponível"
checa "[ -f \"\$HOME/.agents/skills/pi-native-instalar/.pi-native-guia\" ]" "marca a cópia criada"
saida="$(bash "$SCRIPT" --remover 2>&1)"
checa "grep -q 'ok: 6 ligação' <<<\"\$saida\" && [ ! -e \"\$HOME/.agents/skills/pi-native-instalar\" ]" "remove as cópias marcadas"

echo "3. segurança de fonte, help e documentação"
cenario seguranca; mkdir -p "$TMP/fora"; echo nota > "$TMP/fora/nota.txt"
saida="$(PI_NATIVE_GUIAS_HOME="$TMP/fora" bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code != 0 ] && [ -f \"\$TMP/fora/nota.txt\" ] && grep -q 'não mexo' <<<\"\$saida\"" "recusa cache alheio sem tocar a nota"
bash "$SCRIPT" --nao-existe >/dev/null 2>&1; code=$?
checa "[ $code = 2 ]" "opção desconhecida sai com código 2"
for modo in arquivo pipe; do
  if [ "$modo" = arquivo ]; then saida="$(bash "$SCRIPT" --help 2>&1)"; code=$?
  else saida="$(bash -s -- --help < "$SCRIPT" 2>&1)"; code=$?; fi
  checa "[ $code = 0 ] && grep -qF 'instalar-guias.sh — deixa os guias' <<<\"\$saida\"" "help ($modo) imprime o cabeçalho"
  checa "grep -qF 'deve rodar com \`--fonte .\` naquele clone' <<<\"\$saida\" && ! grep -qF 'set -euo pipefail' <<<\"\$saida\"" "help ($modo) termina antes do código"
done
checa "grep -qF '\$pi-native-instalar' \"\$RAIZ/README.md\" && ! grep -qE 'digite .?/pi-native-' \"\$RAIZ/README.md\"" "README usa a chamada multiplataforma do guia"

echo
if [ "$falhas" = 0 ]; then echo "instalar-guias: $casos casos, todos verdes"; exit 0
else echo "instalar-guias: $falhas de $casos casos vermelhos"; exit 1; fi
