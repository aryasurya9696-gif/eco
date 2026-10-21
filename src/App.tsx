import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { EchoProvider } from './context/EchoContext';
import { LandingPage } from './pages/LandingPage';
import { AuthPage, SetNewPasswordPage } from './pages/AuthPage';
import { arrivedFromAuthCallback, configError } from './lib/supabase';
import { DashboardPage } from './pages/DashboardPage';
import { ToastContainer } from './components/common/Toast';
import { ErrorBoundary } from './components/common/ErrorBoundary';

type Route = '/' | '/auth' | '/dashboard';

const MainRouter: React.FC = () => {
  const { user, isLoading, passwordRecovery } = useAuth();
  const [currentRoute, setCurrentRoute] = useState<Route>(() => {
    // Returning from an email link (confirmation or reset): the session is
    // being established from the URL, so this is a dashboard arrival.
    if (arrivedFromAuthCallback) return '/dashboard';
    const rawHash = window.location.hash.replace(/^#\/?/, '');
    if (rawHash.startsWith('auth')) return '/auth';
    if (rawHash.startsWith('dashboard') || rawHash.includes('access_token')) return '/dashboard';
    if (window.location.pathname === '/auth') return '/auth';
    if (window.location.pathname === '/dashboard') return '/dashboard';
    return '/';
  });

  const navigate = (route: Route) => {
    window.location.hash = route;
    setCurrentRoute(route);
  };

  // Sync hash routing
  useEffect(() => {
    const handleHashChange = () => {
      const rawHash = window.location.hash.replace(/^#\/?/, '');
      if (rawHash.startsWith('auth')) {
        setCurrentRoute('/auth');
      } else if (rawHash.startsWith('dashboard') || rawHash.includes('access_token')) {
        setCurrentRoute('/dashboard');
      } else {
        setCurrentRoute('/');
      }
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // When user is authenticated and on auth or token callback, smoothly transition to dashboard
  useEffect(() => {
    if (user && (currentRoute === '/auth' || window.location.hash.includes('access_token'))) {
      navigate('/dashboard');
    }
  }, [user, currentRoute]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#f6f6f4] flex items-center justify-center font-mono text-xs text-[#8a8a86]">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-[#141414] animate-ping" />
          <span>INITIALIZING ECHO...</span>
        </div>
      </div>
    );
  }

  // Arrived from a password-reset link: set the new password before anything
  // else, then continue to the dashboard.
  if (passwordRecovery && user) {
    return <SetNewPasswordPage onDone={() => navigate('/dashboard')} />;
  }

  // Route protection
  // /dashboard requires session -> redirect to /auth if no user
  if (currentRoute === '/dashboard' && !user) {
    return (
      <AuthPage
        onNavigateHome={() => navigate('/')}
        onNavigateDashboard={() => navigate('/dashboard')}
      />
    );
  }

  // /auth redirects to /dashboard if logged in
  if (currentRoute === '/auth' && user) {
    return (
      <DashboardPage
        onNavigateHome={() => navigate('/')}
        onNavigateAuth={() => navigate('/auth')}
      />
    );
  }

  if (currentRoute === '/auth') {
    return (
      <AuthPage
        onNavigateHome={() => navigate('/')}
        onNavigateDashboard={() => navigate('/dashboard')}
      />
    );
  }

  if (currentRoute === '/dashboard') {
    return (
      <DashboardPage
        onNavigateHome={() => navigate('/')}
        onNavigateAuth={() => navigate('/auth')}
      />
    );
  }

  return (
    <LandingPage
      onNavigateAuth={() => navigate('/auth')}
      onNavigateDashboard={() => navigate('/dashboard')}
      isLoggedIn={Boolean(user)}
    />
  );
};

export default function App() {
  if (configError) {
    return (
      <div className="min-h-screen bg-[#f6f6f4] flex items-center justify-center p-6 font-mono text-xs text-[#8a2a2a]">
        <div role="alert" className="max-w-md border border-[#f0c4c4] bg-[#fdf2f2] p-5 space-y-2">
          <p className="font-semibold">Configuration error</p>
          <p>{configError}</p>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <AuthProvider>
        <EchoProvider>
          <ErrorBoundary>
            <MainRouter />
          </ErrorBoundary>
          <ToastContainer />
        </EchoProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
