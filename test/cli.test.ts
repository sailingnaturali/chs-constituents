import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";

afterEach(() => vi.restoreAllMocks());

describe("main", () => {
  it("prints the resolve-stage error alone, not the empty-fit message", async () => {
    const tmpPath = join(tmpdir(), `cli-test-empty-${Date.now()}.json`);
    writeFileSync(tmpPath, "[]");
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => {
      errors.push(msg);
    });

    try {
      const code = await main(["--stations", tmpPath]);

      expect(code).toBe(1);
      expect(errors.some((m) => typeof m === "string" && /No stations in/.test(m))).toBe(true);
      expect(
        errors.some((m) => typeof m === "string" && m.includes("leaving the existing output untouched")),
      ).toBe(false);
    } finally {
      unlinkSync(tmpPath);
    }
  });
});
