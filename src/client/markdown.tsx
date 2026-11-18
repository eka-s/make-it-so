import type { Components } from "react-markdown";

// How agent output (Markdown) is drawn. Images are never loaded: an image address in agent output is chosen by whatever the
// agent read (a repository file, a web page), and loading it would send the browser to an address of someone else's choosing
// (with data in the address). The alt text is shown instead.
//
// Links are drawn as links, but open in a new tab (the screen itself is never navigated away from: it holds the live conversation)
// without telling the target which page opened it. Only web and mail addresses are links (react-markdown drops the rest, such as
// `javascript:`).
export const markdownComponents: Components = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  img: ({ alt }) => <span className="markdown-image-blocked">[{alt ? `image: ${alt}` : "image"}]</span>,
};
