---
impacto: capacidade_nova
secao: corrigido
titulo: Supabase self-host pode usar rede interna sem quebrar URLs de mídia no navegador
---

O servidor e os workers aceitam `SUPABASE_INTERNAL_URL` opcional, preservando a
URL pública para navegador e links assinados de mídia. O health check consulta a
mesma rede do app sem revelar a configuração interna; instalações com uma única
URL mantêm o comportamento anterior.
