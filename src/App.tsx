import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { EchoProvider } from './context/EchoContext';
import { LandingPage } from './pages/LandingPage';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { ToastContainer } from './components/common/Toast';

type Route = '/' | '/auth' | '/dashboard';

const MainRouter: React.FC = () => {
  const { user, isLoading } = useAuth();
  const [currentRoute, setCurrentRoute] = useState<Route>(() => {
    const path = window.location.hash.replace('#', '') || window.location.pathname;
    if (path === '/auth') return '/auth';
    if (path === '/dashboard') return '/dashboard';
    return '/';
  });

  // Sync hash routing
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#', '');
      if (hash === '/auth') setCurrentRoute('/auth');
      else if (hash === '/dashboard') setCurrentRoute('/dashboard');
      else setCurrentRoute('/');
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const navigate = (route: Route) => {
    window.location.hash = route;
    setCurrentRoute(route);
  };

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
  return (
    <AuthProvider>
      <EchoProvider>
        <MainRouter />
        <ToastContainer />
      </EchoProvider>
    </AuthProvider>
  );
}
