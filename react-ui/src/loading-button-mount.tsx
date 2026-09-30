import React from "react";
import { createRoot, type Root } from "react-dom/client";
import LoadingButton from "../../components/ui/loading-button";
import "./index.css";

type Action = () => unknown | Promise<unknown>;

declare global {
  interface Window {
    RevexLoadingActions?: Record<string, Action>;
  }
}

const roots = new Map<Element, Root>();

function mountOne(node: Element) {
  if (roots.has(node)) return;
  const el = node as HTMLElement;
  const actionName = el.dataset.action || "";
  const action = () => {
    const fn = window.RevexLoadingActions?.[actionName];
    if (!fn) throw new Error(`REVEX action is not ready: ${actionName}`);
    return fn();
  };

  const root = createRoot(node);
  roots.set(node, root);
  root.render(
    <LoadingButton
      onAction={action}
      pendingLabel={el.dataset.pending || "Processing…"}
      successLabel={el.dataset.success || "Done"}
      errorLabel={el.dataset.error || "Try again"}
      resetAfter={Number(el.dataset.resetAfter || 1800)}
      disabled={el.dataset.disabled === "true"}
      className={el.dataset.className || "w-full"}
    >
      {el.dataset.label || "Submit"}
    </LoadingButton>,
  );
}

function scan() {
  document.querySelectorAll("[data-revex-loading-button]").forEach(mountOne);
}

window.addEventListener("load", scan);
new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
scan();
