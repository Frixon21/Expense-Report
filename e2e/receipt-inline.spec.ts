import { createServer } from "node:http";
import { expect, test, request as requestFactory } from "@playwright/test";
const origin = process.env.RECEIPT_INLINE_ORIGIN ?? "",
  cookie = process.env.RECEIPT_INLINE_COOKIE ?? "",
  otherCookie = process.env.RECEIPT_INLINE_OTHER_COOKIE ?? "";
const pdfPath = "/api/expenses/22222222-2222-4222-8222-222222222222/receipt",
  imagePath = "/api/expenses/11111111-1111-4111-8111-111111111111/receipt";
test.skip(
  !origin || !cookie,
  "Requires the isolated synthetic production-container fixture",
);
test.beforeEach(async ({ context }) => {
  if (new URL(origin).hostname !== "127.0.0.1")
    throw Error("Receipt fixture must be loopback-only");
  await context.addCookies([
    {
      name: "expense_report_session",
      value: cookie.split("=").slice(1).join("="),
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
});
test("production receipt headers allow same-origin frames only and preserve unauthorized rejection", async () => {
  const api = await requestFactory.newContext();
  try {
    for (const pathname of [pdfPath, imagePath]) {
      const r = await api.get(origin + pathname, {
        headers: { Cookie: cookie },
      });
      expect(r.status()).toBe(200);
      expect(r.headers()["x-frame-options"]).toBe("SAMEORIGIN");
      expect(r.headers()["content-security-policy"]).toBe(
        "sandbox; frame-ancestors 'self'",
      );
      expect(r.headers()["cache-control"]).toContain("no-store");
      expect((await api.get(origin + pathname)).status()).toBe(401);
      expect(
        (
          await api.get(origin + pathname, { headers: { Cookie: otherCookie } })
        ).status(),
      ).toBe(404);
    }
    for (const pathname of [
      "/",
      "/api/auth/me",
      "/api/me",
      "/api/expenses/11111111-1111-4111-8111-111111111111",
    ]) {
      const r = await api.get(origin + pathname, {
        headers: { Cookie: cookie },
      });
      expect(r.headers()["x-frame-options"], pathname).toBe("DENY");
    }
  } finally {
    await api.dispose();
  }
});
test("actual employee PDF stays inline, scrolls at short height, reopens and offers an authenticated fallback", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(origin);
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  const open = page.getByRole("button", {
    name: "View: synthetic.pdf",
    exact: true,
  });
  let pdfResponse = page.waitForResponse((r) => r.url() === origin + pdfPath);
  await open.click();
  expect((await pdfResponse).status()).toBe(200);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("iframe")).toHaveAttribute("src", pdfPath);
  await expect(
    page.getByRole("link", { name: "Open in new tab" }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(page.frames().some((f) => f.url().includes("chrome-error"))).toBe(
    false,
  );
  expect(
    errors.filter((e) =>
      /Refused to (?:display|frame)|frame-ancestors/i.test(e),
    ),
  ).toEqual([]);
  for (const viewport of [
    { width: 800, height: 300 },
    { width: 390, height: 350 },
    { width: 640, height: 360 },
  ]) {
    await page.setViewportSize(viewport);
    const close = page.getByRole("button", { name: "Close receipt viewer" }),
      box = await close.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    const body = page.locator(".receipt-viewer-body");
    await expect(body).toHaveCSS("overflow-y", "auto");
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const geometry = await page.locator("iframe").evaluate((el) => ({
      frame: el.getBoundingClientRect().bottom,
      body: el.parentElement!.getBoundingClientRect().bottom,
    }));
    expect(geometry.frame).toBeLessThanOrEqual(geometry.body + 1);
  }
  await page.setViewportSize({ width: 1200, height: 720 });
  await page.locator("html").evaluate((el) => {
    el.style.zoom = "2";
  });
  const zoomClose = await page
    .getByRole("button", { name: "Close receipt viewer" })
    .boundingBox();
  expect(zoomClose!.y).toBeGreaterThanOrEqual(0);
  expect(zoomClose!.y + zoomClose!.height).toBeLessThanOrEqual(720);
  const zoomPanel = await page.locator(".receipt-viewer-panel").boundingBox();
  expect(zoomPanel!.y).toBeGreaterThanOrEqual(0);
  expect(zoomPanel!.y + zoomPanel!.height).toBeLessThanOrEqual(720);
  await page.locator(".receipt-viewer-body").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const zoomFrame = await page.locator("iframe").evaluate((el) => ({
    bottom: el.getBoundingClientRect().bottom,
    bodyBottom: el.parentElement!.getBoundingClientRect().bottom,
  }));
  expect(zoomFrame.bottom).toBeLessThanOrEqual(zoomFrame.bodyBottom + 1);
  await expect(page.locator(".receipt-viewer-body")).toHaveCSS(
    "overflow-y",
    "auto",
  );
  await page.locator("html").evaluate((el) => {
    el.style.zoom = "";
  });
  await page.setViewportSize({ width: 640, height: 360 });
  await page.screenshot({
    path: "test-results/receipt-inline-short-chrome.png",
    fullPage: true,
  });
  const popupEvent = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open in new tab" }).click();
  const popup = await popupEvent;
  await popup.waitForLoadState();
  expect(popup.url()).toBe(origin + pdfPath);
  await popup.close();
  await page.getByRole("button", { name: "Close receipt viewer" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await open.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.locator(".receipt-viewer-body").evaluate((el) => el.scrollTop),
  ).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("actual image preview remains readable and image failures recover on reopening", async ({
  page,
}) => {
  await page.goto(origin);
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  const open = page.getByRole("button", {
    name: "View: synthetic.png",
    exact: true,
  });
  await open.click();
  const image = page.getByRole("dialog").getByAltText("synthetic.png");
  await expect
    .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBe(600);
  await page.getByRole("button", { name: "Rotate view" }).click();
  await expect(image).toHaveCSS("transform", /matrix/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.route("**" + imagePath, (route) =>
    route.fulfill({ status: 404, body: "Synthetic missing receipt" }),
  );
  await open.click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "could not be read",
  );
  await expect(
    page.getByRole("link", { name: "Open in new tab" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.unroute("**" + imagePath);
  await open.click();
  await expect
    .poll(() =>
      page
        .getByRole("dialog")
        .getByAltText("synthetic.png")
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBe(600);
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/receipt-inline-image-chrome.png",
    fullPage: true,
  });
});

test("cross-origin receipt framing remains blocked even for an authenticated synthetic browser", async ({
  page,
}) => {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><iframe title="Synthetic cross-origin receipt" src="' +
        origin +
        pdfPath +
        '"></iframe>',
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const address = server.address() as { port: number };
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto("http://127.0.0.1:" + address.port);
    await expect
      .poll(() =>
        errors.some((e) =>
          /frame-ancestors|Refused to (?:display|frame)/i.test(e),
        ),
      )
      .toBe(true);
  } finally {
    await page.goto("about:blank");
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
