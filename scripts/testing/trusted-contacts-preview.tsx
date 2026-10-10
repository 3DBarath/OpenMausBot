// The real Trusted contacts section against the fixture's HTTP routes.
// It is mounted on its own: Settings hides this section until its owner
// check answers, and a section requested before that falls back to General.
import { createRoot } from "react-dom/client";
import { TrustedContactsSection } from "../../src/components/TrustedContactsSection";
import { StoreProvider } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

setAnalyticsEnabled(false);
applySkin(readSkin());
const root = createRoot(document.getElementById("root")!);
root.render(<StoreProvider>
  <main className="min-h-screen bg-app px-6 py-8 text-ink">
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-2xl font-semibold">Trusted contacts</h1>
      <TrustedContactsSection />
    </div>
  </main>
</StoreProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
