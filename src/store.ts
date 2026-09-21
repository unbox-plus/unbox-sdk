// Fábrica do client de LOJA: signIn uma vez, token em cache, re-signin quando vence.
//
// REGRA DE OURO: NÃO fazer signIn() a cada request. O access_token da loja vale ~24h e o signIn é
// a chamada mais lenta da API (passa pela borda com captcha); pedir um por request transforma
// cada página da loja em duas chamadas e estoura o rate-limit do gateway num pico de tráfego.
//
// O cache vive no MÓDULO da instância criada por `createUnboxStore`: em dev e em servidor único
// isso basta. Em serverless (Vercel), cada lambda tem o seu — é um signIn por lambda fria, não um
// por request. Para compartilhar entre lambdas, passe um `tokenStore` (Vercel KV, Edge Config,
// Redis): é o único ponto que precisa mudar.
//
// Este arquivo NÃO lê `process.env` por conta própria (fora do helper explícito
// `credentialsFromEnv`). Quem monta a loja decide de onde vêm as credenciais, e é por isso que o
// SDK é testável sem ambiente: `createUnboxStore({ partnerApiKey: "...", user, pass })`.

import { UnboxClient, UnboxError } from "./client.js";
import { UnboxCustomerClient } from "./customer.js";
import { decodeJwtClaims, isJwtExpired, shopClaimsFromToken } from "./jwt.js";
import type { CatalogProduct, Connection } from "./types.js";

/** Credenciais da loja. A api key é do PARCEIRO (vale para todas as lojas dele); QUAL loja é o
 *  user/senha que diz, no signIn. Tudo aqui é SEGREDO DE SERVIDOR: nunca instancie no browser. */
export interface UnboxCredentials {
  /** api key do PARCEIRO (`x-api-key`, ex.: `da2-...`). */
  partnerApiKey: string;
  /** usuário de API da loja (ex.: `api_minhaloja`). */
  user: string;
  /** senha do usuário de API. */
  pass: string;
  /** shopId da loja. Vazio: sai do claim `arn:unbox:shopId` do token. */
  shopId?: string;
  /** slug da loja. Vazio: sai do claim `arn:unbox:shopSlug` do token. */
  shopSlug?: string;
  /** endpoint GraphQL de parceiros. Default: https://partners.unbox.com.br/graphql */
  partnerGqlUrl?: string;
  /** timeout por request (ms). Default: 15000. */
  timeoutMs?: number;
  /** idioma de respostas/rótulos. Default: "pt-BR". */
  language?: string;
}

/** Onde guardar o token entre processos. Sem isso, o cache é o da instância (por lambda). */
export interface UnboxTokenStore {
  read(): Promise<CachedToken | null> | CachedToken | null;
  write(token: CachedToken): Promise<void> | void;
}

export interface CachedToken {
  token: string;
  /** epoch ms em que o token deve ser renovado (exp menos a folga). */
  expMs: number;
  shopId: string;
  shopSlug: string;
}

export interface ShopContext {
  shopId: string;
  shopSlug: string;
}

export interface UnboxStore {
  /** As três credenciais obrigatórias estão preenchidas? Falso = a loja roda em modo mockup. */
  readonly hasCredentials: boolean;
  /** shopId/shopSlug resolvidos (credencial explícita ganha; senão sai do claim do token). */
  getShopContext(): Promise<ShopContext>;
  /** UnboxClient de loja já autenticado (token do cache). */
  getStoreClient(): Promise<UnboxClient>;
  /** Executa `fn` com o client de loja e repete UMA vez, com token novo, se o token tinha vencido. */
  withStoreClient<T>(fn: (client: UnboxClient) => Promise<T>): Promise<T>;
  /** Client da ÁREA DO CLIENTE a partir do token do cliente final. `null` se o token estiver
   *  ausente ou vencido — que é o mesmo que deslogado. */
  getCustomerClient(customerToken: string | null | undefined): Promise<UnboxCustomerClient | null>;
  /** Percorre o catálogo INTEIRO por offset (sitemap, llms.txt, listagens completas). */
  loadAllCatalogItems(opts?: { tagIds?: string[]; searchText?: string; pageSize?: number }): Promise<any[]>;
  /** Descarta o token em cache (o próximo acesso faz signIn). */
  invalidateToken(): void;
}

