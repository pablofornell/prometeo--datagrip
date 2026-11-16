/**
 * Moving one table of a routed diagram. A `DragSession` builds the obstacle lattice once (`Router`), and each move
 * unblocks the box's old rectangle, blocks the new one and routes only the edges that touch the box; every other
 * route stays exactly as it is. `finish` does the same for the drop position and also places the labels of the
 * edges that moved (the other labels stay), so a drop never routes the whole diagram again.
 */
import type { DiagramModel } from "./model";
import { placeLabels, Router, type LabelBox, type Rect, type RoutedEdge } from "./route";
import { boundsOf, type Scene } from "./svg";

export class DragSession {
  /** The edges that start or end at the dragged table. */
  readonly edges = new Set<number>();
  private readonly router: Router;

  constructor(
    private readonly model: DiagramModel,
    private readonly scene: Scene,
    readonly index: number,
  ) {
    model.edges.forEach((e, i) => {
      if (e.from === index || e.to === index) this.edges.add(i);
    });
    this.router = new Router(model, scene.rects);
    this.router.hold(scene.routes, this.edges);
    this.preview = true;
  }

  /** Frames are drafts (searches capped) until the drop; off, `move` routes exactly like a whole routing would. */
  get preview(): boolean {
    return this.router.preview;
  }
  set preview(on: boolean) {
    this.router.preview = on;
  }

  /** The dragged table's edges with the box at `rect` (new objects; the scene is not touched). */
  move(rect: Rect): RoutedEdge[] {
    this.router.moveBox(this.index, rect);
    return this.router.route(this.edges, true);
  }

  /** The scene with the box dropped at `rect`: its edges re-routed, and their labels (and any label under the box) placed again. */
  finish(rect: Rect): { scene: Scene; changed: Set<number> } {
    const { model, scene } = this;
    this.preview = false; // the dropped routes are exact, the frames before were drafts
    const moved = this.move(rect);
    const rects = scene.rects.map((r, i) => (i === this.index ? rect : r));
    const routes = scene.routes.map((r, i) => moved[i] ?? r);
    const changed = new Set(this.edges);
    // a kept label that now sits under the box is placed again
    const under = (l: LabelBox): boolean => Math.abs(l.x - (rect.x + rect.w / 2)) < l.w / 2 + rect.w / 2 + 4 && Math.abs(l.y - (rect.y + rect.h / 2)) < l.h / 2 + rect.h / 2 + 4;
    routes.forEach((r, i) => {
      if (r && !changed.has(i) && r.label && under(r.label)) {
        routes[i] = { ...r };
        changed.add(i);
      }
    });
    placeLabels(model, routes, rects, changed);
    const loops = new Set(model.edges.filter((e) => e.self).map((e) => e.from));
    return { scene: { rects, routes, bounds: boundsOf(rects, routes, loops) }, changed };
  }
}
