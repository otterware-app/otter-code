/** Module instructions published at startup, shared by every provider adapter. */
let suiteAgentInstructionsText = "";

export const setSuiteAgentInstructions = (sections: ReadonlyArray<string>) => {
  const text = sections.map((section) => section.trim()).filter((section) => section.length > 0);
  suiteAgentInstructionsText = text.length === 0 ? "" : `\n\n${text.join("\n\n")}`;
};

/** Empty before startup or on a server without suite modules. */
export const suiteAgentInstructions = (): string => suiteAgentInstructionsText;
