import React, { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { ImageOff, Image } from 'lucide-react';

interface MessageBodyProps {
  html: string;
  text: string;
}

const PLACEHOLDER_STYLE =
  'display:inline-block;padding:2px 8px;margin:2px 0;background:#f4f4f0;border-radius:4px;font-size:12px;color:#71717a;';

/** Only these link targets survive; javascript:, data:, vbscript: and relative URLs are dropped. */
const ALLOWED_URI = /^(?:https?:|mailto:|tel:)/i;
const REMOTE_SRC = /^https?:\/\//i;

// Anything that can load a resource without an <img src> we control, or alter
// the page, is removed outright: srcset/<picture>/<source>, background=,
// inline style (url() backgrounds), media elements, forms, embeds.
const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    'style', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'option',
    'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'picture', 'source', 'video',
    'audio', 'track', 'noscript', 'template',
  ],
  FORBID_ATTR: ['style', 'srcset', 'background', 'poster', 'ping', 'lowsrc', 'dynsrc', 'formaction', 'action', 'longdesc'],
  ALLOWED_URI_REGEXP: ALLOWED_URI,
  ALLOW_DATA_ATTR: false,
};

/**
 * Sanitises with DOMPurify, then rewrites links and images on the resulting
 * fragment: links open in a new tab without an opener, and an image stays only
 * when it is a remote http(s) image and the user chose to show images. Every
 * other image (hidden remote, data:, blob:, cid:) becomes a placeholder.
 */
function sanitizeEmail(html: string, showImages: boolean): { html: string; remoteImages: number } {
  const fragment = DOMPurify.sanitize(html, { ...PURIFY_CONFIG, RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
  // The fragment belongs to DOMPurify's inert DOMParser document, which has no
  // browsing context, so the <img> nodes below never fetch while we inspect them.
  const doc = fragment.ownerDocument;

  fragment.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (!ALLOWED_URI.test(href.trim())) a.removeAttribute('href');
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });

  let remoteImages = 0;
  fragment.querySelectorAll('img').forEach((img) => {
    const src = (img.getAttribute('src') || '').trim();
    const remote = REMOTE_SRC.test(src);
    if (remote) remoteImages++;
    if (remote && showImages) {
      img.setAttribute('referrerpolicy', 'no-referrer');
      return;
    }
    const span = doc.createElement('span');
    span.setAttribute('style', PLACEHOLDER_STYLE);
    span.textContent = 'Image hidden';
    img.replaceWith(span);
  });

  const container = doc.createElement('div');
  container.appendChild(fragment);
  return { html: container.innerHTML, remoteImages };
}

/**
 * CSP for the iframe document. No scripts, frames, forms or fonts anywhere;
 * images load only after the user opts in, and then only over http(s).
 * Inline style is allowed for our own <style> block (style attributes are
 * stripped by the sanitiser).
 */
const cspFor = (showImages: boolean) =>
  [
    "default-src 'none'",
    `img-src ${showImages ? 'https: http:' : "'none'"}`,
    "style-src 'unsafe-inline'",
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');

export const MessageBody: React.FC<MessageBodyProps> = ({ html, text }) => {
  const [showImages, setShowImages] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(80);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const hasHtml = Boolean(html && html.trim());
  const { html: processedHtml, remoteImages } = useMemo(
    () => (hasHtml ? sanitizeEmail(html, showImages) : { html: '', remoteImages: 0 }),
    [hasHtml, html, showImages],
  );
  const hasRemoteImages = remoteImages > 0;

  const measure = () => {
    const doc = iframeRef.current?.contentDocument;
    if (doc?.documentElement) setIframeHeight(Math.max(40, doc.documentElement.scrollHeight));
  };

  // Re-measure when late content (images) changes the height.
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const imgs = Array.from(doc.images);
    imgs.forEach((img) => img.addEventListener('load', measure));
    return () => imgs.forEach((img) => img.removeEventListener('load', measure));
  });

  if (!hasHtml) {
    return <div className="text-[14px] text-[#18181b] leading-relaxed whitespace-pre-wrap select-text">{text}</div>;
  }

  const srcDoc = `<!DOCTYPE html><html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${cspFor(showImages)}" />
<meta name="referrer" content="no-referrer" />
<base target="_blank" />
<style>
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px; line-height: 1.6; color: #18181b; background: transparent; overflow-wrap: anywhere; }
  a { color: #047857; }
  blockquote { margin: 12px 0; padding-left: 12px; border-left: 3px solid #e8e8e3; color: #71717a; }
  p { margin: 0 0 1em; } p:last-child { margin-bottom: 0; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
</style></head><body>${processedHtml}</body></html>`;

  return (
    <div>
      {hasRemoteImages && (
        <button
          type="button"
          onClick={() => setShowImages((v) => !v)}
          className="mb-3 inline-flex items-center gap-1.5 text-[12px] text-[#71717a] hover:text-[#18181b] cursor-pointer"
        >
          {showImages ? <ImageOff className="w-3.5 h-3.5" /> : <Image className="w-3.5 h-3.5" />}
          {showImages ? 'Hide images' : 'Images hidden to block tracking · Show'}
        </button>
      )}
      <iframe
        ref={iframeRef}
        title="Email content"
        // allow-same-origin (without allow-scripts) only lets us measure the
        // height; nothing inside the email can run. The CSP in srcDoc is a
        // second barrier on top of DOMPurify.
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        onLoad={measure}
        className="block w-full border-0"
        style={{ height: `${iframeHeight}px` }}
      />
    </div>
  );
};
