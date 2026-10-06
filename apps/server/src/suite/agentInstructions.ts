/**
 * Bridges module `agentInstructions` into provider prompts. Adapters build
 * runtime instructions synchronously from `provider/RuntimeInstructions.ts`,
 * which must not import the module registry (it would pull every module's
 * services into the adapters' import graph), so the suite runtime publishes
 * the joined text here when the server starts.
 */
let suiteAgentInstructionsText = "";

export const setSuiteAgentInstructions = (sections: ReadonlyArray<string>) => {
  const text = sections.map((section) => section.trim()).filter((section) => section.length > 0);
  suiteAgentInstructionsText = text.length === 0 ? "" : `\n\n${text.join("\n\n")}`;
};

/** Empty on a server without suite modules or before startup; else prefixed with a blank line. */
export const suiteAgentInstructions = (): string => suiteAgentInstructionsText;
