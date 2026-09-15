// The local loop runs a locally built Eve runtime image whose tag is a build name, not an Eve
// release. The startup gate (ADR 0195) expects `runtimeImage.eveVersion`, falling back to the
// tag - so without the release stated, every agent `hg up` deploys expects "hermes-gitops-dev",
// finds eve@<pin> in its build receipt, and never becomes ready.
import { describe, expect, test } from "bun:test";
import { localEveRuntimeImage } from "../src/platform/index.ts";
import { EVE_RUNTIME_IMAGE } from "../src/lib.ts";
import versions from "../../versions.json";

describe("the local loop's Eve runtime image values", () => {
  test("name the Eve release the image ships, because the local tag is not one", () => {
    const image = localEveRuntimeImage();
    expect(image.eveVersion).toBe(versions.runtimes.eve.version);
    expect(`${image.repository}:${image.tag}`).toBe(EVE_RUNTIME_IMAGE);
    expect(image.pullPolicy).toBe("Never");
    // The trap this guards: the tag cannot stand in for a release.
    expect(image.tag).not.toMatch(/^\d+\.\d+\.\d+/);
  });
});
