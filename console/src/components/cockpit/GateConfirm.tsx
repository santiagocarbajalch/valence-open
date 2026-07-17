"use client";

import { ConfirmModal } from "@/components/kit";
import type { GateAction } from "./types";

// THE registry-gate dialog — one verb per action, everywhere (tenet 6).
// ONE DESK port 2026-07-12: Today and Pipeline each carried their own copy of
// this dialog and the wording had split ("Freeze" vs "Pause" for the same
// registry write). One dialog, one vocabulary: the operator-facing word for
// `freeze` is PAUSE on every surface; the engine's action names never show.

export const GATE_VERB: Record<GateAction, string> = {
  freeze: "Pause",
  unfreeze: "Reactivate",
  close: "Close out",
  dnc: "Do not contact",
};

// the past-tense word the success toast uses — same on every surface
export const GATE_DONE_WORD: Record<GateAction, string> = {
  freeze: "paused",
  unfreeze: "reactivated, back on its worklists",
  close: "closed out",
  dnc: "added to do-not-contact",
};

const GATE_BODY: Record<GateAction, string> = {
  freeze: "Pausing takes this company off every list and every send. Reversible any time from the Pipeline tab's Paused column.",
  unfreeze: "Reactivating removes the pause — the company returns to its worklists right away.",
  close: "Closing out marks the lead declined and drops it off all boards. It re-opens automatically if they write back with interest.",
  dnc: "Do-not-contact permanently blocks this address from every future send.",
};

export function GateConfirm({ action, name, onConfirm, onClose }: {
  action: GateAction;
  name: string; // the company key the dialog is about
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  return (
    <ConfirmModal
      title={`${GATE_VERB[action]} · ${name}`}
      danger={action === "close" || action === "dnc"}
      body={GATE_BODY[action]}
      reasonLabel="Reason (recorded)"
      confirmLabel={action === "dnc" ? "Add to do-not-contact" : GATE_VERB[action]}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
