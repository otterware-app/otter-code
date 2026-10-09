// Provider adapters live in their own packages; share only the published text,
// so building their prompts never imports the suite services or module registry.
export {
  setSuiteAgentInstructions,
  suiteAgentInstructions,
} from "@t3tools/shared/suite/agentInstructions";
