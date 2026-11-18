import { useState, useCallback, useEffect } from "react";
import { api } from "./server-api";
import type { Message, PinnedMessage } from "./types";

// A pin is a sub-concept of a mission. It is re-fetched for that mission every time the mission
// switches — the client does not merge the previous mission's list by deltas (CLAUDE.md policy).
export function usePinnedMessages(missionId: string) {
  const [pinnedMessages, setPinnedMessages] = useState<PinnedMessage[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    api.getPins(missionId, controller.signal)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: PinnedMessage[]) => {
        setPinnedMessages(data);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[Pins] Failed to load pins:", err);
      });
    return () => controller.abort();
  }, [missionId]);

  const isPinned = useCallback(
    (messageId: string): boolean => {
      return pinnedMessages.some((p) => p.messageId === messageId);
    },
    [pinnedMessages]
  );

  const togglePin = useCallback(
    (message: Message) => {
      const exists = pinnedMessages.find((p) => p.messageId === message.id);
      if (exists) {
        // Unpin — delete from the server
        api.deletePin(message.id)
          .then((res) => {
            if (!res.ok && res.status !== 404) {
              throw new Error(`HTTP ${res.status}`);
            }
            setPinnedMessages((prev) => prev.filter((p) => p.messageId !== message.id));
          })
          .catch((err) => {
            console.error("[Pins] Failed to unpin:", err);
          });
      } else {
        // Pin — create on the server
        const body = {
          messageId: message.id,
          role: message.role,
          text: message.text,
          timestamp: message.timestamp,
          missionId: message.missionId,
        };
        api.createPin(body)
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          })
          .then((pin: PinnedMessage) => {
            setPinnedMessages((prev) => [...prev, pin]);
          })
          .catch((err) => {
            console.error("[Pins] Failed to pin:", err);
          });
      }
    },
    [pinnedMessages]
  );

  return {
    pinnedMessages,
    isPinned,
    togglePin,
  };
}
