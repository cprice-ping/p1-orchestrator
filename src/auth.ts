/**
 * auth.ts — OAuth client leg for the orchestrator.
 *
 * The P1 MCP server speaks MCP authorization (OAuth 2.1). The orchestrator
 * is a conforming MCP client of that server, so it runs the SAME flow the
 * P1 MCP Server itself uses against the SAME pre-wired client:
 *
 *   client_id: pingone-mcp-server   (pre-registered in the admin env)
 *   flow:      authorization_code + PKCE (S256), localhost callback
 *   scopes:    openid profile offline_access  (offline_access → refresh)
 *   identity:  the admin person who logs in via the browser
 *
 * Token source precedence:
 *   1. P1_ACCESS_TOKEN env       (CI/headless one-shots)
 *   2. cached OAuth tokens       (~/.p1-orchestrator/tokens.json, refresh on expiry)
 *   3. fresh browser flow        (opens the admin's browser, once)
 *
 * A cached refresh token means the human sees the browser at most once per
 * refresh-token lifetime — identical UX to attaching the P1 server to
 * Claude Code directly.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, chmod, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  token_type: string;
}

const CLIENT_ID = "pingone-mcp-server";
const REDIRECT_PORT = 7474;
const SCOPES = "openid profile offline_access";
const TOKEN_CACHE = join(homedir(), ".p1-orchestrator", "tokens.json");
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

function asBase(envId: string) {
  return `https://auth.pingone.com/${envId}/as`;
}

// --- PKCE -----------------------------------------------------------------

function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

// --- localhost callback ----------------------------------------------------

interface CallbackResult {
  code?: string;
  error?: string;
}

/** Spin a one-shot HTTP server; resolve with the auth code or error. */
function waitForCallback(port: number): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        srv.close();
        reject(new Error("Timed out waiting for OAuth callback"));
      },
      CALLBACK_TIMEOUT_MS,
    );

    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const done = (html: string, status: number) => {
        res.writeHead(status, { "Content-Type": "text/html" });
        res.end(html);
        clearTimeout(timer);
        srv.close();
      };

      const error = url.searchParams.get("error");
      if (error) {
        done(
          `<html><body><h3>Auth failed</h3><p>${error}: ${url.searchParams.get("error_description") ?? ""}</p></body></html>`,
          400,
        );
        resolve({ error, error_description: url.searchParams.get("error_description") ?? "" } as CallbackResult);
        return;
      }
      const code = url.searchParams.get("code");
      if (code) {
        done(
          "<html><body><h3>Authorized.</h3><p>You can close this tab and return to the terminal.</p></body></html>",
          200,
        );
        resolve({ code });
        return;
      }
      done("<html><body>Waiting for authorization...</body></html>", 200);
    });

    srv.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Cannot bind OAuth callback port ${port}: ${err.message}`));
    });
    srv.listen(port, "127.0.0.1");
  });
}

// --- token cache ------------------------------------------------------------

async function loadCache(): Promise<TokenSet | undefined> {
  try {
    const raw = await readFile(TOKEN_CACHE, "utf8");
    const t = JSON.parse(raw) as TokenSet;
    if (typeof t.access_token === "string" && typeof t.expires_at === "number") {
      return t;
    }
  } catch {
    /* no cache or unreadable — fall through to fresh flow */
  }
  return undefined;
}

async function saveCache(t: TokenSet): Promise<void> {
  await mkdir(join(TOKEN_CACHE, ".."), { recursive: true });
  await writeFile(TOKEN_CACHE, JSON.stringify(t, null, 2), { mode: 0o600 });
  await chmod(TOKEN_CACHE, 0o600);
}

export async function clearTokenCache(): Promise<void> {
  try {
    await unlink(TOKEN_CACHE);
  } catch {
    /* already gone */
  }
}

// --- the dance ---------------------------------------------------------------

function openBrowser(url: string): void {
  try {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Headless or no `open`: the URL is printed to stderr below; the admin
    // can open it on any machine that can reach the callback host.
    console.error("Open this URL to authorize:\n", url);
  }
}

async function exchangeCode(
  envId: string,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenSet> {
  const res = await fetch(`${asBase(envId)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as Record<string, unknown>;
  return {
    access_token: j.access_token as string,
    refresh_token: j.refresh_token as string | undefined,
    expires_at: Date.now() + Number(j.expires_in ?? 3600) * 1000,
    token_type: (j.token_type as string) ?? "Bearer",
  };
}

async function refreshToken(envId: string, rt: string): Promise<TokenSet> {
  const res = await fetch(`${asBase(envId)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: rt,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw new Error(`Refresh failed: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as Record<string, unknown>;
  return {
    access_token: j.access_token as string,
    // PingOne may or may not rotate the refresh token; keep old if absent.
    refresh_token: (j.refresh_token as string | undefined) ?? rt,
    expires_at: Date.now() + Number(j.expires_in ?? 3600) * 1000,
    token_type: (j.token_type as string) ?? "Bearer",
  };
}

export interface TokenSourceResult {
  token: string;
  via: "env" | "cache" | "refresh" | "browser";
}

/**
 * Resolve a valid access token for the P1 MCP server, acting as the
 * logged-in admin person. Env override first (CI), then cache/refresh,
 * then the one-time browser dance.
 */
export async function resolveToken(
  envId: string,
  mcpUrl: string,
): Promise<TokenSourceResult> {
  // 1. explicit env token — CI / headless one-shots
  if (process.env.P1_ACCESS_TOKEN) {
    return { token: process.env.P1_ACCESS_TOKEN, via: "env" };
  }

  // 2. cached token (still valid?)
  const cached = await loadCache();
  if (cached && cached.expires_at > Date.now() + 60_000) {
    return { token: cached.access_token, via: "cache" };
  }

  // 3. refresh if we hold a refresh token
  if (cached?.refresh_token) {
    try {
      const fresh = await refreshToken(envId, cached.refresh_token);
      await saveCache(fresh);
      return { token: fresh.access_token, via: "refresh" };
    } catch (err) {
      console.error(
        "Token refresh failed; falling back to fresh browser login:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 4. fresh browser flow
  const { verifier, challenge } = pkcePair();
  const redirectUri = `http://localhost:${REDIRECT_PORT}/callback`;
  const state = randomBytes(12).toString("hex");

  const authUrl = new URL(`${asBase(envId)}/authorize`);
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  console.error(
    `\n[p1-orchestrator] No valid PingOne token. Opening browser to sign in as an admin…\n` +
      `  (first run only; tokens are cached and refreshed at ${TOKEN_CACHE})\n`,
  );
  openBrowser(authUrl.toString());

  const cb = await waitForCallback(REDIRECT_PORT);
  if (cb.error || !cb.code) {
    throw new Error(`OAuth failed: ${cb.error ?? "no code in callback"}`);
  }
  const tokens = await exchangeCode(envId, cb.code, verifier, redirectUri);
  await saveCache(tokens);
  return { token: tokens.access_token, via: "browser" };
}
