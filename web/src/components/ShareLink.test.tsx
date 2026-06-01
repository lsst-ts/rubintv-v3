import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShareLink } from "./ShareLink";

test("copies the current url, adding the resolved date if absent", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  // jsdom has no clipboard by default; define one.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  window.history.pushState({}, "", "/local/lsstcam");

  render(<ShareLink date="2026-04-10" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  expect(writeText.mock.calls[0][0]).toContain("/local/lsstcam");
  expect(writeText.mock.calls[0][0]).toContain("date=2026-04-10");
  // Transient confirmation.
  expect(await screen.findByText("Copied!")).toBeDefined();
});
