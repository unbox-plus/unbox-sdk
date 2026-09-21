// webhooks.ts — verificação de webhooks da Unbox (HMAC-SHA256 do corpo cru com o secret).
// Spec oficial: header X-Unbox-Signature = HMAC-SHA256(rawBody, secret) em hex.

import crypto from "node:crypto";

export type UnboxWebhookEventType = "PING" | "ORDER_CREATED" | "ORDER_STATUS_UPDATE";

export interface UnboxWebhookEnvelope<T = any> {
  _id: string;            // id único DESTA chamada (use para idempotência)
  type: UnboxWebhookEventType;
  data: T;
  createdAt: string;      // ISO 8601
}

export interface UnboxOrderWebhookData {
  orderId: string;
  shopSlug: string;
  shopDomain?: string;
  orderStatus: string;    // OrderStatusEnum
  paymentStatus: string;  // PaymentStatusEnum
  paymentType: "pix" | "credit" | "boleto";
  paymentTransactionId: string;
  paymentSummary: {
    itemsSubtotal: number; discountTotal: number;
    providerShippingCost: number; finalShippingCost: number; orderTotal: number;
  };
  discounts?: Array<{ code?: string; label?: string; description?: string; method: string; type: string }>;
  orderCreatedAt: string;
  orderUpdatedAt: string;
  utmParameters?: { campaignName: string; source: string; marketingMedium: string; targetContent?: string; searchTerms?: string };
}

/**
 * Verifica a assinatura `X-Unbox-Signature` de um webhook.
 * @param rawBody  corpo CRU do request (string exata — NÃO re-serialize o JSON antes).
 * @param signature valor do header `x-unbox-signature`.
 * @param secret   secret (ou LISTA de secrets) retornado(s) no subscribeToWebhook. Cada assinatura
 *                 de webhook tem o seu próprio secret (ex.: ORDER_CREATED e ORDER_STATUS_UPDATE
 *                 geram secrets diferentes) — passe todos para validar qualquer evento.
 * @returns true se a assinatura confere com ALGUM dos secrets (comparação em tempo constante).
 */
export function verifyUnboxWebhook(rawBody: string, signature: string, secret: string | string[]): boolean {
  if (!signature) return false;
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter(Boolean);
  if (!secrets.length) return false;
  const sig = Buffer.from(signature);
  return secrets.some((s) => {
    const expected = crypto.createHmac("sha256", s).update(rawBody, "utf-8").digest("hex");
    if (signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(sig, Buffer.from(expected));
  });
}

/**
 * Helper completo p/ Route Handler: valida a assinatura e devolve o evento tipado.
 * Lança se a assinatura for inválida. Trate `PING` (handshake) e deduplique por `evt._id`.
 *
 *   const evt = await parseUnboxWebhook(req, process.env.UNBOX_WEBHOOK_SECRET!);
 *   if (evt.type === "PING") return new Response("ok");
 */
export async function parseUnboxWebhook(req: Request, secret: string | string[]): Promise<UnboxWebhookEnvelope> {
  const raw = await req.text();
  const sig = req.headers.get("x-unbox-signature") ?? "";
  if (!verifyUnboxWebhook(raw, sig, secret)) throw new Error("UNBOX_WEBHOOK_INVALID_SIGNATURE");
  return JSON.parse(raw) as UnboxWebhookEnvelope;
}
