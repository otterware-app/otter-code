/**
 * The vendored `../../calendar.ts` imports `makeEntityId` from `./baseSchemas.ts`, which Otter
 * Code keeps private. The vendor manifest remaps that import here.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../../baseSchemas.ts";

export * from "../../baseSchemas.ts";

/** A branded, trimmed, non-empty identifier, as `baseSchemas.ts` builds its own. */
export const makeEntityId = <Brand extends string>(
  brand: Parameters<typeof Schema.brand<Brand>>[0],
) => TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));
