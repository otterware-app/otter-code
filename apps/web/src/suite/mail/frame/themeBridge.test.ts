// @vitest-environment jsdom
import { afterEach, expect, it } from "vite-plus/test";

import { readParentAppearance } from "./themeBridge";

afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});

it("lets the embedded workspace shrink below its content while keeping the toolbar height", () => {
  document.body.innerHTML = `
    <div data-mail-layout="split">
      <div class="contents">
        <nav aria-label="Spaces"></nav>
        <div data-pane-wrapper>
          <div data-mail-workspace>
            <div data-slot="scroll-area-viewport"></div>
          </div>
        </div>
      </div>
    </div>`;
  const vendorStyle = document.createElement("style");
  vendorStyle.textContent = `
    [data-mail-layout] { display: flex; flex-direction: row; }
    .contents { display: contents; }
    [data-pane-wrapper] { flex: 1; min-height: auto; }
    nav { flex-shrink: 1; }
    [data-slot="scroll-area-viewport"] { overflow-y: scroll; }`;
  const adapterStyle = document.createElement("style");
  adapterStyle.textContent = readParentAppearance(document).css;
  document.head.append(vendorStyle, adapterStyle);

  const computed = (selector: string) => getComputedStyle(document.querySelector(selector)!);
  expect(computed("[data-mail-layout]").flexDirection).toBe("column");
  expect(computed("[data-pane-wrapper]").minHeight).toBe("0px");
  expect(computed("nav").height).toBe("48px");
  expect(computed("nav").flexShrink).toBe("0");
  expect(computed('[data-slot="scroll-area-viewport"]').overflowY).toBe("scroll");
});
