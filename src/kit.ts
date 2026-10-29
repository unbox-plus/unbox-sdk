// kit.ts — o que a loja precisa para montar a página de um kit (bundle) além da consulta do produto.
//
// Não existe `bundleId` na Unbox: um bundle é um conjunto de produtos de kit, um por opção de cota
// ("2 Box", "4 Box"), ligados por um grupo (`CatalogProduct.group.linkedProducts`) e de mesmo título.
// Trocar de opção é navegar para o `slug` do outro kit.

import type { CatalogProduct, KitTemplateSettings, LinkedProduct } from "./types.js";

/** Chave do bundle: o título, normalizado. É a única ligação entre as opções na listagem do catálogo. */
export const kitBundleKey = (title?: string | null): string => (title ?? "").trim().toLowerCase();

/** Agrupa produtos de kit de mesmo título em bundles. Mantém a ordem de chegada (o primeiro de cada
 *  grupo representa o bundle) e não mexe nos itens. */
export function groupKitsByTitle<T extends { title?: string | null }>(items: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const key = kitBundleKey(it.title);
    const group = groups.get(key);
    if (group) group.push(it); else groups.set(key, [it]);
  }
  return [...groups.values()];
}

/** As opções do bundle para o seletor da PDP: os kits vinculados e visíveis MAIS o kit atual (que o
 *  grupo não inclui), do mais barato ao mais caro. Sem grupo, só o próprio kit. */
export function kitOptions(product: Pick<CatalogProduct, "productId" | "title" | "slug" | "imageUrls" | "erpCode" | "group" | "pricing" | "pricingPerUnit" | "unitPriceLabel" | "requiredPicksPerGroup" | "kitGroupDescription" | "isSoldOut" | "relatedInfo">): LinkedProduct[] {
  const current: LinkedProduct = {
    productId: product.productId,
    erpCode: product.erpCode,
    title: product.title,
    label: product.group?.label ?? product.title,
    slug: product.slug,
    imageUrls: product.imageUrls,
    catalog: {
      pricing: product.pricing, pricingPerUnit: product.pricingPerUnit, unitPriceLabel: product.unitPriceLabel,
      requiredPicksPerGroup: product.requiredPicksPerGroup, kitGroupDescription: product.kitGroupDescription,
      isSoldOut: product.isSoldOut, relatedInfo: product.relatedInfo,
    },
  };
  const price = (o: LinkedProduct) => o.catalog?.pricing?.[0]?.minPrice ?? 0;
  // opção oculta no painel continua vinculada ao grupo, mas a página dela responde 404
  const linked = (product.group?.linkedProducts ?? []).filter((o) => o.catalog?.isVisible !== false);
  return [...linked, current].sort((a, b) => price(a) - price(b));
}

/**
 * Lê `kitDisplay` e `relatedKits` do template publicado da página (`publishedUrl` do produto).
 * ⚠️ O `publishedUrl` vem do painel e pode apontar para o domínio antigo: serve só para LER este JSON,
 * nunca como canonical. É um adorno da página, então qualquer falha (rede, prazo, JSON inesperado)
 * devolve `null` e a loja segue com o padrão, sem derrubar a PDP.
 */
export async function fetchKitTemplate(publishedUrl: string | null | undefined, opts: { timeoutMs?: number } = {}): Promise<KitTemplateSettings | null> {
  if (!publishedUrl || !/^https:\/\//i.test(publishedUrl)) return null;
  try {
    const res = await fetch(publishedUrl, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
    if (!res.ok) return null;
    const settings = ((await res.json()) as any)?.settings;
    if (!settings || typeof settings !== "object") return null;
    return { kitDisplay: settings.kitDisplay ?? null, relatedKits: settings.relatedKits ?? null };
  } catch {
    return null;
  }
}

/**
 * Confere as escolhas de um kit ANTES de ir à API. Na API, cota errada volta como
 * `MISSING_ITEMS_ERROR` ("produtos não estão mais disponíveis"), que não diz o que houve; aqui a
 * mensagem é a que o cliente final pode ler. Devolve `null` quando a escolha fecha a cota.
 */
export function kitPicksProblem(picks: Array<{ quantity: number }>, requiredPicks: number): string | null {
  if (picks.some((p) => !Number.isInteger(p.quantity) || p.quantity < 1)) return "Quantidade inválida em um dos itens do kit.";
  const total = picks.reduce((sum, p) => sum + p.quantity, 0);
  const item = (n: number) => `${n} ${n === 1 ? "item" : "itens"}`;
  if (total < requiredPicks) return `Escolha mais ${item(requiredPicks - total)} para completar o kit.`;
  if (total > requiredPicks) return `O kit leva ${item(requiredPicks)}: tire ${item(total - requiredPicks)}.`;
  return null;
}
