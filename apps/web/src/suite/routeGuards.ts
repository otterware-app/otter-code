import { redirect } from "@tanstack/react-router";

/** Module pages need a paired environment, like the Code routes under `_chat`. */
export function requireSuiteRouteAuth({
  context,
}: {
  readonly context: { readonly authGateState: { readonly status: string } };
}) {
  if (
    context.authGateState.status !== "authenticated" &&
    context.authGateState.status !== "hosted-static"
  ) {
    throw redirect({ to: "/pair", replace: true });
  }
}
