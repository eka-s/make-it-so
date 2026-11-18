import { useEffect } from "react";
import { tabTitle } from "./permission-summary";

// While there are pending approvals, tells the user through the browser tab's title and icon (so that it is noticed
// even while looking at another tab). The title is `🔐(count) original title`, and the icon is the 🔐 emoji.
// When no approvals remain, the title goes back and the icon is removed (there was no icon specified originally).

const ATTENTION_ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text y="52" font-size="52">🔐</text></svg>',
)}`;

export function usePendingAttention(baseTitle: string, pendingTotal: number): void {
  useEffect(() => {
    document.title = tabTitle(baseTitle, pendingTotal);
  }, [baseTitle, pendingTotal]);

  const hasPending = pendingTotal > 0;
  useEffect(() => {
    if (!hasPending) return;
    // If there is an existing icon, set it aside and restore it afterwards. If not, create one and remove it afterwards.
    const existing = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    const link = existing ?? document.head.appendChild(Object.assign(document.createElement("link"), { rel: "icon" }));
    const previousHref = existing?.href;
    link.href = ATTENTION_ICON;
    return () => {
      if (existing && previousHref) existing.href = previousHref;
      else link.remove();
    };
  }, [hasPending]);
}
