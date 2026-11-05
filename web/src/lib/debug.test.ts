// debugLog is gated by a localStorage flag read once at load, so each test
// sets the flag and then imports a fresh copy of the module.

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function freshDebugLog() {
  vi.resetModules();
  return (await import("./debug")).debugLog;
}

test("is silent unless the rubintv:debug flag is set", async () => {
  const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
  const debugLog = await freshDebugLog();
  debugLog("ws.send", { a: 1 });
  expect(spy).not.toHaveBeenCalled();
});

test("with the flag set, logs under a scoped prefix", async () => {
  localStorage.setItem("rubintv:debug", "1");
  const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
  const debugLog = await freshDebugLog();
  debugLog("ws.send", { a: 1 }, 2);
  expect(spy).toHaveBeenCalledWith("[rubintv:ws.send]", { a: 1 }, 2);
});
