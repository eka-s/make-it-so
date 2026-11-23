import { useEffect, useRef, useState, type MouseEvent } from "react";
import { A2uiSurface, type ReactCatalogComponent } from "@a2ui/react";
import { MessageProcessor, basicCatalog, injectBasicCatalogStyles, peekValue, setMarkdownRenderer, type ActionPayload } from "@a2ui/web_core/v1_0";
import { renderMarkdown } from "@a2ui/markdown-it";
import { useI18n } from "./i18n/I18nProvider";
import type { A2uiAnswer } from "./types";

let rendererReady = false;

/** The basic catalog's styles and its Markdown renderer (Text shows nothing without one) are set up once, on first use. */
function ensureRendererReady(): void {
  if (rendererReady) return;
  injectBasicCatalogStyles();
  setMarkdownRenderer(renderMarkdown);
  rendererReady = true;
}

/** A link in the form's text opens in a new tab, as a link in a reply of the conversation does (the form is not replaced by the page it points to). */
function openLinksInNewTab(event: MouseEvent<HTMLElement>): void {
  const anchor = (event.target as HTMLElement).closest("a[href]");
  if (!anchor) return;
  event.preventDefault();
  const url = anchor.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
}

type Props = {
  /** The A2UI v1.0 messages of the form, as the server sent them. */
  messages: Array<Record<string, unknown>>;
  /** Whether the captain can still use the form. False once it was answered (it is shown as it was then). */
  open: boolean;
  /** The comment the captain wrote with the answer (shown in the comment field of an answered form). */
  comment?: string;
  /** A button was pressed; resolves when the server has the answer (or rejects when it could not be sent). */
  onAction: (answer: A2uiAnswer) => Promise<void>;
};

/** The surface made by the A2UI messages of one reply, drawn with the A2UI renderer, with the captain's comment field under it. */
export function A2uiBody({ messages, open, comment, onAction }: Props) {
  const { t } = useI18n();
  // The comment field is the captain's own, whatever the form asks: what is in it goes along with the answer.
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Between the press and the server's answer the form cannot be pressed again.
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;

  // The processor is made and disposed in the same effect. The messages change when the form is answered (the server adds the values it
  // had then), which builds it again from the new content.
  const content = JSON.stringify(messages);
  const [built, setBuilt] = useState<{ processor: MessageProcessor<ReactCatalogComponent>; errors: unknown[] } | null>(null);
  useEffect(() => {
    ensureRendererReady();
    const processor: MessageProcessor<ReactCatalogComponent> = new MessageProcessor<ReactCatalogComponent>(
      [basicCatalog],
      (action: ActionPayload) => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        const surface = processor.getSurfaces().get(action.surfaceId);
        const dataModel = (surface ? peekValue(surface.dataModel.getSignal<Record<string, unknown>>("/")) : undefined) ?? {};
        const { name, surfaceId, sourceComponentId, timestamp, context } = action;
        return onActionRef.current({ action: { name, surfaceId, sourceComponentId, timestamp, context }, dataModel, comment: draftRef.current })
          .finally(() => {
            busyRef.current = false;
            setBusy(false);
          });
      },
    );
    setBuilt({ processor, errors: processor.processMessagesWithErrors(JSON.parse(content)) });
    return () => processor.dispose();
  }, [content]);

  return (
    <div className={`a2ui-block ${open ? "a2ui-block--open" : "a2ui-block--answered"}`} onClick={openLinksInNewTab}>
      {/* A disabled fieldset disables every input and button inside it (the surface is drawn without a shadow root). */}
      <fieldset className="a2ui-body" disabled={!open || busy}>
        {built && Array.from(built.processor.getSurfaces().values()).map((surface) => (
          <A2uiSurface key={surface.id} surface={surface} />
        ))}
        {built && built.errors.length > 0 && <pre className="a2ui-errors">{JSON.stringify(built.errors, null, 2)}</pre>}
      </fieldset>
      {(open || comment) && (
        <div className="a2ui-comment">
          <label className="a2ui-comment-label">
            {t("a2ui.commentLabel")}
            <textarea
              className="a2ui-comment-field"
              rows={3}
              value={open ? draft : (comment ?? "")}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("a2ui.commentPlaceholder")}
              disabled={!open || busy}
            />
          </label>
        </div>
      )}
    </div>
  );
}
