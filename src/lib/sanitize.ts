import DOMPurify from "dompurify";

const BASE_TAGS = ["p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li", "a", "span", "div", "h1", "h2", "h3", "h4", "blockquote", "code", "pre"];
const BASE_ATTR = ["href", "title", "target", "rel", "class"];

export function sanitizeRichHtml(value: string, allowMedia = false): string {
  return DOMPurify.sanitize(String(value || ""), {
    ALLOWED_TAGS: allowMedia ? [...BASE_TAGS, "img", "iframe", "video", "source"] : BASE_TAGS,
    ALLOWED_ATTR: allowMedia ? [...BASE_ATTR, "src", "alt", "loading", "allow", "allowfullscreen", "controls", "width", "height", "frameborder"] : BASE_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ["script", "style", "object", "embed", "form", "input", "button", "svg", "math"],
    FORBID_ATTR: ["style", "srcdoc"],
  });
}
