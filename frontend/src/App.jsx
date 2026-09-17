import { useState, useEffect } from 'react';
import { api } from './api.js';
import { C, FONT } from './constants.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import LoginGate from './components/LoginGate.jsx';
import Topbar from './components/Topbar.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatsPage from './components/ChatsPage.jsx';
import HomePage from './pages/HomePage.jsx';
import ChatbotBuilderPage from './pages/ChatbotBuilderPage.jsx';
import AiAgentBuilderPage from './pages/AiAgentBuilderPage.jsx';
import TemplateBuilderPage from './pages/TemplateBuilderPage.jsx';
import ContactsPage from './pages/ContactsPage.jsx';
import BulkMessagePage from './pages/BulkMessagePage.jsx';
import TargetMessagePage from './pages/TargetMessagePage.jsx';
import AdminSettingsPage from './pages/AdminSettingsPage.jsx';
import MediaLibraryPage from './pages/MediaLibraryPage.jsx';
import PipelinesPage from './pages/PipelinesPage.jsx';
import RetargetPage from './pages/RetargetPage.jsx';
import LeadIntelligencePage from './components/LeadIntelligencePage.jsx';
import { IG } from './constants.js';
import InstagramSidebar from './components/instagram/InstagramSidebar.jsx';
import EmailSidebar from './components/email/EmailSidebar.jsx';
import EmailDashboardPage from './pages/email/EmailDashboardPage.jsx';
import EmailContactsPage from './pages/email/EmailContactsPage.jsx';
import EmailTemplatesPage from './pages/email/EmailTemplatesPage.jsx';
import EmailCampaignsPage from './pages/email/EmailCampaignsPage.jsx';
import EmailInboxPage from './pages/email/EmailInboxPage.jsx';
import ModuleSwitch from './components/instagram/ModuleSwitch.jsx';
import InstagramInboxPage from './pages/instagram/InstagramInboxPage.jsx';
import InstagramContactsPage from './pages/instagram/InstagramContactsPage.jsx';
import InstagramTemplatesPage from './pages/instagram/InstagramTemplatesPage.jsx';
import InstagramCampaignsPage from './pages/instagram/InstagramCampaignsPage.jsx';
import InstagramWorkflowPage from './pages/instagram/InstagramWorkflowPage.jsx';
import InstagramAnalyticsPage from './pages/instagram/InstagramAnalyticsPage.jsx';
import InstagramSettingsPage from './pages/instagram/InstagramSettingsPage.jsx';
import InstagramAccountsPage from './pages/instagram/InstagramAccountsPage.jsx';

// Simple placeholder for Email sub-pages not built yet
function EmailComingSoon({ title }) {
  return (
    <div style={{ padding: 40, fontFamily: FONT, color: C.text }}>
      <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 13, color: C.textMuted }}>This section is coming soon.</div>
    </div>
  );
}

