import { useState } from "react";
import { useT } from "./i18n/I18nProvider";

type Props = {
  text: string;
  className?: string;
  title?: string;
};

export function CopyButton({ text, className, title }: Props) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for contexts where the asynchronous Clipboard API is unavailable
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand("copy"); } catch { /* give up silently */ }
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      className={`copy-btn${className ? ` ${className}` : ""}${copied ? " copy-btn--copied" : ""}`}
      onClick={handleCopy}
      title={copied ? t("common.copied") : (title ?? t("common.copy"))}
      aria-label={copied ? t("common.copied") : (title ?? t("common.copy"))}
    >
      {copied ? "✓" : "📋"}
    </button>
  );
}
