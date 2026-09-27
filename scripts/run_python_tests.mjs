import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const windows = process.platform === "win32";
const localPython = resolve(
  ".local",
  "receipt-ppocr-runtime",
  "cpu-venv",
  "Scripts",
  "python.exe",
);
const candidates = windows
  ? [
      ...(existsSync(localPython) ? [[localPython, []]] : []),
      ["py", ["-3"]],
      ["python", []],
      ["python3", []],
    ]
  : [
      ["python3", []],
      ["python", []],
    ];
const selected = candidates.find(([executable, prefix]) => {
  const probe = spawnSync(executable, [...prefix, "--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return (
    probe.status === 0 &&
    `${probe.stdout}${probe.stderr}`.startsWith("Python 3.")
  );
});
if (!selected) throw new Error("Python 3 is required to run script tests.");
const [executable, prefix] = selected;
const result = spawnSync(
  executable,
  [...prefix, "-m", "unittest", "discover", "-s", "scripts", "-p", "test_*.py"],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
