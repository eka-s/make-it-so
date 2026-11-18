import { Fragment } from "react";
import { ChatMessage } from "./ChatMessage";
import { CrewReportGroup } from "./CrewReportGroup";
import { GapRow } from "./GapRow";
import { groupCrewMessages, splitAtGaps } from "./chat-grouping";
import type { Gap } from "./chat-state";
import type { CrewMemberConfig, Message } from "./types";

type Props = {
  messages: Message[];
  gaps: Gap[];
  crewConfig?: Record<string, CrewMemberConfig>;
  isPinned: (messageId: string) => boolean;
  onTogglePin: (message: Message) => void;
  onOpenResult: (taskId: string, name?: string) => void;
  onCancel: () => void;
  onCrewCancel: (taskId: string) => void;
  isStopping: boolean;
  onFillGap: (gap: Gap, side: "top" | "bottom") => void;
  /** Leave out the messages still being answered (the top pane of the split shows only finished ones). */
  hideStreaming?: boolean;
};

// The conversation drawn from the loaded messages: crew reports grouped into cards, the buttons for the
// holes of the history between the segments. The live pane and the top pane of the split both use it.
export function MessageList({
  messages, gaps, crewConfig, isPinned, onTogglePin, onOpenResult, onCancel, onCrewCancel,
  isStopping, onFillGap, hideStreaming = false,
}: Props) {
  return (
    <>
      {splitAtGaps(messages, gaps).map((segment) => {
        // Filtered per segment (not before splitting), so a hole in front of a hidden message keeps its buttons.
        const shown = hideStreaming ? segment.messages.filter((m) => m.status !== "streaming") : segment.messages;
        return (
          <Fragment key={segment.messages[0].id}>
            {segment.gapBefore && <GapRow gap={segment.gapBefore} onFill={onFillGap} />}
            {groupCrewMessages(shown).map((item) => {
              if ("type" in item) {
                return (
                  <CrewReportGroup
                    key={`crew-group-${item.taskName}-${item.messages[0]?.id}`}
                    messages={item.messages}
                    crewConfig={crewConfig}
                    onCancel={onCrewCancel}
                    onOpenResult={onOpenResult}
                  />
                );
              }
              return (
                <ChatMessage
                  key={item.id}
                  message={item}
                  crewConfig={crewConfig}
                  isPinned={isPinned(item.id)}
                  onTogglePin={onTogglePin}
                  onOpenResult={onOpenResult}
                  onCancel={item.status === "streaming" ? onCancel : undefined}
                  isStopping={isStopping}
                  thinking={item.activity ? [item.activity] : undefined}
                />
              );
            })}
          </Fragment>
        );
      })}
    </>
  );
}
