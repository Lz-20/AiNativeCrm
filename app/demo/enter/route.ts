import { NextResponse } from "next/server";

import { safeNext } from "@/lib/auth/safe-next";
import { createClient } from "@/lib/supabase/server";
import { DEMO_EMAIL, DEMO_PASSWORD, isDemoModeEnabled } from "@/lib/demo/config";
import { ensureDemoData } from "@/lib/demo/seed";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"), "/app/kanban");
  if (!isDemoModeEnabled()) return NextResponse.redirect(new URL("/login", url));

  const supabase = await createClient();
  const { data: current } = await supabase.auth.getUser();
  if (current.user) return NextResponse.redirect(new URL(next, url));

  await ensureDemoData();
  const { error } = await supabase.auth.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  if (error) {
    return NextResponse.redirect(new URL(`/login?error=demo&next=${encodeURIComponent(next)}`, url));
  }
  return NextResponse.redirect(new URL(next, url));
}
