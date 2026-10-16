import React from 'react';
import type { Platform } from '../../types';

interface PlatformBadgeProps {
  platform: Platform;
  size?: number;
  className?: string;
  showLabel?: boolean;
}

export const PlatformBadge: React.FC<PlatformBadgeProps> = ({
  platform,
  size = 22,
  className = '',
  showLabel = false,
}) => {
  if (platform === 'twitter') {
    return (
      <div className={`inline-flex items-center gap-1.5 ${className}`}>
        <div
          style={{ width: `${size}px`, height: `${size}px` }}
          className="bg-black flex items-center justify-center flex-shrink-0 text-white rounded-none shadow-xs"
          title="X (Twitter)"
        >
          {/* Official X glyph */}
          <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </div>
        {showLabel && <span className="text-xs font-mono text-[#8a8a86]">X</span>}
      </div>
    );
  }

  if (platform === 'linkedin') {
    return (
      <div className={`inline-flex items-center gap-1.5 ${className}`}>
        <div
          style={{ width: `${size}px`, height: `${size}px`, backgroundColor: '#0a66c2' }}
          className="flex items-center justify-center flex-shrink-0 text-white rounded-none shadow-xs"
          title="LinkedIn"
        >
          {/* Official LinkedIn 'in' glyph */}
          <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.46 10.9v8.37H9.2V10.9H6.46M7.83 6.25c-.96 0-1.74.78-1.74 1.74 0 .96.78 1.74 1.74 1.74s1.74-.78 1.74-1.74c0-.96-.78-1.74-1.74-1.74z" />
          </svg>
        </div>
        {showLabel && <span className="text-xs font-mono text-[#8a8a86]">LinkedIn</span>}
      </div>
    );
  }

  if (platform === 'reddit') {
    return (
      <div className={`inline-flex items-center gap-1.5 ${className}`}>
        <div
          style={{ width: `${size}px`, height: `${size}px`, backgroundColor: '#ff4500' }}
          className="flex items-center justify-center flex-shrink-0 text-white rounded-none shadow-xs"
          title="Reddit"
        >
          {/* Official Reddit glyph */}
          <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.702zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" />
          </svg>
        </div>
        {showLabel && <span className="text-xs font-mono text-[#8a8a86]">Reddit</span>}
      </div>
    );
  }

  if (platform === 'news') {
    return (
      <div className={`inline-flex items-center gap-1.5 ${className}`}>
        <div
          style={{ width: `${size}px`, height: `${size}px`, backgroundColor: '#b45309' }}
          className="flex items-center justify-center flex-shrink-0 text-white rounded-none shadow-xs"
          title="News"
        >
          {/* Newspaper */}
          <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2m-9 5H4v4h7V8m5 0v4h-2V8h2m-5 6H4v4h7v-4m5 0v4h-2v-4h2m-5 6H4v1h7v-1m5 0v1h-2v-1h2z" />
          </svg>
        </div>
        {showLabel && <span className="text-xs font-mono text-[#8a8a86]">News</span>}
      </div>
    );
  }

  // Google Discussions / Forums
  return (
    <div className={`inline-flex items-center gap-1.5 ${className}`}>
      <div
        style={{ width: `${size}px`, height: `${size}px`, backgroundColor: '#4285f4' }}
        className="flex items-center justify-center flex-shrink-0 text-white rounded-none shadow-xs"
        title="Google Discussions & Search"
      >
        {/* Official Google glyph */}
        <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
        </svg>
      </div>
      {showLabel && <span className="text-xs font-mono text-[#8a8a86]">Google</span>}
    </div>
  );
};
