/** A small yes / no dialog (the app has no shared one): `await confirmDialog(...)` resolves true on the confirm button. */
import { type JSX } from "solid-js";
import { render } from "solid-js/web";
import { Dialog } from "../../components/ui";

export interface ConfirmOptions {
  title: string;
  message: JSX.Element;
  confirmLabel: string;
}

export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let dispose = () => {};
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      resolve(v);
      // let Solid finish the current event before the dialog is torn down
      queueMicrotask(() => {
        dispose();
        host.remove();
      });
    };
    dispose = render(
      () => (
        <Dialog
          title={o.title}
          width={440}
          onClose={() => finish(false)}
          buttons={[
            { label: o.confirmLabel, primary: true, run: () => finish(true) },
            { label: "Cancel", run: () => finish(false) },
          ]}
        >
          <div class="dg-mcp-confirm">{o.message}</div>
        </Dialog>
      ),
      host,
    );
  });
}
