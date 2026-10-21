import React, { useEffect, useRef, useState } from 'react';
import { ImageOff, Image } from 'lucide-react';

interface MessageBodyProps {
  html: string;
  text: string;
}

const BLOCKED_IMAGE =
  '<span style="display:inline-block;padding:2px 8px;margin:2px 0;background:#f4f4f0;border-radius:4px;font-size:12px;color:#71717a;">Image hidden</span>';

const REMOTE_IMG_RE = /<img\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/gi;

// Strip anything active or page-altering. The iframe is also sandboxed without
// allow-scripts, so this is defence in depth rather than the only barrier.
const sanitize = (html: string) =>
  html
    .replace(/<(script|style|iframe|object|form|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|style|iframe|object|embed|form|meta|link|base|noscript)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*(["'])\s*(javascript|vbscript):[^"']*\2/gi, '')
    .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/<img\b[^>]*\bsrc\s*=\s*["'](data|blob):[^"']*["'][^>]*>/gi, BLOCKED_IMAGE);

export const MessageBody: React.FC<MessageBodyProps> = ({ html, text }) => {
  const [showImages, setShowImages] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(80);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const hasHtml = Boolean(html && html.trim());
  const clean = hasHtml ? sanitize(html) : '';
  const hasRemoteImages = REMOTE_IMG_RE.test(clean);
  REMOTE_IMG_RE.lastIndex = 0;
  const processedHtml = showImages ? clean : clean.replace(REMOTE_IMG_RE, BLOCKED_IMAGE);

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

  const srcDoc = `<!DOCTYPE html><html><head><meta charset="utf-8" /><base target="_blank" />
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
        // height; nothing inside the email can run.
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        onLoad={measure}
        className="block w-full border-0"
        style={{ height: `${iframeHeight}px` }}
      />
    </div>
  );
};
