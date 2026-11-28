import { AudioProcessor, type Cell, type Param, type BuildResult } from "../src";

const empty: BuildResult<{}, {}> = {};
void empty;
class Empty extends AudioProcessor<{}, {}> {
  constructor(context: BaseAudioContext) {
    super(context, () => ({}));
  }
  get output() {
    return undefined;
  }
}
declare const emptyProcessor: Empty;
// @ts-expect-error Empty registries do not accept invented reads.
void emptyProcessor.cells.typo;
// @ts-expect-error Declared nonempty params remain required.
const missingParam: BuildResult<{ gain: Param<number> }, {}> = {};
// @ts-expect-error Declared nonempty cells remain required.
const missingCell: BuildResult<{}, { playing: Cell<boolean> }> = {};
void missingParam;
void missingCell;
function passthrough<P extends Record<string, Param<number>>>(value: BuildResult<P, {}>): BuildResult<P, {}> {
  return value;
}
void passthrough;
