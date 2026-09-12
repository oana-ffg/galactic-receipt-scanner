import { expect, test } from "@playwright/test";

test("camera setup shows unknown until a read-only count loads, without enabling the camera", async ({
  page,
}) => {
  let release!: () => void;
  const responseReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") mutations.push(request.url());
  });
  await page.route("**/api/station", async (route) => {
    await responseReady;
    await route.fulfill({ json: { count: 42 } });
  });
  await page.goto("/camera");
  await expect(page.locator("#count")).toHaveText("—");
  release();
  await expect(page.locator("#count")).toHaveText("42");
  await expect(page.locator("#phase")).toHaveText("ENABLE CAMERA");
  expect(mutations).toEqual([]);
});

test("a count lookup failure or camera-start failure never becomes a fake zero", async ({
  page,
}) => {
  await page.route("**/api/station", (route) => route.abort());
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new Error("Synthetic camera unavailable");
    };
  });
  await page.goto("/camera");
  await expect(page.locator("#count")).toHaveAttribute(
    "aria-label",
    "Saved count unavailable",
  );
  await expect(page.locator("#count")).toHaveText("—");
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
  await expect(page.locator("#phase")).toHaveText("CAMERA STOPPED", {
    timeout: 20000,
  });
  await expect(page.locator("#count")).toHaveText("—");
});

test("camera-start failure preserves the count already read from storage", async ({
  page,
}) => {
  await page.route("**/api/station", (route) =>
    route.fulfill({ json: { count: 42 } }),
  );
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new Error("Synthetic camera unavailable");
    };
  });
  await page.goto("/camera");
  await expect(page.locator("#count")).toHaveText("42");
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
  await expect(page.locator("#phase")).toHaveText("CAMERA STOPPED", {
    timeout: 20000,
  });
  await expect(page.locator("#count")).toHaveText("42");
});

test("a verified empty instance can display zero", async ({ page }) => {
  await page.route("**/api/station", (route) =>
    route.fulfill({ json: { count: 0 } }),
  );
  await page.goto("/camera");
  await expect(page.locator("#count")).toHaveText("0");
  await expect(page.locator("#count")).toHaveAttribute(
    "aria-label",
    "0 saved pictures",
  );
});

test("a camera claim supersedes a delayed count even before startup emits state", async ({
  page,
}) => {
  let release!: () => void;
  const responseReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/station", async (route) => {
    await responseReady;
    await route.fulfill({ json: { count: 42 } });
  });
  await page.route("**/api/station/claim", (route) =>
    route.fulfill({ json: { count: 43, sequence: 1 } }),
  );
  await page.addInitScript(() => {
    // Isolate startup ordering from model loading and real camera permission.
    window.Worker = class {
      onmessage: ((event: { data: { id: number } }) => void) | null = null;
      postMessage(data: { id: number }) {
        queueMicrotask(() => this.onmessage?.({ data }));
      }
      terminate() {}
    } as unknown as typeof Worker;
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const stream = canvas.captureStream(10);
      setInterval(() => canvas.getContext("2d")!.fillRect(0, 0, 64, 64), 50);
      return stream;
    };
    Object.defineProperty(navigator, "wakeLock", {
      value: {
        request: () => {
          document.documentElement.dataset.wakePending = "true";
          return new Promise(() => {});
        },
      },
    });
  });
  await page.goto("/camera");
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-wake-pending",
    "true",
  );
  release();
  await expect(page.locator("#count")).toHaveText("43");
});
