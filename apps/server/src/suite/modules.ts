/** The server registry of Otterware modules. */
import { CalendarModule } from "./calendar/CalendarModule.ts";
import { SuiteCoreModule } from "./core/SuiteCoreModule.ts";
import { DriveModule } from "./drive/DriveModule.ts";
import { SuiteHomeModule } from "./home/SuiteHomeModule.ts";
import { MailModule } from "./mail/MailModule.ts";

export const SUITE_SERVER_MODULES = [
  SuiteCoreModule,
  SuiteHomeModule,
  CalendarModule,
  DriveModule,
  MailModule,
] as const;
