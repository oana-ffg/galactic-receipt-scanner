const targetPattern =
  /^retake:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function retakeTarget(command: string): string | null {
  return targetPattern.exec(command)?.[1] ?? null;
}

export function isControlCommand(command: unknown): command is string {
  return (
    typeof command === "string" &&
    ([
      "start",
      "pause",
      "retry",
      "retry-upload",
      "cancel-retake",
      "force",
      "set-background",
      "clear-background",
    ].includes(command) ||
      retakeTarget(command) !== null)
  );
}
