// Schema-level enforcement of the human-CONFIRM gate.
// The MCP tool descriptions describe the gate in prose, but until this helper
// existed nothing actually validated the value — non-verbatim phrasing still
// executed. Call this at the top of every live-submit handler.
export function assertConfirm(
  confirm: string | undefined,
  dryRun: boolean,
  toolName: string,
): void {
  if (dryRun) return;
  if (confirm !== "CONFIRM") {
    throw new Error(
      `${toolName} requires confirm="CONFIRM" (exact, case-sensitive) for live submission. ` +
      `Present the trade plan, wait for the user to reply 'CONFIRM', then pass confirm:"CONFIRM". ` +
      `Use dry_run:true to preview without confirm.`,
    );
  }
}
