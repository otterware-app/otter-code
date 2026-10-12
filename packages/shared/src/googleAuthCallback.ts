/**
 * Google sign-in over a loopback redirect (the installed-app flow of RFC 8252). The environment
 * listens for the redirect itself; the desktop app catches it on its own machine for a remote
 * environment. Both run these checks, so a code only ever reaches the flow that asked for it.
 *
 * Runtime-free on purpose: the web client may import it, the Node listeners pass in their
 * request and response objects.
 */
import { BRAND } from "./brand.ts";

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_ISSUER = "https://accounts.google.com";

/**
 * Google's installed-app docs give loopback redirects as `http://127.0.0.1:<port>`, and Desktop
 * app clients accept any port, so every flow listens on a port of its own. The browser lands
 * on `/` of that origin.
 */
export function googleLoopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}`;
}

const REDIRECT_URI = /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u;
const STATE = /^[\w-]{32,128}$/u;
const CODE_CHALLENGE = /^[\w-]{43}$/u;
const CLIENT_ID = /^[\w.-]{1,256}\.apps\.googleusercontent\.com$/u;

/**
 * Validates an authorization URL before a helper opens it: only Google's authorize endpoint,
 * with PKCE and a loopback redirect. Returns what the loopback listener needs.
 */
export function googleAuthorizationRequest(value: string) {
  const invalid = () => new Error("Invalid Google sign-in request.");
  if (value.length > 16_384 || !URL.canParse(value)) throw invalid();
  const url = new URL(value);
  if (
    `${url.origin}${url.pathname}` !== GOOGLE_AUTHORIZATION_ENDPOINT ||
    url.username ||
    url.password ||
    url.hash
  )
    throw invalid();
  const single = (key: string) => {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || !values[0]) throw invalid();
    return values[0];
  };
  const redirectUri = single("redirect_uri");
  const state = single("state");
  if (
    !REDIRECT_URI.test(redirectUri) ||
    Number(new URL(redirectUri).port) > 65_535 ||
    !STATE.test(state) ||
    single("response_type") !== "code" ||
    single("code_challenge_method") !== "S256" ||
    !CODE_CHALLENGE.test(single("code_challenge")) ||
    !CLIENT_ID.test(single("client_id"))
  )
    throw invalid();
  return { authorizationUrl: url.toString(), redirectUri, state };
}

/**
 * Validates the URL Google redirected to: the flow's own origin and path, its `state`, Google
 * as the issuer when it says so, and exactly one `code` or one `error`.
 */
export function googleCallbackUrl(value: string, redirectUri: string, state: string): URL {
  const mismatch = () =>
    new Error("This redirect URL does not belong to the current Google sign-in.");
  if (value.length > 16_384 || !URL.canParse(value) || !URL.canParse(redirectUri)) throw mismatch();
  const callback = new URL(value);
  const expected = new URL(redirectUri);
  const states = callback.searchParams.getAll("state");
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  const issuers = callback.searchParams.getAll("iss");
  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username ||
    callback.password ||
    callback.hash ||
    states.length !== 1 ||
    states[0] !== state ||
    issuers.length > 1 ||
    (issuers.length === 1 && issuers[0] !== GOOGLE_ISSUER) ||
    !(
      (codes.length === 1 && Boolean(codes[0]) && errors.length === 0) ||
      (errors.length === 1 && Boolean(errors[0]) && codes.length === 0)
    )
  )
    throw mismatch();
  return callback;
}

/** The parts of Node's `ServerResponse` the callback handler writes. */
export interface GoogleCallbackResponse {
  setHeader(name: string, value: string): unknown;
  writeHead(status: number, headers?: Record<string, string>): { end(body?: string): unknown };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${BRAND.displayName}</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:360px;padding:32px}h1{font-size:24px}p{line-height:1.6;opacity:.7}</style></head><body><main><h1>Return to ${BRAND.displayName}</h1><p>Google's answer has been received. ${BRAND.displayName} is finishing the connection. You can close this tab.</p></main></body></html>`;

/**
 * Answers one request to a loopback listener and returns the validated callback URL when the
 * request is the redirect this flow waits for. Other paths get 404, foreign redirects 400.
 */
export function handleGoogleCallbackRequest(
  request: { readonly method?: string | undefined; readonly url?: string | undefined },
  response: GoogleCallbackResponse,
  redirectUri: string,
  state: string,
): URL | undefined {
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  const target = new URL(request.url ?? "/", redirectUri);
  if (request.method !== "GET" || target.pathname !== new URL(redirectUri).pathname) {
    response.writeHead(404).end();
    return undefined;
  }
  let callback: URL;
  try {
    callback = googleCallbackUrl(target.toString(), redirectUri, state);
  } catch {
    response.writeHead(400).end("This response does not belong to the active sign-in.");
    return undefined;
  }
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  return callback;
}
