import { expect, test } from "vitest";
import { AudioProcessor } from "../src";

test("explicit undefined registries become frozen empty objects", () => {
  const context = new OfflineAudioContext(1, 128, 48000);
  const processor = new (class extends AudioProcessor {
    constructor() {
      super(context, () => ({ params: undefined, cells: undefined }));
    }
    get output() {
      return undefined;
    }
  })();
  try {
    expect(processor.params).toEqual({});
    expect(processor.cells).toEqual({});
    expect(Object.isFrozen(processor.params)).toBe(true);
    expect(Object.isFrozen(processor.cells)).toBe(true);
  } finally {
    processor.dispose();
  }
});
