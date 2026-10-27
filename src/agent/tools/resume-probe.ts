import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult } from "../tool-execute.ts";
import { newHandoffMessage } from "../../core/native-messages.ts";
import type { ProbeDoneContext } from "./probe.ts";

/** A successful result reopens the diagnostic without deleting its history.
 * The phase handoff waits for the current run to settle before rebuilding. */
export function resumeProbeTool(ctx: Omit<ProbeDoneContext, "deliver"> & Partial<Pick<ProbeDoneContext, "deliver">> & { onResume?: () => void }): Record<string, AgentTool<any>> {
	return {
		resume_probe: {
			name: "resume_probe",
			label: "resume_probe",
			description: "Return to diagnostic probing when the learner asks to keep exploring their foundations. " +
				"Preserves the conversation and provisional map. Call instead of quiz/explain, then end your turn. " +
				"The dedicated prober continues automatically and must conclude again before planning resumes.",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async (toolCallId) => {
				if (!ctx.chatStore.getChat(ctx.chatId)) return invalidInputResult("resume_probe", ["Chat not found."]);
				if (!ctx.deliver) return invalidInputResult("resume_probe", ["Diagnostic handoff delivery is not configured."]);
				const handoff = newHandoffMessage(ctx.chatId);
				handoff.id = `steer_resume_probe_${toolCallId}`;
				handoff.content = "The learner asked to continue the diagnostic. Resume probing their foundations, " +
					"using the full conversation as evidence. The previous assessment and map are provisional. " +
					"Do not start teaching. Conclude again with probe_done only when the diagnostic is complete.";
				ctx.deliver(handoff);
				ctx.onResume?.();
				return { content: [{ type: "text", text: "Diagnostic reopened. End this turn; the prober continues next." }],
					details: { ok: true }, terminate: true };
			},
		},
	};
}