const RENEW_BUFFER_MS = 60 * 60 * 1000; // renova 1h antes de expirar
const FALLBACK_TTL_H = 23;              // token sem `exp` legível: assume ~23h
const CATALOG_PAGE = 100;

/** As três juntas habilitam o modo real; faltando qualquer uma, a loja roda em modo mockup. */
export function hasUnboxCredentials(c: Partial<UnboxCredentials> | null | undefined): boolean {
  return Boolean(c?.partnerApiKey && c?.user && c?.pass);
}

/**
 * Credenciais a partir das variáveis de ambiente padrão da Unbox. Não lança com ambiente vazio:
 * a loja sem credencial roda em modo mockup, e quem descobre isso é `hasCredentials`, na primeira
 * chamada de verdade — validar no import derrubaria o app inteiro no boot.
 */
export function credentialsFromEnv(env: Record<string, string | undefined> = process.env): UnboxCredentials {
  return {
    partnerApiKey: env.UNBOX_PARTNER_API_KEY ?? "",
    user: env.UNBOX_USER ?? "",
    pass: env.UNBOX_PASS ?? "",
    shopId: env.UNBOX_SHOP_ID ?? "",
    shopSlug: env.UNBOX_SHOP_SLUG ?? "",
    partnerGqlUrl: env.UNBOX_PARTNER_GRAPHQL_URL || undefined,
  };
}

export const MISSING_CREDENTIALS =
  "[unbox] credenciais ausentes (UNBOX_PARTNER_API_KEY/UNBOX_USER/UNBOX_PASS) — preencha .env.local. Rodando em modo mockup.";

/**
 * Cria a loja: uma instância, um cache de token, um signIn.
 *
 * As credenciais podem vir como função para serem lidas no primeiro uso, e não no import — é
 * assim que o Next consegue importar o módulo num build sem ambiente.
 */
