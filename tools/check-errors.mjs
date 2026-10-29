// ═══════════════════════════════════════════════════════════════════════════════════════
// CHECAGEM DE ERROS E AUTENTICAÇÃO — npm run build && node tools/check-errors.mjs
//
// Não há suíte de testes no pacote; isto cobre o que a 0.4.0 mudou no caminho de auth e de erro,
// contra o `dist/` compilado. O `fetch` global é trocado por um falso que responde por roteiro e
// REGISTRA os cabeçalhos de cada chamada: é assim que dá para afirmar "nenhum Authorization com
// Bearer" e "um signIn só", que são as garantias que a CLI precisa.
//
// Fica fora do `files` do package.json: não vai para o npm.
// ═══════════════════════════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";
import {
  UnboxClient, UnboxError, connectUnboxStore, isMissingPermissionError, isUnboxTimeout,
} from "../dist/index.js";

const API_KEY = "da2-chave-do-parceiro-de-teste";
const USER = "api_loja_teste";
const PASS = "senha-$ecreta-`teste`";

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function fakeJwt(n) {
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  return `${b64url({ alg: "none" })}.${b64url({ exp, n, "arn:unbox:shopId": "SHOP123" })}.sig`;
}

/** Troca o fetch global. `routes.signIn` e `routes.gql` recebem o número da chamada (0, 1, ...)
 *  e os headers, e devolvem `{ status, body }` (body objeto vira JSON; string vai crua). */
function installFetch(routes) {
  const calls = [];
  let signIns = 0;
  let gqls = 0;
  globalThis.fetch = async (_url, init) => {
    const headers = { ...init.headers };
    const payload = JSON.parse(init.body);
    const isSignIn = /signIn\(/.test(payload.query);
    calls.push({ kind: isSignIn ? "signIn" : "gql", headers, query: payload.query });
    const route = isSignIn ? routes.signIn : routes.gql;
    const r = await route(isSignIn ? signIns++ : gqls++, headers, payload);
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return {
    calls,
    count: (kind) => calls.filter((c) => c.kind === kind).length,
  };
}

const okSignIn = (n) => ({ body: { data: { signIn: { access_token: fakeJwt(n), id_token: "x" } } } });
const creds = { partnerApiKey: API_KEY, user: USER, pass: PASS };
const NO_USER = "Unauthorized - No authenticated user";
const NO_PERMISSION = "Unauthorized - Missing required permissions";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(["ok", name]);
  } catch (e) {
    results.push(["FALHOU", name, e]);
  }
}

function assertNoSecrets(err) {
  const text = `${err.message} ${JSON.stringify(err.errors ?? [])}`;
  for (const s of [API_KEY, PASS, USER]) assert.ok(!text.includes(s), `segredo na mensagem: ${s}`);
}

function assertRawEverywhere(calls) {
  for (const c of calls) {
    assert.equal(c.headers["x-api-key"], API_KEY, `${c.kind} sem x-api-key`);
    if (c.kind === "gql") {
      assert.ok(c.headers.Authorization, "gql sem Authorization");
      assert.ok(!/^Bearer /i.test(c.headers.Authorization), `Authorization com Bearer: ${c.headers.Authorization}`);
    }
  }
}

// ── code ────────────────────────────────────────────────────────────────────────────
await check("code lê extensions.code", () => {
  assert.equal(new UnboxError("x", [{ message: "m", extensions: { code: "SOME_CODE" } }]).code, "SOME_CODE");
});
await check("code cai para errorType", () => {
  assert.equal(new UnboxError("x", [{ message: "m", errorType: "Unauthorized" }]).code, "Unauthorized");
});
await check("code dá TIMEOUT no timeout", () => {
  assert.equal(new UnboxError("TIMEOUT", [{ message: "TIMEOUT" }]).code, "TIMEOUT");
});
await check("code é undefined sem extensions.code nem errorType", () => {
  assert.equal(new UnboxError("x", [{ message: "m" }]).code, undefined);
  assert.equal(new UnboxError("x").code, undefined);
});

