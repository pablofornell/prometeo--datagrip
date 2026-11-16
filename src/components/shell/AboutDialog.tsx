import { For, type JSX, Show, createResource, createSignal, onCleanup } from "solid-js";
import { isTauri } from "../../api/tauri";
import { aboutOpen, setAboutOpen } from "../../state/ui";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { copyText } from "../ui/clipboard";
import { COPIED_FEEDBACK_MS } from "../ui/CopyButton";
import { type AboutInfo, APP_NAME, aboutRows, formatVersionInfo, platformName } from "./aboutInfo";

export function AboutDialog(): JSX.Element {
  return (
    <Show when={aboutOpen()}>
      <AboutContent />
    </Show>
  );
}

/** The runtime version, `null` in a browser (or when the call fails). */
async function tauriVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { getTauriVersion } = await import("@tauri-apps/api/app");
    return await getTauriVersion();
  } catch {
    return null;
  }
}

async function readAboutInfo(): Promise<AboutInfo> {
  return {
    name: APP_NAME,
    version: __APP_VERSION__,
    buildDate: __BUILD_DATE__,
    tauriVersion: await tauriVersion(),
    platform: platformName(navigator.userAgent),
    license: __APP_LICENSE__,
    userAgent: navigator.userAgent,
  };
}

function AboutContent(): JSX.Element {
  const [info] = createResource(readAboutInfo);
  const [copied, setCopied] = createSignal<"idle" | "done" | "failed">("idle");
  let timer = 0;
  onCleanup(() => window.clearTimeout(timer));
  const close = () => setAboutOpen(false);
  const copy = async () => {
    const i = info();
    if (!i) return;
    setCopied((await copyText(formatVersionInfo(i))) ? "done" : "failed");
    window.clearTimeout(timer);
    timer = window.setTimeout(() => setCopied("idle"), COPIED_FEEDBACK_MS);
  };
  return (
    <Dialog
      title={`About ${APP_NAME}`}
      width={420}
      onClose={close}
      footerLeft={
        <Button disabled={!info()} onClick={() => void copy()}>
          {copied() === "done" ? "Copied" : copied() === "failed" ? "Copy failed" : "Copy version info"}
        </Button>
      }
      buttons={[{ label: "OK", primary: true, run: close }]}
    >
      <div class="dg-about">
        <div class="dg-about-name">{APP_NAME}</div>
        <div class="dg-about-tagline">A lightweight database client.</div>
        <Show when={info()}>
          {(i) => (
            <dl class="dg-about-rows">
              <For each={aboutRows(i())}>
                {([label, value]) => (
                  <>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </>
                )}
              </For>
            </dl>
          )}
        </Show>
      </div>
    </Dialog>
  );
}
