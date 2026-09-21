// Leitura dos claims do JWT da Unbox. NÃO valida assinatura: serve para extrair o shopId/shopSlug
// da loja e para saber se o token já venceu, duas coisas que o próprio portador pode ler.
//
// Quem valida de verdade é o gateway de parceiros, a cada chamada. Decidir autorização por estes
// claims, sem a chamada, seria confiar num texto que o dono do cookie escreve.
//
// Sem `Buffer`: a loja lê isto também no Edge Runtime (middleware), e lá `Buffer` não existe.

/** Claim do shopId no access_token da loja. */
export const SHOP_ID_CLAIM = "arn:unbox:shopId";
/** Claim do shopSlug no access_token da loja. */
export const SHOP_SLUG_CLAIM = "arn:unbox:shopSlug";

function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  if (typeof atob === "function") {
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }
  // Node antigo sem `atob` global.
  return Buffer.from(padded, "base64").toString("utf-8");
}

/** Decodifica os claims do JWT (sem validar — só para extrair shopId/shopSlug/exp).
 *  Token torto devolve `{}`: quem chama trata a ausência do claim, nunca uma exceção. */
export function decodeJwtClaims(jwt: string): Record<string, any> {
  try {
    const payload = String(jwt).split(".")[1];
    if (!payload) return {};
    return JSON.parse(base64UrlDecode(payload));
  } catch {
    return {};
  }
}

/**
 * TOKEN VENCIDO VALE COMO DESLOGADO. O cookie do cliente dura o mesmo que o JWT, mas relógio e
 * renovação não são garantia: sem esta conta, a loja se acha logada, toda consulta quebra com erro
 * opaco do backend e a conta vira beco sem saída, sem mostrar pedido e sem mandar para o login.
 *
 * Token sem `exp` NÃO é tratado como vencido: quem decide é o gateway, e inventar um vencimento
 * aqui deslogaria uma sessão válida.
 */
export function isJwtExpired(jwt: string, agoraMs = Date.now()): boolean {
  const exp = decodeJwtClaims(jwt).exp;
  return typeof exp === "number" && agoraMs >= exp * 1000;
}

/** shopId/shopSlug declarados no token da loja (vazio quando o claim não vem). */
export function shopClaimsFromToken(jwt: string): { shopId: string; shopSlug: string } {
  const claims = decodeJwtClaims(jwt);
  return {
    shopId: typeof claims[SHOP_ID_CLAIM] === "string" ? claims[SHOP_ID_CLAIM] : "",
    shopSlug: typeof claims[SHOP_SLUG_CLAIM] === "string" ? claims[SHOP_SLUG_CLAIM] : "",
  };
}