// ── isMissingPermissionError ────────────────────────────────────────────────────────
await check("isMissingPermissionError: verdadeiro para Missing required permissions", () => {
  assert.equal(isMissingPermissionError(new UnboxError(NO_PERMISSION, [{ message: NO_PERMISSION }])), true);
});
await check("isMissingPermissionError: falso para No authenticated user", () => {
  assert.equal(isMissingPermissionError(new UnboxError(NO_USER, [{ message: NO_USER }])), false);
});
await check("isMissingPermissionError: falso para FORBIDDEN_ERROR e para HTTP 403", () => {
  assert.equal(isMissingPermissionError(new UnboxError("FORBIDDEN_ERROR", [{ message: "FORBIDDEN_ERROR", extensions: { code: "FORBIDDEN" } }])), false);
  assert.equal(isMissingPermissionError(new UnboxError('HTTP 403: {"message":"Forbidden"}', [{ message: "HTTP 403", extensions: { code: "HTTP_403" } }])), false);
});

// ── authScheme: "raw" ───────────────────────────────────────────────────────────────
await check('raw: renova uma vez em "No authenticated user", sem Bearer em chamada nenhuma', async () => {
  const f = installFetch({
    signIn: okSignIn,
    gql: (n) => (n === 0 ? { body: { errors: [{ message: NO_USER }] } } : { body: { data: { ok: true } } }),
  });
  const store = connectUnboxStore({ ...creds, authScheme: "raw" });
  const data = await store.withStoreClient((c) => c.gql("query{ ok }"));
  assert.deepEqual(data, { ok: true });
  assert.equal(f.count("signIn"), 2, "signIns");
  assert.equal(f.count("gql"), 2, "uma chamada e uma repetição");
  assertRawEverywhere(f.calls);
});

await check("raw: um signIn para duas chamadas", async () => {
  const f = installFetch({ signIn: okSignIn, gql: () => ({ body: { data: { ok: true } } }) });
  const store = connectUnboxStore({ ...creds, authScheme: "raw" });
  await store.withStoreClient((c) => c.gql("query{ ok }"));
  await store.withStoreClient((c) => c.gql("query{ ok }"));
  assert.equal(f.count("signIn"), 1);
  assert.equal(f.count("gql"), 2);
  assertRawEverywhere(f.calls);
});

await check('raw: "Missing required permissions" não renova nem repete', async () => {
  const f = installFetch({
    signIn: okSignIn,
    gql: () => ({ body: { errors: [{ message: NO_PERMISSION }] } }),
  });
  const store = connectUnboxStore({ ...creds, authScheme: "raw" });
  const err = await store.withStoreClient((c) => c.gql("query{ ok }")).then(() => null, (e) => e);
  assert.ok(err instanceof UnboxError);
  assert.equal(isMissingPermissionError(err), true);
  assert.equal(f.count("signIn"), 1);
  assert.equal(f.count("gql"), 1, "zero repetições");
  assertRawEverywhere(f.calls);
});

await check("raw: mutation não dispara a sonda shopBySlug", async () => {
  const f = installFetch({ signIn: okSignIn, gql: () => ({ body: { data: { m: true } } }) });
  const store = connectUnboxStore({ ...creds, authScheme: "raw" });
  await store.withStoreClient((c) => c.gql("mutation{ m }"));
  assert.equal(f.count("gql"), 1);
  assert.ok(!f.calls.some((c) => /shopBySlug/.test(c.query)), "sonda disparada");
  assertRawEverywhere(f.calls);
});

await check("raw: getShopContext e shopClaimsFromToken dão o shopId do claim", async () => {
  installFetch({ signIn: okSignIn, gql: () => ({ body: { data: {} } }) });
  const store = connectUnboxStore({ ...creds, authScheme: "raw" });
  assert.equal((await store.getShopContext()).shopId, "SHOP123");
});

// ── Erros de transporte ─────────────────────────────────────────────────────────────
const HTML_502 = "<html><body><h1>502 Bad Gateway</h1></body></html>";

await check("signIn com HTML 502 lança UnboxError HTTP_502, com prefixo signIn", async () => {
  installFetch({ signIn: () => ({ status: 502, body: HTML_502 }), gql: () => ({ body: {} }) });
  const err = await new UnboxClient({ partnerApiKey: API_KEY }).signIn(USER, PASS).then(() => null, (e) => e);
  assert.ok(err instanceof UnboxError, String(err));
  assert.equal(err.code, "HTTP_502");
  assert.ok(err.message.startsWith("signIn: HTTP 502"), err.message);
  assert.equal(err.errors[0].message, "HTTP 502");
  assertNoSecrets(err);
});

