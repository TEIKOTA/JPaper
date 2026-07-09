import { describe, expect, it } from "vitest";

import { APP_NAME } from "./index.js";

describe("JPaper scaffold", () => {
  it("APP_NAME を公開する", () => {
    expect(APP_NAME).toBe("JPaper");
  });
});
