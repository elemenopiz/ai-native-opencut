import path from "node:path";
import { test } from "@playwright/test";

const VIDEO_FIXTURE = path.join(__dirname, "..", "fixtures", "w2", "tiny_640x360_h264.mp4");
const IMAGE_FIXTURE = path.join(__dirname, "..", "fixtures", "w2", "alpha_overlay_512.png");

async function realDrag(page: any, assetName: string, dropClientX: number, dropClientY: number) {
  await page.evaluate((name: string) => {
    function findDraggableFor(n: string): HTMLElement | null {
      const span = document.querySelector(`span[title="${CSS.escape(n)}"]`) as HTMLElement | null;
      if (span) {
        let container: Element | null = span;
        for (let i = 0; i < 8; i++) {
          container = container?.parentElement ?? null;
          if (!container) break;
          const d = container.querySelector('[draggable="true"]');
          if (d) return d as HTMLElement;
        }
      }
      const spans = Array.from(document.querySelectorAll("span"));
      const match = spans.find((s) => s.textContent === n);
      return (match?.closest('[draggable="true"]') as HTMLElement) ?? null;
    }
    const src = findDraggableFor(name);
    if (!src) throw new Error(`draggable element not found for "${name}"`);
    const rect = src.getBoundingClientRect();
    const dt = new DataTransfer();
    (window as any).__huntDT = dt;
    (window as any).__huntSrc = src;
    const ev = new DragEvent("dragstart", { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    src.dispatchEvent(ev);
  }, assetName);
  await page.waitForTimeout(80);
  for (const type of ["dragenter", "dragover", "dragover"]) {
    await page.evaluate(({ type, x, y }: any) => {
      const timeline = document.querySelector('section[aria-label="Timeline"]')!;
      const dt = (window as any).__huntDT as DataTransfer;
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      Object.defineProperty(ev, "dataTransfer", { value: dt });
      timeline.dispatchEvent(ev);
    }, { type, x: dropClientX, y: dropClientY });
    await page.waitForTimeout(80);
  }
  await page.evaluate(({ x, y }: any) => {
    const timeline = document.querySelector('section[aria-label="Timeline"]')!;
    const dt = (window as any).__huntDT as DataTransfer;
    const ev = new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    timeline.dispatchEvent(ev);
    const src = (window as any).__huntSrc as HTMLElement;
    src?.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true }));
  }, { x: dropClientX, y: dropClientY });
  await page.waitForTimeout(80);
}

for (let trial = 1; trial <= 4; trial++) {
  test(`c3 repeat trial ${trial}`, async ({ page }) => {
    await page.goto(`/editor/w3-c3-repeat-${trial}`);
    await page.waitForFunction(() => (window as any).__BYORN_E2E__?.ready === true, null, { timeout: 180000 });
    const dismiss = page.getByRole("button", { name: "Okay, I've read this" });
    if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => {});

    const [fc1] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import", exact: true }).click()]);
    await fc1.setFiles(VIDEO_FIXTURE);
    await page.waitForTimeout(800);
    const [fc2] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import", exact: true }).click()]);
    await fc2.setFiles(IMAGE_FIXTURE);
    await page.waitForTimeout(800);

    const assets = await page.evaluate(() => (window as any).__BYORN_E2E__.editor.media.getAssets());
    const video = assets.find((a: any) => a.type === "video");
    const image = assets.find((a: any) => a.type === "image");

    const timelineRect = await page.evaluate(() => {
      const r = document.querySelector('section[aria-label="Timeline"]')!.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });

    await realDrag(page, video.name, timelineRect.left + 200, timelineRect.top + timelineRect.height / 2);

    const countOf = async (name: string) =>
      page.evaluate(
        (n: string) =>
          (window as any).__BYORN_E2E__.editor.timeline.getTracks().flatMap((t: any) => t.elements).filter((e: any) => e.name === n).length,
        name,
      );

    const before2 = await countOf(image.name);
    await realDrag(page, image.name, timelineRect.left + 600, timelineRect.top + timelineRect.height / 2 - 20);
    const after2 = await countOf(image.name);
    console.log(`[C3-repeat-${trial}] drop2 onto occupied band: image count ${before2} -> ${after2} (landed=${after2 > before2})`);
  });
}
