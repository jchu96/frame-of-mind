import type { ActivityActionId } from "./activity-actions";

export interface ActivityActionPanelState {
  confirming?: ActivityActionId;
  pending?: ActivityActionId;
  fieldMessage?: string;
  successMessage?: string;
}

export type ActivityActionPanelEvent =
  | { type: "request-confirmation"; action: ActivityActionId }
  | { type: "dismiss-confirmation" }
  | { type: "start"; action: ActivityActionId }
  | { type: "succeed"; message: string }
  | { type: "fail"; message: string }
  | { type: "finish-navigation" };

export function reduceActivityActionPanelState(
  state: ActivityActionPanelState,
  event: ActivityActionPanelEvent,
): ActivityActionPanelState {
  if (
    state.pending
    && (event.type === "request-confirmation"
      || event.type === "dismiss-confirmation"
      || event.type === "start")
  ) {
    return state;
  }
  if (event.type === "request-confirmation") {
    return { confirming: event.action };
  }
  if (event.type === "dismiss-confirmation") return {};
  if (event.type === "start") {
    return { confirming: event.action, pending: event.action };
  }
  if (event.type === "succeed") {
    return { successMessage: event.message };
  }
  if (event.type === "fail") {
    return { confirming: state.confirming, fieldMessage: event.message };
  }
  return { confirming: state.confirming };
}
