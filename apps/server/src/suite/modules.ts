/**
 * The ONE server registry of Otterware modules. A module adds its folder under
 * `apps/server/src/suite/<module>/` and one line below. Order is the order
 * capabilities report and instructions are appended in.
 */
import { SuiteCoreModule } from "./core/SuiteCoreModule.ts";

export const SUITE_SERVER_MODULES = [
  SuiteCoreModule,
  // MailModule,
] as const;
