"use client";

import { cx } from "./core";
import { Chip, Pips, Readout, rowHueClass, type StateHue } from "./anatomy";

// THE rail row — CALIBRATED INSTRUMENT assay strip (Phase T, 2026-07-17; lifted
// into the kit in Phase P so Today's rail AND the Pipeline board share ONE row).
// One line at rest: 3px state strip · domain · ONE chip (the state word) · mono
// age. The email gist renders ONLY on hover/focus as an absolute card and is
// aria-hidden; the row carries a structured aria-label (company; state; age) so
// a screen-reader user gets the same three facts without the hover reveal.
// Cold group rows swap the chip for ladder pips (touch N of 3).
export function AssayRow({ name, hue, chip, chipHue, pips, when, gist, selected, onClick }: {
  name: string;
  hue: StateHue;                 // the 3px left state strip
  chip?: string | null;          // ONE state word (chips carry what stateWord carries)
  chipHue?: StateHue;            // chip tint (defaults to the row hue)
  pips?: { done: number; total: number; label: string } | null; // cold groups only
  when?: string | null;          // mono age readout
  gist?: string | null;          // hover-only email snippet (aria-hidden)
  selected?: boolean;
  onClick?: () => void;
}) {
  const aria = [name, chip || undefined, when ? `${when}` : undefined].filter(Boolean).join("; ");
  return (
    <button onClick={onClick} aria-current={selected ? "true" : undefined} aria-label={aria}
      className={cx("vk-railrow assay-strip", rowHueClass(hue))}>
      <span className="rr-who">{name}</span>
      {pips ? (
        <Pips done={pips.done} total={pips.total} hue={hue} label={pips.label} />
      ) : chip ? (
        <Chip hue={chipHue ?? hue}>{chip}</Chip>
      ) : null}
      {when && <Readout className="rr-age">{when}</Readout>}
      {gist && <span aria-hidden className="rr-gist">{gist}</span>}
    </button>
  );
}
