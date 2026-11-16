/** Web worker of the diagram: lays out and routes a model off the main thread (see `engine.ts`, `engineClient.ts`). */
import { computeScene, type SceneRequest } from "./engine";

interface Scope {
  onmessage: ((e: { data: { id: number; req: SceneRequest } }) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as Scope;

scope.onmessage = (e) => {
  const { id, req } = e.data;
  try {
    scope.postMessage({ id, res: computeScene(req) });
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
