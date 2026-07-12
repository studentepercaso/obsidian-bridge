import { describe, expect, it, vi } from "vitest";

import { runConfirmedActivation } from "../src/activation-flow";

describe("full-access activation outcome", () => {
  it("reports a persistence failure without running post-activation UI", async () => {
    const activationError = new Error("write failed");
    const afterActivation = vi.fn();

    await expect(
      runConfirmedActivation(async () => {
        throw activationError;
      }, afterActivation),
    ).resolves.toEqual({ activated: false, activationError });
    expect(afterActivation).not.toHaveBeenCalled();
  });

  it("reports a completed activation when the UI refresh succeeds", async () => {
    await expect(
      runConfirmedActivation(async () => undefined, () => undefined),
    ).resolves.toEqual({ activated: true });
  });

  it("keeps activation successful when only the post-save UI fails", async () => {
    const uiError = new Error("render failed");

    await expect(
      runConfirmedActivation(async () => undefined, () => {
        throw uiError;
      }),
    ).resolves.toEqual({ activated: true, uiError });
  });
});
