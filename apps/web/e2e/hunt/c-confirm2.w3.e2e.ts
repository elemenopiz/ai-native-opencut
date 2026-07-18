import { test } from "@playwright/test";

test("confirm2: Audio panel tab (getByLabel) opens Record sub-tab fine for a human", async ({ page }) => {
  await page.goto("/editor/w3-confirm2-audio-tab");
  await page.waitForFunction(() => (window as any).__BYORN_E2E__?.ready === true, null, { timeout: 180000 });
  const dismiss = page.getByRole("button", { name: "Okay, I've read this" });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => {});

  // Disambiguated: target the assets-panel LEFT-RAIL tab specifically via
  // its aria-label (what the suite's getByRole('button',{name:'Audio'})
  // ambiguously matched two of).
  const audioRailTab = page.getByLabel("Audio", { exact: true });
  const count = await audioRailTab.count();
  console.log("[confirm2] elements matching getByLabel('Audio'):", count);
  await audioRailTab.first().click();
  await page.waitForTimeout(300);

  const recordSubTab = page.getByRole("button", { name: "Record", exact: true });
  const visible = await recordSubTab.isVisible().catch(() => false);
  console.log("[confirm2] Record sub-tab visible after disambiguated click:", visible);
  if (visible) {
    await recordSubTab.click();
    await page.waitForTimeout(300);
    const nameInput = page.locator('input[placeholder="Recording name..."]');
    const inputVisible = await nameInput.isVisible().catch(() => false);
    console.log("[confirm2] recording-name input visible:", inputVisible);
  }
  await page.screenshot({ path: "/tmp/confirm2-audio-record-tab.png" });
});