export function createUnboxStore(
  credenciais: UnboxCredentials | (() => UnboxCredentials),
  opts: { tokenStore?: UnboxTokenStore } = {},
): UnboxStore {
  const ler = (): UnboxCredentials => (typeof credenciais === "function" ? credenciais() : credenciais);

  let cache: CachedToken | null = null;
  let inFlight: Promise<CachedToken> | null = null;

  async function doSignIn(): Promise<CachedToken> {
    const cfg = ler();
    if (!hasUnboxCredentials(cfg)) throw new Error(MISSING_CREDENTIALS);
    const client = new UnboxClient({
      partnerApiKey: cfg.partnerApiKey,
      partnerGqlUrl: cfg.partnerGqlUrl,
      shopId: cfg.shopId,
      language: cfg.language,
      timeoutMs: cfg.timeoutMs,
    });
    const token = await client.signIn(cfg.user, cfg.pass);
    const claims = shopClaimsFromToken(token);
    const exp = decodeExpSec(token);
    return {
      token,
      expMs: exp * 1000 - RENEW_BUFFER_MS,
      shopId: cfg.shopId || claims.shopId,
      shopSlug: cfg.shopSlug || claims.shopSlug,
    };
  }

  async function getCachedToken(force = false): Promise<CachedToken> {
    if (!force && cache && Date.now() < cache.expMs) return cache;
    // Cache externo (KV): serve para a lambda fria não repetir o signIn que outra já fez.
    if (!force && !cache && opts.tokenStore) {
      const guardado = await opts.tokenStore.read();
      if (guardado && Date.now() < guardado.expMs) {
        cache = guardado;
        return guardado;
      }
    }
    // Uma requisição só, mesmo com dez páginas pedindo token no mesmo instante.
    if (inFlight) return inFlight;
    inFlight = doSignIn()
      .then(async (c) => {
        cache = c;
        if (opts.tokenStore) await opts.tokenStore.write(c);
        return c;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  async function getStoreClient(): Promise<UnboxClient> {
    const cfg = ler();
    const c = await getCachedToken();
    const client = new UnboxClient({
      partnerApiKey: cfg.partnerApiKey,
      partnerGqlUrl: cfg.partnerGqlUrl,
      shopId: c.shopId,
      language: cfg.language,
      timeoutMs: cfg.timeoutMs,
    });
    client.setToken(c.token);
    return client;
  }

  async function withStoreClient<T>(fn: (client: UnboxClient) => Promise<T>): Promise<T> {
    const client = await getStoreClient();
    try {
      return await fn(client);
    } catch (e) {
      if (!isAuthExpired(e)) throw e;
      // Uma vez só, e só em falha de AUTENTICAÇÃO: repetir por qualquer erro seria repetir um
      // placeOrder recusado, que é criar o segundo pedido e cobrar duas vezes.
      const c = await getCachedToken(true);
      client.setToken(c.token);
      return fn(client);
    }
  }

  return {
    get hasCredentials() {
      return hasUnboxCredentials(ler());
    },
    async getShopContext(): Promise<ShopContext> {
      const c = await getCachedToken();
      return { shopId: c.shopId, shopSlug: c.shopSlug };
    },
    getStoreClient,
    withStoreClient,
    async getCustomerClient(customerToken) {
      if (!customerToken) return null;
      if (isJwtExpired(customerToken)) return null;
      // DUAS IDENTIDADES: o cliente logado vai no `x-customer-token`, mas a requisição continua
      // precisando do contexto de LOJA no Authorization — é dele que o gateway tira o shopId.
      const loja = await getStoreClient();
      return new UnboxCustomerClient({ customerToken, loja });
    },
    loadAllCatalogItems(o = {}) {
      return withStoreClient((client) => loadAllCatalogItems(client, o));
    },
    invalidateToken() {
      cache = null;
    },
  };
}

/** `exp` do token, em segundos. Token sem `exp` legível vale ~23h: é o prazo que a Unbox pratica,
 *  e errar para menos custa um signIn a mais, não uma chamada recusada. */
function decodeExpSec(token: string): number {
  const exp = decodeJwtClaims(token).exp;
  return typeof exp === "number" ? exp : Math.floor(Date.now() / 1000) + FALLBACK_TTL_H * 3600;
}

/**
 * Paginação completa do catálogo por OFFSET. NÃO confiar num `first` gigante: há teto de servidor
 * que trunca em silêncio, e a página some do sitemap sem nenhum erro. Itera em lotes até
 * `pageInfo.hasNextPage` virar false, com teto de segurança para o dia em que o contrato mudar.
 */
export async function loadAllCatalogItems(
  client: UnboxClient,
  opts: { tagIds?: string[]; searchText?: string; pageSize?: number } = {},
): Promise<Array<{ product: CatalogProduct }>> {
  const tamanho = opts.pageSize ?? CATALOG_PAGE;
  const all: Array<{ product: CatalogProduct }> = [];
  let offset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const page: Connection<{ product: CatalogProduct }> = await client.getCatalog({
      first: tamanho, offset, tagIds: opts.tagIds, searchText: opts.searchText,
    });
    const nodes = page.nodes ?? [];
    all.push(...nodes);
    if (!page.pageInfo?.hasNextPage || nodes.length === 0) break;
    offset += tamanho;
  }
  return all;
}

/** Recusa que é de TOKEN VENCIDO, e não da operação: só ela justifica repetir a chamada. */
function isAuthExpired(e: unknown): boolean {
  if (e instanceof UnboxError) {
    const msg = (e.errors?.[0]?.message ?? e.message ?? "").toUpperCase();
    return /ACCESS_DENIED|UNAUTHENTICATED|TOKEN|EXPIRED|401/.test(msg);
  }
  if (e instanceof Error) return /401|ACCESS_DENIED/i.test(e.message);
  return false;
}
