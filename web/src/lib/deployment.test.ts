import { afterEach, describe, expect, test } from "vitest";
import { readDeployment } from "./deployment";

// The block render_index (spa.py) writes before </head>.
function writeBlock(text: string) {
  const el = document.createElement("script");
  el.id = "rubintv-deployment";
  el.type = "application/json";
  el.textContent = text;
  document.head.append(el);
}

afterEach(() => {
  document.getElementById("rubintv-deployment")?.remove();
});

describe("readDeployment", () => {
  test("reads the prefix and env the backend wrote", () => {
    writeBlock('{"prefix": "/rubintv-dev", "env": "dev"}');
    expect(readDeployment()).toEqual({ prefix: "/rubintv-dev", env: "dev" });
  });

  test("an empty prefix (served at the root) is kept, not dropped", () => {
    writeBlock('{"prefix": "", "env": "prod"}');
    expect(readDeployment()).toEqual({ prefix: "", env: "prod" });
  });

  test("no block (the Vite dev server) yields nothing", () => {
    expect(readDeployment()).toEqual({});
  });

  test("malformed JSON or wrongly-typed fields fall back", () => {
    writeBlock("{not json");
    expect(readDeployment()).toEqual({});
    document.getElementById("rubintv-deployment")?.remove();
    writeBlock('{"prefix": 7, "env": "staging"}');
    expect(readDeployment()).toEqual({});
  });
});
