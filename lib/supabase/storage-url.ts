import { env } from "@/lib/env";
import { publicStorageUrl } from "./urls";

/** Para redirects, notificações, e-mail e URLs entregues a integrações externas. */
export function storageUrlForDelivery(url: string): string {
  return publicStorageUrl(url, env);
}
