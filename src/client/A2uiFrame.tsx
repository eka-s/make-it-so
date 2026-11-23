import { Component, Suspense, lazy, type ReactNode } from "react";
import { useI18n } from "./i18n/I18nProvider";
import type { A2uiAnswer } from "./types";

// Loaded only when a message carries an A2UI form: the A2UI renderer needs a DOM the moment it is imported, and it is large.
const A2uiBody = lazy(() => import("./A2uiBody").then((m) => ({ default: m.A2uiBody })));

type Props = {
  /** The A2UI v1.0 messages of the form, as the server sent them. */
  messages: Array<Record<string, unknown>>;
  /** Whether the captain can still use the form. */
  open: boolean;
  /** The comment the captain wrote with the answer. */
  comment?: string;
  onAction: (answer: A2uiAnswer) => Promise<void>;
};

/** What stands in for a form that could not be drawn (the part failed to load, or the renderer threw). The captain can still close it: the button is in the bar. */
function A2uiFallback() {
  const { t } = useI18n();
  return (
    <div className="a2ui-block a2ui-block--failed">
      <div className="a2ui-failed">{t("a2ui.failed")}</div>
    </div>
  );
}

/** Catches a failure to draw the screen, so it never takes the conversation down and never leaves the captain locked out. */
class A2uiBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[A2UI] The screen could not be drawn:", error);
  }

  render() {
    return this.state.failed ? <A2uiFallback /> : this.props.children;
  }
}

/** The A2UI form under a reply: drawn with the renderer, or the fallback when that fails. */
export function A2uiFrame({ messages, open, comment, onAction }: Props) {
  return (
    <A2uiBoundary>
      <Suspense fallback={null}>
        <A2uiBody messages={messages} open={open} comment={comment} onAction={onAction} />
      </Suspense>
    </A2uiBoundary>
  );
}
