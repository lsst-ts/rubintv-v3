import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfirmButton } from "./ConfirmButton";

// The inline confirm: the button arms on first click, fires onConfirm on the
// confirm click, and reverts on Cancel or Escape without firing.

test("arms on click, fires onConfirm on confirm", async () => {
  let fired = 0;
  render(<ConfirmButton label="Restart" onConfirm={() => { fired++; }} />);

  fireEvent.click(screen.getByRole("button", { name: "Restart" }));
  expect(fired).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Confirm?" }));
  await waitFor(() => expect(fired).toBe(1));
});

test("Cancel reverts without firing", () => {
  let fired = 0;
  render(<ConfirmButton label="Restart" onConfirm={() => { fired++; }} />);

  fireEvent.click(screen.getByRole("button", { name: "Restart" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(fired).toBe(0);
  // Back to the single armed-able button.
  expect(screen.getByRole("button", { name: "Restart" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Confirm?" })).toBeNull();
});

test("Escape cancels the armed confirm", async () => {
  let fired = 0;
  render(<ConfirmButton label="Restart" onConfirm={() => { fired++; }} />);

  fireEvent.click(screen.getByRole("button", { name: "Restart" }));
  // Escape on the confirm-group reverts it (the group carries the handler).
  fireEvent.keyDown(screen.getByRole("button", { name: "Confirm?" }), {
    key: "Escape",
  });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Confirm?" })).toBeNull(),
  );
  expect(fired).toBe(0);
  expect(screen.getByRole("button", { name: "Restart" })).toBeDefined();
});
