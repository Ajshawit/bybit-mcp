// Runtime enforcement of the human-CONFIRM gate.
// The MCP tool descriptions describe the gate in prose, but until this helper
// existed nothing actually validated the value — non-verbatim phrasing still
// executed. Call this at the top of every live-submit handler.
// (JSON inputSchema constraints are advisory — the SDK does not validate
// arguments server-side, so every gate-relevant value is checked here.)
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

// MCP arguments arrive as untyped JSON and the SDK performs no server-side
// schema validation — a blind `as` cast lets a wrong-typed value flow into a
// money gate. Validate gate-relevant params at the dispatch boundary.

export function assertBooleanFlag(
  value: unknown,
  param: string,
  toolName: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new Error(
    `${toolName}: ${param} must be a boolean (got ${JSON.stringify(value)}). ` +
    `Pass true/false, not a string.`
  );
}

export function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  param: string,
  toolName: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(
    `${toolName}: ${param} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)}).`
  );
}
