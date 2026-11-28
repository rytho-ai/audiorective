// Type-level checks, compiled by `pnpm --filter @audiorective/host typecheck` (no runtime).
import type { Param } from "@audiorective/core";
import type { WebClapHost } from "../src/webclap";

declare const host: WebClapHost;
declare const id: number;
declare const key: string;

const literal: Param<number> = host.params["7"];
const byNumber: Param<number> | undefined = host.params[id];
const byString: Param<number> | undefined = host.params[key];
const fromInfo: Param<number> | undefined = host.params[host.parameterInfo[0]!.id];
const checked: Param<number> | undefined = host.param(id);
// @ts-expect-error a dynamic id may be undefined: the plug-in may not have it
const unchecked: Param<number> = host.params[key];

export { literal, byNumber, byString, fromInfo, checked, unchecked };
