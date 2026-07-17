// ONE rule for "did a detached job actually succeed": exit code 0 AND the
// tool's RESULT line (if any) says ok:true. The client poller (pollJob) and
// the server task list (/api/tasks) both import THIS — the two surfaces must
// never drift on what counts as a failure (that drift is how the 2026-07-13
// silent gate-block hid from the operator).
const RESULT_BAD = /(?:WORKBENCH|STAGE)_RESULT\s*\{"ok":false/;

export function resultBad(out: string): boolean {
  return RESULT_BAD.test(out);
}

export function jobOk(code: number | null, out: string): boolean {
  return code === 0 && !resultBad(out);
}
