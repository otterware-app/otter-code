import { SUITE_RPC_TAGS } from "@t3tools/contracts/suite";

/** Keep new module methods visible to the upstream RPC instrumentation registry. */
export const SUITE_RPC_AGGREGATES = Object.fromEntries(
  SUITE_RPC_TAGS.map((tag) => {
    const parts = tag.split(".");
    return [tag, parts.length > 2 ? `suite.${parts[1]}` : "suite.core"];
  }),
) as Readonly<Record<(typeof SUITE_RPC_TAGS)[number], string>>;
