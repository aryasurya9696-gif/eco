import React, { useState } from 'react';
import { BrandLogo } from '../components/common/BrandLogo';
import { useAuth } from '../context/AuthContext';
import { ArrowLeft, ArrowRight, ShieldCheck, Zap } from 'lucide-react';

interface AuthPageProps {
  onNavigateHome: () => void;
  onNavigateDashboard: () => void;
}

export const AuthPage: React.FC<AuthPageProps> = ({
  onNavigateHome,
  onNavigateDashboard,
}) => {
  const { signIn, signUp, isMock } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Please provide both email and password.');
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      if (mode === 'signup') {
        const res = await signUp(email, password);
        if (res.error) {
          setError(res.error);
        } else {
          onNavigateDashboard();
        }
      } else {
        const res = await signIn(email, password);
        if (res.error) {
          setError(res.error);
        } else {
          onNavigateDashboard();
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Authentication failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleQuickDemo = async () => {
    setEmail('founder@echo-demo.com');
    setPassword('demopass123');
    setIsSubmitting(true);
    await signIn('founder@echo-demo.com', 'demopass123');
    setIsSubmitting(false);
    onNavigateDashboard();
  };

  return (
    <div className="min-h-screen bg-[#f6f6f4] flex flex-col justify-between font-sans">
      {/* Top Bar */}
      <div className="max-w-6xl mx-auto w-full px-6 py-6 flex items-center justify-between">
        <button
          onClick={onNavigateHome}
          className="flex items-center gap-2 text-xs font-mono text-[#8a8a86] hover:text-[#141414] transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to overview</span>
        </button>

        <BrandLogo size="sm" />
      </div>

      {/* Main Card */}
      <div className="w-full max-w-md mx-auto px-6 py-12">
        <div className="bg-[#ffffff] border border-[#e3e3de] p-8 sm:p-10 shadow-xl rounded-none">
          {/* Header */}
          <div className="mb-6 space-y-1">
            <h1 className="text-2xl font-bold tracking-tight text-[#141414]">
              {mode === 'signup' ? 'Create your account' : 'Sign in to Echo'}
            </h1>
            <p className="text-xs text-[#8a8a86] font-mono">
              {mode === 'signup'
                ? 'Instant setup. No email verification required.'
                : 'Access your daily X and LinkedIn lead feed.'}
            </p>
          </div>

          {/* Mode Switcher Tabs */}
          <div className="flex border border-[#e3e3de] bg-[#f6f6f4] p-0.5 mb-6 text-xs font-mono">
            <button
              type="button"
              onClick={() => {
                setMode('signup');
                setError(null);
              }}
              className={`flex-1 py-2 transition-colors cursor-pointer ${
                mode === 'signup'
                  ? 'bg-[#141414] text-white font-medium shadow-xs'
                  : 'text-[#4a4a47] hover:text-[#141414]'
              }`}
            >
              Sign Up
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('signin');
                setError(null);
              }}
              className={`flex-1 py-2 transition-colors cursor-pointer ${
                mode === 'signin'
                  ? 'bg-[#141414] text-white font-medium shadow-xs'
                  : 'text-[#4a4a47] hover:text-[#141414]'
              }`}
            >
              Sign In
            </button>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="mb-5 p-3 bg-red-50 border border-red-200 text-xs font-mono text-red-700 animate-in fade-in duration-150">
              {error}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-mono uppercase tracking-wider text-[#4a4a47] block">
                Email Address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                className="w-full px-3.5 py-2.5 bg-white border border-[#e3e3de] rounded-none text-sm text-[#141414] placeholder:text-[#9b9b96] focus:outline-none focus:border-[#141414] transition-colors"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-mono uppercase tracking-wider text-[#4a4a47] block">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full px-3.5 py-2.5 bg-white border border-[#e3e3de] rounded-none text-sm text-[#141414] placeholder:text-[#9b9b96] focus:outline-none focus:border-[#141414] transition-colors"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full mt-2 inline-flex items-center justify-center gap-2 px-5 py-3 bg-[#121212] hover:bg-black text-white text-xs font-medium rounded-none transition-colors cursor-pointer disabled:opacity-50 shadow-xs"
            >
              <span>{isSubmitting ? 'Authenticating...' : mode === 'signup' ? 'Create Account & Continue' : 'Sign In'}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </form>

          {/* Quick Demo Test Access */}
          <div className="mt-6 pt-5 border-t border-[#eeeeea]">
            <button
              type="button"
              onClick={handleQuickDemo}
              className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 bg-[#f6f6f4] hover:bg-[#ecece7] border border-[#e3e3de] text-xs font-mono text-[#4a4a47] rounded-none transition-colors cursor-pointer"
            >
              <Zap className="w-3 h-3 text-[#141414]" />
              <span>Instant Test Account Access</span>
            </button>
          </div>

          {/* Backend Info Notice */}
          <div className="mt-4 flex items-center justify-center gap-1.5 text-[10px] font-mono text-[#8a8a86]">
            <ShieldCheck className="w-3 h-3 text-emerald-600" />
            <span>
              {isMock
                ? 'Local sandbox mode active (auto-sync)'
                : 'Connected to Supabase Auth & RLS'}
            </span>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="py-6 text-center text-xs font-mono text-[#8a8a86]">
        Echo • Automated Social Lead Sweep
      </div>
    </div>
  );
};
