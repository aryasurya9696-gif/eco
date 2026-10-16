import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Shown instead of the default panel. */
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time errors so a single broken component cannot white-screen
 * the whole app. Shows the message and a reset button instead.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="min-h-screen bg-[#f6f6f4] flex items-center justify-center p-6">
        <div className="max-w-lg w-full bg-white border border-[#e3e3de] p-8 space-y-4">
          <div className="flex items-center gap-2.5">
            <span className="w-2 h-2 bg-red-600 rounded-full" />
            <h1 className="text-sm font-bold text-[#141414] font-mono">
              SOMETHING BROKE
            </h1>
          </div>

          <p className="text-xs text-[#4a4a47] font-mono leading-relaxed">
            Echo hit an unexpected error and stopped rendering this view. Your
            keywords, settings and sweep history are safe in the database.
          </p>

          <pre className="text-[11px] font-mono text-[#8a8a86] bg-[#f6f6f4] border border-[#eeeeea] p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-32">
            {error.message}
          </pre>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={this.handleReset}
              className="px-4 py-2 bg-[#141414] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 border border-[#deded8] bg-white hover:bg-[#f6f6f4] text-[#141414] text-xs font-mono transition-colors cursor-pointer"
            >
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}