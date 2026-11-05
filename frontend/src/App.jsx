import React, { useEffect, useRef, useState } from 'react';
import {
  BrowserRouter as Router,
  Route,
  Routes,
  Navigate,
  useLocation,
} from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Login, { LoginLoadingCard } from './pages/Login';
import Channels from './pages/Channels';
import PublicWatch from './pages/PublicWatch';
import ContentSources from './pages/ContentSources';
import Guide from './pages/Guide';
import Stats from './pages/Stats';
import LogFilesPage from './pages/LogFiles';
import LogFileViewPage from './pages/LogFileView';
import DVR from './pages/DVR';
import Settings from './pages/Settings';
import PluginsPage from './pages/Plugins';
import PluginBrowsePage from './pages/PluginBrowse';
import ConnectPage from './pages/Connect';
import Users from './pages/Users';
import LogosPage from './pages/Logos';
import VODsPage from './pages/VODs';
import useAuthStore from './store/auth';
import useBrowserStorage from './hooks/useBrowserStorage';
import FloatingVideo from './components/FloatingVideo';
import { WebsocketProvider } from './WebSocket';
import { Box, AppShell, Burger, MantineProvider } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import '@mantine/core/styles.css'; // Ensure Mantine global styles load
import '@mantine/notifications/styles.css';
import '@mantine/dropzone/styles.css';
import '@mantine/dates/styles.css';
import './index.css';
import mantineTheme from './mantineTheme';
import API from './api';
import { Notifications } from '@mantine/notifications';
import M3URefreshNotification from './components/M3URefreshNotification';
import ErrorBoundary from './components/ErrorBoundary';
import { defaultRoute, getSafeNextPath } from './utils/loginRedirect';
import 'allotment/dist/style.css';
import './mobile.css';
import { USER_LEVELS } from './constants';

const drawerWidth = 240;
const miniDrawerWidth = 60;

const LoginRedirect = () => {
  const location = useLocation();
  const target = getSafeNextPath(location.pathname + location.search);
  const next = target ? `?next=${encodeURIComponent(target)}` : '';
  return <Navigate to={`/login${next}`} replace />;
};

