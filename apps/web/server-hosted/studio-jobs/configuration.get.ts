import { defineEventHandler } from "h3";
import { getHostedWorkflowExecutor } from "./executor.js";

export default defineEventHandler((event) => {
  getHostedWorkflowExecutor(event);
  return {
    hosted: true,
    recordingUploadAvailable: false,
    contextModes: ["none"] as const,
    transferDisclosure:
      "Starting analysis transfers the sealed recording to Gemini. Frame of Mind does not retain recording bytes unless retained mode was selected when the receipt was created.",
  };
});
