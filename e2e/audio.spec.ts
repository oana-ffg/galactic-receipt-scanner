import { expect, test } from "@playwright/test";
import { CaptureState } from "../web/state";

test("real audio resumes for saves, deduplicates delivery, and enters private issue reports", async ({
  page,
  request,
}) => {
  const state = new CaptureState();
  state.control("start");
  let revision = 1;
  await page.route("**/api/station", (route) =>
    route.fulfill({
      json: {
        state: { ...state.value, stateRevision: revision },
        count: 0,
        camera: null,
        previewSession: null,
        fresh: true,
      },
    }),
  );
  await page.addInitScript(() => {
    const NativeAudio = window.AudioContext;
    const contexts: AudioContext[] = [];
    let started = 0;
    const events: unknown[] = [];
    Object.assign(window, {
      audioTest: {
        contexts,
        events,
        get started() {
          return started;
        },
      },
    });
    window.AudioContext = class extends NativeAudio {
      constructor() {
        super();
        contexts.push(this);
        this.addEventListener("statechange", () =>
          events.push({
            event: "state",
            state: this.state,
            at: performance.now(),
          }),
        );
      }
      resume() {
        events.push({
          event: "resume",
          state: this.state,
          at: performance.now(),
          active: navigator.userActivation.isActive,
        });
        return super.resume().then(() => {
          events.push({
            event: "resumed",
            state: this.state,
            at: performance.now(),
          });
        });
      }
      createOscillator() {
        const oscillator = super.createOscillator();
        const start = oscillator.start.bind(oscillator);
        oscillator.start = (at?: number) => {
          started++;
          start(at);
        };
        return oscillator;
      }
    };
  });
  await page.goto("/");
  await expect(page.locator("#phase")).not.toHaveText("CONNECTING");
  await page.getByRole("button", { name: "Test audio", exact: true }).click();
  try {
    await expect(page.locator("#audio-warning")).toBeEmpty();
  } catch (error) {
    console.log(
      await page.evaluate(() =>
        JSON.stringify((window as unknown as { audioTest: unknown }).audioTest),
      ),
    );
    throw error;
  }
  const facts = () =>
    page.evaluate(() => {
      const t = (
        window as unknown as {
          audioTest: { contexts: AudioContext[]; started: number };
        }
      ).audioTest;
      return { started: t.started, state: t.contexts.at(-1)?.state };
    });
  await expect.poll(facts).toEqual({ started: 1, state: "running" });
  await page.waitForTimeout(350);
  await page.evaluate(async () => {
    const t = (window as unknown as { audioTest: { contexts: AudioContext[] } })
      .audioTest;
    await t.contexts.at(-1)!.suspend();
  });
  state.saved("11111111-1111-4111-8111-111111111111");
  revision++;
  await expect(page.locator("#phase")).toHaveText("SAVED · NEXT");
  await expect.poll(facts).toEqual({ started: 2, state: "running" });
  await page.waitForTimeout(1600);
  expect((await facts()).started).toBe(2);
  await page.getByRole("button", { name: "Report issue", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Report a private issue" });
  await dialog
    .getByLabel("Title", { exact: true })
    .fill("Synthetic audio diagnostics");
  await dialog.getByRole("button", { name: "Save private issue" }).click();
  await expect(dialog).not.toBeVisible();
  const data = await (await request.get("/api/issues")).json();
  const report = data.issues.find(
    (i: { title: string }) => i.title === "Synthetic audio diagnostics",
  );
  expect(report.context.diagnostics.audioHistory).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          action: "requested",
          cause: "saved",
          revision: 2,
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({ action: "ended" }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          action: "resume-result",
          cause: "saved",
        }),
      }),
    ]),
  );
});
