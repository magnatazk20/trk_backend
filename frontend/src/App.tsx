import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import Roleta from './pages/Roleta'
import Sinuca from './pages/Sinuca'
import CashIn from './pages/CashIn'
import CashInCheckout from './pages/CashInCheckout'
import Tasks from './pages/Tasks'
import MiningTask from './pages/MiningTask'
import Vip from './pages/Vip'
import Invite from './pages/Invite'
import Profile from './pages/Profile'
import InvestmentOrders from './pages/InvestmentOrders'
import BankCards from './pages/BankCards'
import TeamReport from './pages/TeamReport'
import Checkin from './pages/Checkin'
import NotFound from './pages/NotFound'
import Community from './pages/Community'
import Earnings from './pages/Earnings'
import TaxDeclaration from './pages/TaxDeclaration'
import WithdrawPassword from './pages/WithdrawPassword'
import Withdraw from './pages/Withdraw'
import Admin from './pages/Admin'
import AdminUsers from './pages/AdminUsers'
import AdminUserDetails from './pages/AdminUserDetails'
import AdminUserHistory from './pages/AdminUserHistory'
import AdminWithdrawConfig from './pages/AdminWithdrawConfig'
import AdminRankings from './pages/AdminRankings'
import AdminSiteSettings from './pages/AdminSiteSettings'
import RequireAuth from './components/RequireAuth'
import RequireMaxAdmin from './components/RequireMaxAdmin'
import './App.css'

function AnimatedBackground() {
  return (
    <div className="bg-animation" aria-hidden="true">
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />
      <div className="orb orb-4" />
      <div className="orb orb-5" />
      <div className="grid-overlay" />
      <div className="particles">
        {Array.from({ length: 20 }).map((_, i) => (
          <span key={i} className="particle" style={{ '--i': i } as React.CSSProperties} />
        ))}
      </div>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AnimatedBackground />
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/cadastro" element={<Register />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/roleta" element={<Roleta />} />
        <Route path="/sinuca" element={<Sinuca />} />
        <Route path="/cashin" element={<CashIn />} />
        <Route path="/cashin/checkout" element={<CashInCheckout />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/tasks/mining/:taskId" element={<MiningTask />} />
        <Route path="/vip" element={<Vip />} />
        <Route path="/invite" element={<Invite />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/investment-orders" element={<InvestmentOrders />} />
        <Route path="/bank-cards" element={<BankCards />} />
        <Route path="/team-report" element={<TeamReport />} />
        <Route path="/checkin" element={<Checkin />} />
        <Route path="/community" element={<Community />} />
        <Route path="/earnings" element={<Earnings />} />
        <Route path="/tax-declaration" element={<TaxDeclaration />} />
        <Route path="/withdraw-password" element={<WithdrawPassword />} />
        <Route
          path="/saque"
          element={(
            <RequireAuth>
              <Withdraw />
            </RequireAuth>
          )}
        />
        <Route
          path="/adf"
          element={(
            <RequireMaxAdmin>
              <Admin />
            </RequireMaxAdmin>
          )}
        />
        <Route
          path="/adf/users"
          element={(
            <RequireMaxAdmin>
              <AdminUsers />
            </RequireMaxAdmin>
          )}
        />
        <Route
          path="/adf/users/:id"
          element={(
            <RequireMaxAdmin>
              <AdminUserDetails />
            </RequireMaxAdmin>
          )}
        />
        <Route
          path="/adf/users/:id/history"
          element={(
            <RequireMaxAdmin>
              <AdminUserHistory />
            </RequireMaxAdmin>
          )}
        />
        <Route
          path="/adf/withdraw-config"
          element={(
            <RequireMaxAdmin>
              <AdminWithdrawConfig />
            </RequireMaxAdmin>
          )}
        />
        <Route
          path="/adf/rankings"
          element={(
            <RequireMaxAdmin>
              <AdminRankings />
            </RequireMaxAdmin>
          )}
        />
        <Route
          path="/adf/site-settings"
          element={(
            <RequireMaxAdmin>
              <AdminSiteSettings />
            </RequireMaxAdmin>
          )}
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}
