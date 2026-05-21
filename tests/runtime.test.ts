import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBun, runtimeLabel, runtimeVersion } from "../src/runtime.js";

describe("runtime", () => {
    it("detects Node runtime", () => {
        assert.equal(isBun, false);
        assert.equal(runtimeLabel(), "node");
        assert.equal(runtimeVersion(), process.versions.node);
    });
});