const VALID_PAGES = new Set([
  'home', 'chatbot-builder', 'ai-agent-builder', 'template-builder', 'chats',
  'contacts', 'pipelines', 'retarget', 'lead-intelligence', 'bulk-message', 'target-message', 'admin-settings',      'media-library',
  'ig-inbox', 'ig-contacts', 'ig-templates', 'ig-campaigns', 'ig-workflow', 'ig-analytics', 'ig-settings', 'ig-accounts',
  'email-dashboard', 'email-campaigns', 'email-inbox', 'email-contacts', 'email-templates', 'email-settings',
]);

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [routeParts, navigate, replaceRoute] = useHashRoute();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeModule, setActiveModule] = useState('whatsapp'); // 'whatsapp' | 'instagram' | 'email'

  const page = VALID_PAGES.has(routeParts[0]) ? routeParts[0] : 'home';
  const subParts = routeParts.slice(1);
  const setPage = (p) => navigate(p);

  // Normalize empty hash to #/home so reload always shows a valid URL
  useEffect(() => {
    if (!routeParts[0]) replaceRoute('home');
  }, [routeParts, replaceRoute]);

  // Page guard: non-admins can only reach pages granted to them (user.pages).
  useEffect(() => {
    if (!user || user.role === 'admin' || !Array.isArray(user.pages)) return;
    const allowed = page === 'admin-settings'
      ? user.pages.some(p => p.startsWith('admin-settings'))
      : user.pages.includes(page);
    if (!allowed) setPage('home');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, user]);

  // Keep activeModule in sync with the current page's prefix
  useEffect(() => {
    if (page.startsWith('ig-')) setActiveModule('instagram');
    else if (page.startsWith('email-')) setActiveModule('email');
    else setActiveModule('whatsapp');
  }, [page]);

  useEffect(() => {
    if (page === 'chatbot-builder') {
      setSidebarCollapsed(true);
    }
  }, [page]);

  useEffect(() => {
    api.auth.me()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  const handleLogout = async () => {
    await api.auth.logout().catch(() => {});
    setUser(null);
    setPage('home');
  };

  if (checking) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        fontFamily: FONT,
        background: activeModule === 'instagram' ? IG.cardBg : C.pageBg,
      }}>
        <div style={{ fontSize: 13, color: C.textMuted, fontWeight: 500 }}>Loadingâ€¦</div>
      </div>
    );
  }

  if (!user) {
    return <LoginGate onLogin={setUser} />;
  }

  const renderPage = () => {
    switch (page) {
      case 'home': return <HomePage user={user} onPageChange={setPage} />;
      case 'chats': return <ChatsPage subParts={subParts} navigate={navigate} user={user} />;
      case 'contacts': return <ContactsPage user={user} />;
      case 'pipelines': return <PipelinesPage user={user} />;
      case 'retarget': return <RetargetPage user={user} />;
      case 'lead-intelligence': return <LeadIntelligencePage user={user} />;
      case 'template-builder': return <TemplateBuilderPage />;
      case 'media-library': return <MediaLibraryPage />;
      case 'bulk-message': return <BulkMessagePage />;
      case 'target-message': return <TargetMessagePage />;
      case 'chatbot-builder': return <ChatbotBuilderPage subParts={subParts} navigate={navigate} />;
      case 'ai-agent-builder': return <AiAgentBuilderPage user={user} />;

      case 'admin-settings': return <AdminSettingsPage onLogout={handleLogout} onNavigate={setPage} subParts={subParts} navigate={navigate} user={user} />;

      case 'ig-inbox': return <InstagramInboxPage user={user} />;
      case 'ig-contacts': return <InstagramContactsPage user={user} />;
      case 'ig-templates': return <InstagramTemplatesPage />;
      case 'ig-campaigns': return <InstagramCampaignsPage />;
      case 'ig-workflow': return <InstagramWorkflowPage subParts={subParts} navigate={navigate} />;
      case 'ig-analytics': return <InstagramAnalyticsPage />;
      case 'ig-settings': return <InstagramSettingsPage />;
      case 'ig-accounts': return <InstagramAccountsPage />;

      case 'email-dashboard': return <EmailDashboardPage />;
      case 'email-campaigns': return <EmailCampaignsPage />;
      case 'email-inbox': return <EmailInboxPage />;
      case 'email-contacts': return <EmailContactsPage />;
      case 'email-templates': return <EmailTemplatesPage />;
      case 'email-settings': return <EmailComingSoon title="Email Settings" />;

      default: return <HomePage user={user} onPageChange={setPage} />;
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      fontFamily: FONT,
      background: C.pageBg,
    }}>
      <Topbar user={user} onLogout={handleLogout} onNavigate={setPage} activeModule={activeModule} onModuleChange={setActiveModule} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {page !== 'admin-settings' && activeModule === 'whatsapp' && (
          <Sidebar
            activePage={page}
            onPageChange={setPage}
            collapsed={sidebarCollapsed}
            setCollapsed={setSidebarCollapsed}
            user={user}
          />
        )}
        {page !== 'admin-settings' && activeModule === 'instagram' && (
          <InstagramSidebar
            activePage={page}
            onPageChange={setPage}
            collapsed={sidebarCollapsed}
            setCollapsed={setSidebarCollapsed}
            user={user}
          />
        )}
        {page !== 'admin-settings' && activeModule === 'email' && (
          <EmailSidebar activePage={page} onPageChange={setPage} />
        )}
        <div style={{ flex: 1, overflow: 'auto', background: activeModule === 'instagram' ? IG.cardBg : C.pageBg, display: 'flex', flexDirection: 'column' }}>
          {renderPage()}
        </div>
      </div>
    </div>
  );
}





