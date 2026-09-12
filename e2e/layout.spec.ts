import { expect, test } from "@playwright/test";

test("status and warning messages never move the preview or controls", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1360, height: 900 },
    { width: 393, height: 852 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(viewport.width < 600 ? "/camera" : "/");
    const positions = await page.evaluate(() => {
      const boxes = () =>
        ["#signal", "#preview", ".controls"].map((selector) => {
          const box = document.querySelector(selector)!.getBoundingClientRect();
          return { y: box.y, height: box.height };
        });
      const before = boxes();
      document.querySelector("#status")!.textContent =
        "Access could not be verified. Reopen the scanner and sign in with the owner account. Your original is retained on this phone. Use Retry upload once you reconnect.";
      document.querySelector("#connection-warning")!.textContent =
        "Desktop preview is delayed. The connection was interrupted. Retrying automatically. Capture uploads are waiting for confirmation.";
      document.querySelector("#detail")!.textContent =
        "The scanner service is temporarily unavailable. Your original is retained on this phone. Reconnect and use Retry upload.";
      return { before, after: boxes() };
    });
    expect(positions.after).toEqual(positions.before);
  }
});
