// Deployment facts the backend writes into index.html as it serves the page
// (render_index in spa.py): the path prefix the app is served under, and
// whether the instance is production or dev (RUBINTV_INSTANCE_ENV). One image
// serves every deployment, so neither can be baked into the build — and
// nothing in the URL can stand in for the env: summit dev shares its host
// with prod.
//
// The block is absent when Vite's dev server serves index.html (and under
// vitest); callers fall back to the dev-server defaults then.

export type DeploymentEnv = "prod" | "dev";

export interface Deployment {
  prefix?: string;
  env?: DeploymentEnv;
}

// Matches DEPLOYMENT_ELEMENT_ID in spa.py.
const ELEMENT_ID = "rubintv-deployment";

// Fields of the wrong type are dropped rather than trusted, so a malformed
// block degrades to the fallbacks instead of a broken router basename.
export function readDeployment(
  doc: Document | undefined = globalThis.document,
): Deployment {
  const text = doc?.getElementById(ELEMENT_ID)?.textContent;
  if (!text) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null) return {};
  const { prefix, env } = raw as Record<string, unknown>;
  return {
    ...(typeof prefix === "string" && { prefix }),
    ...((env === "prod" || env === "dev") && { env }),
  };
}

// Read once: the block is fixed for the page's lifetime, and the module
// scripts that import this run after the document has parsed.
export const DEPLOYMENT = readDeployment();
