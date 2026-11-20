import { act, fireEvent, render, screen } from "@testing-library/react";
import { CopyButton } from "./CopyButton";

// Copies its text (a filled copy-row template) to the clipboard and confirms
// for a moment; a blocked clipboard leaves it quiet rather than throwing.

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// Click and let the clipboard promise settle.
async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

test("text mode copies, says so, then reverts after a moment", async () => {
  render(<CopyButton text="dataId=7" />);
  const btn = screen.getByRole("button", { name: "Copy row" });
  // The tooltip previews what will be copied.
  expect(btn.getAttribute("title")).toBe("dataId=7");

  await click(btn);
  expect(writeText).toHaveBeenCalledWith("dataId=7");
  expect(btn.textContent).toBe("Copied!");

  act(() => vi.advanceTimersByTime(1499));
  expect(btn.textContent).toBe("Copied!");
  act(() => vi.advanceTimersByTime(1));
  expect(btn.textContent).toBe("Copy row");
});

test("icon mode keeps its label as the name and confirms in the tooltip", async () => {
  render(<CopyButton icon text="dataId=7" label="Copy dataId" />);
  const btn = screen.getByRole("button", { name: "Copy dataId" });
  expect(btn.getAttribute("title")).toBe("dataId=7");
  expect(btn.className).not.toContain("copied");

  await click(btn);
  expect(btn.getAttribute("title")).toBe("Copied!");
  expect(btn.className).toContain("copied");

  act(() => vi.advanceTimersByTime(1500));
  expect(btn.getAttribute("title")).toBe("dataId=7");
});

test("an explicit title overrides the previewed text", () => {
  render(<CopyButton icon text="x" title="Copy the row's dataId" />);
  expect(screen.getByRole("button").getAttribute("title")).toBe(
    "Copy the row's dataId",
  );
});

test("a blocked clipboard leaves the button unchanged", async () => {
  writeText.mockRejectedValue(new Error("NotAllowedError"));
  render(<CopyButton text="dataId=7" />);
  const btn = screen.getByRole("button", { name: "Copy row" });
  await click(btn);
  expect(writeText).toHaveBeenCalled();
  expect(btn.textContent).toBe("Copy row");
});
