/** Microsoft mailbox PKCE and callbacks at the suite boundary; tokens stay in Mail. */
const AUTHORIZE = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";

export function mailMicrosoftAuthorizationRequest(value: string) {
  const invalid = () => new Error("Invalid Microsoft sign-in request.");
  if (value.length > 16_384 || !URL.canParse(value)) throw invalid();
  const url = new URL(value);
  if (`${url.origin}${url.pathname}` !== AUTHORIZE || url.username || url.password || url.hash)
    throw invalid();
  const single = (key: string) => {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || !values[0]) throw invalid();
    return values[0];
  };
  const redirectUri = single("redirect_uri");
  const state = single("state");
  if (
    !/^http:\/\/localhost:[1-9]\d{0,4}$/u.test(redirectUri) ||
    Number(new URL(redirectUri).port) > 65_535 ||
    !/^[\w-]{22,128}$/u.test(state) ||
    single("response_type") !== "code" ||
    single("response_mode") !== "query" ||
    single("code_challenge_method") !== "S256" ||
    !/^[\w-]{43}$/u.test(single("code_challenge")) ||
    !/^[\w-]{1,256}$/u.test(single("client_id"))
  )
    throw invalid();
  return { authorizationUrl: url.toString(), redirectUri, state };
}

export function mailMicrosoftCallbackUrl(value: string, redirectUri: string, state: string): URL {
  const mismatch = () => new Error("This redirect URL does not belong to the Microsoft sign-in.");
  if (value.length > 16_384 || !URL.canParse(value) || !URL.canParse(redirectUri)) throw mismatch();
  const url = new URL(value);
  const expected = new URL(redirectUri);
  const states = url.searchParams.getAll("state");
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");
  const issuers = url.searchParams.getAll("iss");
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.username ||
    url.password ||
    url.hash ||
    states.length !== 1 ||
    states[0] !== state ||
    issuers.length > 1 ||
    (issuers.length === 1 &&
      !/^https:\/\/login\.microsoftonline\.com\/[\w-]+\/v2\.0$/u.test(issuers[0] ?? "")) ||
    !(
      (codes.length === 1 && Boolean(codes[0]) && errors.length === 0) ||
      (errors.length === 1 && Boolean(errors[0]) && codes.length === 0)
    )
  )
    throw mismatch();
  return url;
}