const App = () => {
  const isMobile = useMediaQuery('(max-width: 900px)');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [open, setOpen] = useBrowserStorage('dispatcharr_sidebar_open', true);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const canManage = useAuthStore((s) => s.user?.user_level >= USER_LEVELS.ADMIN);
  const isInitialized = useAuthStore((s) => s.isInitialized);
  const authReady = isAuthenticated && isInitialized;
  const isCheckingAuth = useAuthStore((s) => s.isCheckingAuth);
  const logout = useAuthStore((s) => s.logout);
  const initData = useAuthStore((s) => s.initData);
  const initializeAuth = useAuthStore((s) => s.initializeAuth);
  const setSuperuserStatus = useAuthStore((s) => s.setSuperuserStatus);

  const authCheckStarted = useRef(false);
  const superuserCheckStarted = useRef(false);

  const toggleDrawer = () => {
    setOpen((prev) => !prev);
  };

  // Check if a superuser exists on first load.
  useEffect(() => {
    if (superuserCheckStarted.current) return;
    superuserCheckStarted.current = true;

    async function checkSuperuser() {
      try {
        const response = await API.fetchSuperUser();
        setSuperuserStatus(response);
      } catch (error) {
        console.error('Error checking superuser status:', error);
        // Preserve the existing fail-open UI behavior if the status check fails.
        setSuperuserStatus({ superuser_exists: true });
        // If authentication error, redirect to login
        if (error.status === 401) {
          localStorage.removeItem('accessToken');
          localStorage.removeItem('refreshToken');
          localStorage.removeItem('tokenExpiration');
          window.location.href = '/login';
        }
      }
    }
    checkSuperuser();
  }, [setSuperuserStatus]);

  // Authentication check
  useEffect(() => {
    if (authCheckStarted.current) return;
    authCheckStarted.current = true;

    const checkAuth = async () => {
      try {
        const loggedIn = await initializeAuth();
        if (loggedIn) {
          await initData();
          // Logos are now loaded at the end of initData, no need for background loading
        } else {
          await logout();
        }
      } catch (error) {
        console.error('Auth check failed:', error);
        await logout();
      }
    };

    checkAuth();
  }, [initializeAuth, initData, logout]);

  return (
    <MantineProvider
      defaultColorScheme="dark"
      theme={mantineTheme}
      withGlobalStyles
      withNormalizeCSS
    >
      <ErrorBoundary name="application">
        <WebsocketProvider>
          <Router>
            <AppShell
              className={isMobile ? 'mobile-appshell' : undefined}
              header={{
                height: isMobile && authReady ? 56 : 0,
              }}
              navbar={{
                width: authReady ? (open ? drawerWidth : miniDrawerWidth) : 0,
                breakpoint: 900,
                collapsed: { mobile: !mobileMenuOpen },
              }}
            >
              {isMobile && authReady && (
                <AppShell.Header className="mobile-topbar">
                  <Burger opened={mobileMenuOpen} onClick={() => setMobileMenuOpen((value) => !value)}
                    size="sm" aria-expanded={mobileMenuOpen} aria-label={mobileMenuOpen ? '关闭菜单' : '打开菜单'} />
                  <a href="/channels" className="mobile-brand">电视直播</a>
                  {canManage
                    ? <a href="/manage/channels" className="mobile-manage-link">管理频道</a>
                    : <span className="mobile-topbar-label">Dispatcharr</span>}
                </AppShell.Header>
              )}
              {isMobile && mobileMenuOpen && (
                <button type="button" className="mobile-nav-backdrop" aria-label="关闭导航菜单"
                  onClick={() => setMobileMenuOpen(false)} />
              )}
              {authReady && (
                <div onClick={(event) => {
                  if (isMobile && event.target.closest('a[href]')) setMobileMenuOpen(false);
                }}>
                <Sidebar
                  drawerWidth={drawerWidth}
                  miniDrawerWidth={miniDrawerWidth}
                  collapsed={isMobile ? false : !open}
                  toggleDrawer={isMobile ? () => setMobileMenuOpen(false) : toggleDrawer}
                />
                </div>
              )}

              <AppShell.Main>
                <Box
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    // transition: 'margin-left 0.3s',
                    backgroundColor: '#18181b',
                    height: isMobile && authReady ? 'calc(100dvh - 56px)' : '100vh',
                    color: 'white',
                  }}
                >
                  <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                    {isCheckingAuth ? (
                      <LoginLoadingCard />
                    ) : (
                      <Routes>
                        {authReady ? (
                          <>
                            <Route path="/channels" element={<Channels />} />
                            <Route path="/manage/channels" element={<Channels management />} />
                            <Route
                              path="/sources"
                              element={<ContentSources />}
                            />
                            <Route path="/guide" element={<Guide />} />
                            <Route path="/dvr" element={<DVR />} />
                            <Route path="/stats" element={<Stats />} />
                            <Route path="/logs" element={<LogFilesPage />} />
                            <Route
                              path="/logs/:name"
                              element={<LogFileViewPage />}
                            />
                            <Route
                              path="/plugins/browse"
                              element={<PluginBrowsePage />}
                            />
                            <Route path="/plugins" element={<PluginsPage />} />
                            <Route path="/connect" element={<ConnectPage />} />
                            <Route path="/users" element={<Users />} />
                            <Route path="/settings" element={<Settings />} />
                            <Route path="/logos" element={<LogosPage />} />
                            <Route path="/vods" element={<VODsPage />} />
                          </>
                        ) : (
                          <>
                            <Route path="/" element={<Navigate to="/channels" replace />} />
                            <Route path="/channels" element={<PublicWatch />} />
                            <Route path="/login" element={<Login />} />
                          </>
                        )}
                        <Route
                          path="*"
                          element={
                            authReady ? (
                              <Navigate to={defaultRoute} replace />
                            ) : (
                              <LoginRedirect />
                            )
                          }
                        />
                      </Routes>
                    )}
                  </Box>
                </Box>
              </AppShell.Main>
            </AppShell>
            <M3URefreshNotification />
            <Notifications containerWidth={350} />
          </Router>
        </WebsocketProvider>

        <FloatingVideo />
      </ErrorBoundary>
    </MantineProvider>
  );
};

export default App;
