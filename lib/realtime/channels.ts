/**
 * Canonical realtime channel factory helpers.
 * Centralizes channel-name strings so every consumer stays in sync.
 */

import { createClient } from "@/lib/supabase/browser";
import { PLATFORM_ALERTS_TOPIC } from "./topics";

/**
 * Platform-wide alerts broadcast channel.
 * Subscribed by useAlertsRealtime to receive cross-tenant alert broadcasts.
 */
export function alertsPlatform() {
  return createClient().channel(PLATFORM_ALERTS_TOPIC, { config: { private: true } });
}
