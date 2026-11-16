/**
 * The heavy, pure part of the diagram: layout (Sugiyama) and edge routing for a model. `computeScene` is what the web
 * worker runs (`diagram.worker.ts`) and also the synchronous fallback where there is no worker (tests, a webview that
 * refuses one). Requests and responses are plain data (no Maps, no functions), so they survive structured cloning and
 * the result of the worker is exactly the result of the fallback.
 */
import { layoutDiagram, type Direction, type LayoutResult } from "./layout";
import type { DiagramModel } from "./model";
import { buildScene, type Scene } from "./svg";

export interface SceneRequest {
  model: DiagramModel;
  direction: Direction;
  /** The layout of this model and direction when the caller already has it (only the positions changed), else null. */
  layout: LayoutResult | null;
  /** Positions the user dragged tables to, keyed by `schema.name`. */
  positions: [string, { x: number; y: number }][];
}

export interface SceneResponse {
  layout: LayoutResult;
  scene: Scene;
}

export function computeScene(req: SceneRequest): SceneResponse {
  const layout = req.layout ?? layoutDiagram(req.model, { direction: req.direction });
  const scene = buildScene(req.model, layout, new Map(req.positions));
  return { layout, scene };
}
