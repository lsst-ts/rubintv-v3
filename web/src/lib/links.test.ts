import { describe, expect, test } from "vitest";
import { fillTemplate } from "./links";

describe("fillTemplate", () => {
  test("fills dayObs (hyphens stripped) and zero-padded seqNum", () => {
    const out = fillTemplate(
      "http://ccs.lsst.org/view?image=AT_O_{dayObs}_{seqNum:06}",
      "2026-04-10",
      252,
    );
    expect(out).toBe("http://ccs.lsst.org/view?image=AT_O_20260410_000252");
  });

  test("uses the controller default when no controller metadata is given", () => {
    const out = fillTemplate(
      "x_{controller:default=O}_{seqNum:06}",
      "2026-04-10",
      7,
    );
    expect(out).toBe("x_O_000007");
  });

  test("prefers the row's controller value over the default", () => {
    const out = fillTemplate(
      "x_{controller:default=O}_{seqNum:06}",
      "2026-04-10",
      7,
      { controller: "C" },
    );
    expect(out).toBe("x_C_000007");
  });

  test("maps siteLoc summit→cp and base→ls; unknown→empty", () => {
    const tmpl = "http://lsstcam-mcm.{siteLoc}.lsst.org/{seqNum:06}";
    expect(fillTemplate(tmpl, "2026-04-10", 1, { siteLocation: "summit" })).toBe(
      "http://lsstcam-mcm.cp.lsst.org/000001",
    );
    expect(fillTemplate(tmpl, "2026-04-10", 1, { siteLocation: "base" })).toBe(
      "http://lsstcam-mcm.ls.lsst.org/000001",
    );
    expect(fillTemplate(tmpl, "2026-04-10", 1, { siteLocation: "usdf" })).toBe(
      "http://lsstcam-mcm..lsst.org/000001",
    );
  });

  test("dev placeholder becomes -dev only on a dev instance", () => {
    const tmpl = "https://usdf-rsp{dev}.slac.stanford.edu/{seqNum:05}";
    expect(fillTemplate(tmpl, "2026-04-10", 42, { isDevInstance: true })).toBe(
      "https://usdf-rsp-dev.slac.stanford.edu/00042",
    );
    expect(fillTemplate(tmpl, "2026-04-10", 42, { isDevInstance: false })).toBe(
      "https://usdf-rsp.slac.stanford.edu/00042",
    );
  });

  test("fills a copy_row_template dataId string", () => {
    const out = fillTemplate(
      'dataId = {"day_obs": {dayObs}, "seq_num": {seqNum:06}, "detector": 0}',
      "2026-04-10",
      252,
    );
    expect(out).toBe(
      'dataId = {"day_obs": 20260410, "seq_num": 000252, "detector": 0}',
    );
  });
});