await check("signIn com 401 sem errors[] lança HTTP_401 (e não 'sem access_token')", async () => {
  installFetch({ signIn: () => ({ status: 401, body: { message: "Unauthorized" } }), gql: () => ({ body: {} }) });
  const err = await new UnboxClient({ partnerApiKey: API_KEY }).signIn(USER, PASS).then(() => null, (e) => e);
  assert.equal(err?.code, "HTTP_401");
  assert.ok(err.message.startsWith("signIn: "), err.message);
  assertNoSecrets(err);
});

await check("signIn com senha errada mantém a mensagem do servidor com prefixo signIn", async () => {
  installFetch({ signIn: () => ({ body: { errors: [{ message: "Incorrect username or password." }] } }), gql: () => ({ body: {} }) });
  const err = await new UnboxClient({ partnerApiKey: API_KEY }).signIn(USER, PASS).then(() => null, (e) => e);
  assert.equal(err?.message, "signIn: Incorrect username or password.");
  assertNoSecrets(err);
});

await check("signIn com timeout lança UNBOX_TIMEOUT", async () => {
  globalThis.fetch = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const err = await new UnboxClient({ partnerApiKey: API_KEY }).signIn(USER, PASS).then(() => null, (e) => e);
  assert.ok(isUnboxTimeout(err), String(err));
  assert.equal(err.code, "TIMEOUT");
});

await check("gql com HTML 502 lança HTTP_502", async () => {
  installFetch({ signIn: okSignIn, gql: () => ({ status: 502, body: HTML_502 }) });
  const store = connectUnboxStore({ ...creds, authScheme: "raw" });
  const err = await store.withStoreClient((c) => c.gql("query{ ok }")).then(() => null, (e) => e);
  assert.ok(err instanceof UnboxError, String(err));
  assert.equal(err.code, "HTTP_502");
  assert.ok(err.message.startsWith("HTTP 502: <html>"), err.message);
  assertNoSecrets(err);
});

await check('gql com 403 {"message":"Forbidden"} lança HTTP_403 em vez de devolver undefined', async () => {
  installFetch({ signIn: okSignIn, gql: () => ({ status: 403, body: { message: "Forbidden" } }) });
  const store = connectUnboxStore({ ...creds, authScheme: "raw" });
  const err = await store.withStoreClient((c) => c.gql("query{ ok }")).then(() => null, (e) => e);
  assert.ok(err instanceof UnboxError, String(err));
  assert.equal(err.code, "HTTP_403");
  assert.equal(isMissingPermissionError(err), false);
  assertNoSecrets(err);
});

await check('corpo HTTP com "token expired" não dispara renovação nem repete a mutation', async () => {
  const f = installFetch({
    signIn: okSignIn,
    gql: () => ({ status: 504, body: "<html>gateway timeout: upstream token expired</html>" }),
  });
  const store = connectUnboxStore({ ...creds, authScheme: "raw" });
  const err = await store.withStoreClient((c) => c.gql("mutation{ placeOrder }")).then(() => null, (e) => e);
  assert.equal(err?.code, "HTTP_504");
  assert.equal(f.count("signIn"), 1, "renovou");
  assert.equal(f.count("gql"), 1, "repetiu a mutation");
});

// ── Sem authScheme: o comportamento de sempre ──────────────────────────────────────
// Por último: este caso memoriza "bearer" no módulo, de propósito.
await check("sem authScheme: consulta recusada repete com Bearer, como antes", async () => {
  const f = installFetch({
    signIn: okSignIn,
    gql: (_n, headers) => (/^Bearer /.test(headers.Authorization)
      ? { body: { data: { ok: true } } }
      : { body: { errors: [{ message: "Unauthorized" }] } }),
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const store = connectUnboxStore(creds);
    const data = await store.withStoreClient((c) => c.gql("query{ ok }"));
    assert.deepEqual(data, { ok: true });
  } finally {
    console.warn = warn;
  }
  const gqls = f.calls.filter((c) => c.kind === "gql");
  assert.equal(gqls.length, 2);
  assert.ok(!/^Bearer /.test(gqls[0].headers.Authorization));
  assert.ok(/^Bearer /.test(gqls[1].headers.Authorization));
});

let failed = 0;
for (const [status, name, err] of results) {
  console.log(`${status === "ok" ? "  ok    " : "  FALHOU"} ${name}`);
  if (err) {
    failed++;
    console.log(`         ${String(err?.message ?? err).split("\n").join("\n         ")}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} checagens passaram`);
process.exitCode = failed ? 1 : 0;
