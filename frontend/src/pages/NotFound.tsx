import { Link } from 'react-router-dom'
import './NotFound.css'

export default function NotFound() {
  return (
    <main className="notfound-page">
      <section className="notfound-card">
        <p className="notfound-code">404</p>
        <h1>Página não encontrada</h1>
        <p className="notfound-text">
          A rota que você tentou acessar não existe ou foi movida.
        </p>

        <div className="notfound-actions">
          <Link to="/dashboard" className="notfound-btn primary">
            Ir para o dashboard
          </Link>
          <Link to="/" className="notfound-btn secondary">
            Ir para login
          </Link>
        </div>
      </section>
    </main>
  )
}
