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
 *   2. in-process token memory   (this process only, keyed by login env,
 *                                 refresh on expiry — NO token file exists)
 *   3. fresh browser flow        (opens the admin's browser, once)
 *
 * Tokens die with this process — no credential at rest for another
 * process to read. Another agent seeking direct P1 access must run its
 * own AuthN request: silent while the human's AS session lasts (SSO
 * mints the code), interactive when no session exists. The human gates
 * session establishment — not each action.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
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

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Spin a one-shot HTTP server on /callback; resolve with the auth code or
 *  error. The `state` must round-trip unchanged (CSRF protection); requests
 *  to any other path (favicon etc.) get a 404 and leave the server up. */
function waitForCallback(port: number, expectedState: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        srv.close();
        reject(new Error("Timed out waiting for OAuth callback"));
      },
      CALLBACK_TIMEOUT_MS,
    );

    const srv = createServer((req, res) => {
      // No keep-alive: a lingering socket would route a later login's
      // callback to this (finished) server.
      res.setHeader("Connection", "close");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const done = (html: string, status: number, result: CallbackResult) => {
        res.writeHead(status, { "Content-Type": "text/html" });
        res.end(html);
        clearTimeout(timer);
        srv.close();
        resolve(result);
      };

      if (url.searchParams.get("state") !== expectedState) {
        done(
          "<html><body><h3>Auth failed</h3><p>State mismatch — this callback was not started by this login. Retry from the terminal.</p></body></html>",
          400,
          { error: "state_mismatch" },
        );
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description") ?? "";
        done(
          `<html><body><h3>Auth failed</h3><p>${escapeHtml(error)}: ${escapeHtml(description)}</p></body></html>`,
          400,
          { error: description ? `${error}: ${description}` : error },
        );
        return;
      }
      const code = url.searchParams.get("code");
      if (code) {
        done(
          "<html><body><h3>Authorized.</h3><p>You can close this tab and return to the terminal.</p></body></html>",
          200,
          { code },
        );
        return;
      }
      done("<html><body><h3>Auth failed</h3><p>No authorization code in callback.</p></body></html>", 400, {
        error: "no code in callback",
      });
    });

    srv.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Cannot bind OAuth callback port ${port}: ${err.message}`));
    });
    srv.listen(port, "127.0.0.1");
  });
}

// --- token cache (in-process only) ------------------------------------------

/** Tokens live in THIS process's memory and nowhere else — no token file.
 *  The orchestrator is the agent's only P1 surface: the server holds the
 *  tokens so no model (or other local process) ever reads one. The cost is
 *  that tokens die with the server — each session's first dispatch does the
 *  browser dance — silent re-mint while the human's AS session lives,
 *  interactive once per session. Keyed by login env
 *  so switching P1_MCP_URL never reuses (or refreshes against) the wrong
 *  env's tokens. */
const tokenMemory = new Map<string, TokenSet>();

function loadCache(envId: string): TokenSet | undefined {
  const t = tokenMemory.get(envId);
  if (t && typeof t.access_token === "string" && typeof t.expires_at === "number") {
    return t;
  }
  return undefined;
}

function saveCache(envId: string, t: TokenSet): void {
  tokenMemory.set(envId, t);
}

// --- the dance ---------------------------------------------------------------

function openBrowser(url: string): void {
  // Always print the URL: headless hosts, missing openers, or a browser on
  // another machine (which must still reach the localhost callback).
  console.error("Open this URL to authorize:\n", url);
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // A missing opener surfaces as an async 'error' event, not a throw;
    // without this listener it would crash the server.
    child.on("error", () => {});
    child.unref();
  } catch {
    /* URL already printed */
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
  _mcpUrl: string,
): Promise<TokenSourceResult> {
  // 1. explicit env token — CI / headless one-shots
  if (process.env.P1_ACCESS_TOKEN) {
    return { token: process.env.P1_ACCESS_TOKEN, via: "env" };
  }
  // Concurrent dispatches share one in-flight resolution per env, so two
  // cold calls never race for the callback port or rotate the refresh token
  // out from under each other.
  const pending = inFlight.get(envId);
  if (pending) return pending;
  const p = resolveFromCacheOrLogin(envId).finally(() => inFlight.delete(envId));
  inFlight.set(envId, p);
  return p;
}

const inFlight = new Map<string, Promise<TokenSourceResult>>();

async function resolveFromCacheOrLogin(envId: string): Promise<TokenSourceResult> {
  // 2. cached token (still valid?)
  const cached = loadCache(envId);
  if (cached && cached.expires_at > Date.now() + 60_000) {
    return { token: cached.access_token, via: "cache" };
  }

  // 3. refresh if we hold a refresh token
  if (cached?.refresh_token) {
    try {
      const fresh = await refreshToken(envId, cached.refresh_token);
      saveCache(envId, fresh);
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
      `  (once per orchestrator session; tokens live in the server process only)\n`,
  );
  openBrowser(authUrl.toString());

  const cb = await waitForCallback(REDIRECT_PORT, state);
  if (cb.error || !cb.code) {
    throw new Error(`OAuth failed: ${cb.error ?? "no code in callback"}`);
  }
  const tokens = await exchangeCode(envId, cb.code, verifier, redirectUri);
  saveCache(envId, tokens);
  return { token: tokens.access_token, via: "browser" };
}
